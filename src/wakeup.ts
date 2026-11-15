import { WebSocket } from 'ws';

import type { Logger } from './logger.js';

/** A notification as it is handed to the delivery methods. */
export interface Notification {
  message: string;
  seq: number;
  time: string;
  data: Record<string, unknown>;
}

/** The notifications of the server that are passed on as they are. */
const FORWARDED = new Set(['inbox-activity', 'shared-memory-update', 'inbox-reminder', 'burst']);

export interface Timings {
  /** Between attempts to open a socket that does not open. */
  retryMs: number;
  /** Before the first attempt after an open socket closed. */
  reopenMs: number;
  /** Before trying again after another client took the socket. */
  replacedMs: number;
  /** A socket on which the server has been silent this long is dead. */
  silenceMs: number;
  /** How long opening may take. */
  handshakeMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  retryMs: 60_000,
  reopenMs: 5_000,
  replacedMs: 600_000,
  silenceMs: 90_000,
  handshakeMs: 20_000,
};

type State =
  /** Nothing known yet: no response has named a socket. */
  | 'unknown'
  | 'connecting'
  | 'open'
  /** Closed; a timer will try again. */
  | 'waiting'
  /** Closed for lack of traffic; the next request reopens it. */
  | 'idle'
  /** The token was refused. Nothing more happens until a restart. */
  | 'refused'
  | 'stopped';

function validFrame(value: unknown): value is Notification {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Partial<Notification>;
  return (
    typeof f.message === 'string' &&
    typeof f.seq === 'number' &&
    Number.isFinite(f.seq) &&
    typeof f.time === 'string' &&
    typeof f.data === 'object' &&
    f.data !== null
  );
}

/**
 * The client side of the intercom's wake-up socket.
 *
 * It learns the socket's URL and the agent's token from the traffic the
 * proxy forwards, opens the socket, says hello, and hands every notification
 * to `deliver`. It keeps the highest sequence number it has seen, so that
 * after a reconnect it can tell from the server's hello whether something was
 * missed, and then says so with a notification of its own.
 */
export class WakeupClient {
  private state: State = 'unknown';
  private url: string | undefined;
  private authorization: string | undefined;
  private ws: WebSocket | undefined;
  private timer: NodeJS.Timeout | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private lastHeard = 0;
  /** Highest sequence number seen; undefined until a server said hello. */
  private highest: number | undefined;
  private inFlight = 0;
  private warnedOtherToken = false;
  private readonly timings: Timings;

  constructor(
    private readonly opts: {
      deliver(notification: Notification): void;
      logger: Logger;
      /** Close the socket after this long without forwarded requests. */
      idleTimeoutMs?: number | undefined;
      timings?: Partial<Timings>;
      /** Capabilities named in the hello. None are defined yet. */
      capabilities?: string[];
    },
  ) {
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
  }

  /** What the client is doing, for the log and for tests. */
  status(): { state: State; url: string | undefined; highest: number | undefined } {
    return { state: this.state, url: this.url, highest: this.highest };
  }

  /** A successful response named the socket. */
  announce(url: string, authorization: string): void {
    if (this.state === 'stopped' || this.state === 'refused') return;
    if (this.authorization === undefined) {
      this.authorization = authorization;
    } else if (authorization !== this.authorization && !this.warnedOtherToken) {
      // One helper serves one agent; after a new token it has to be restarted.
      this.warnedOtherToken = true;
      this.opts.logger.warn(
        'a request carried a different token than the one the wake-up socket uses; restart the helper after a token change, and run one helper per agent',
      );
    }
    if (this.url === undefined) {
      this.url = url;
      this.connect();
      return;
    }
    if (url !== this.url) {
      this.opts.logger.info('the intercom named a different wake-up socket', { url });
      this.url = url;
      this.clearTimer();
      this.discard();
      this.connect();
      return;
    }
    if (this.state === 'idle') this.connect();
  }

  /** A request is being forwarded (`true`) or has ended (`false`). */
  activity(started: boolean): void {
    this.inFlight = Math.max(0, this.inFlight + (started ? 1 : -1));
    this.armIdle();
  }

  stop(): void {
    this.state = 'stopped';
    this.clearTimer();
    clearTimeout(this.idleTimer);
    this.discard();
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Drop the current socket without reacting to its close. */
  private discard(): void {
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    ws.removeAllListeners();
    ws.on('error', () => undefined);
    try {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000);
      else ws.terminate();
    } catch {
      // already gone
    }
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const timeout = this.opts.idleTimeoutMs;
    if (timeout === undefined || this.inFlight > 0) return;
    if (this.state === 'stopped' || this.state === 'refused') return;
    this.idleTimer = setTimeout(() => {
      if (this.inFlight > 0) return;
      if (this.state !== 'open' && this.state !== 'connecting' && this.state !== 'waiting') return;
      this.opts.logger.info('closing the wake-up socket: no requests for a while');
      this.clearTimer();
      this.discard();
      this.state = 'idle';
    }, timeout);
    this.idleTimer.unref();
  }

  private later(ms: number): void {
    this.state = 'waiting';
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, ms);
    this.timer.unref();
  }

  private connect(): void {
    if (!this.url || !this.authorization) return;
    if (this.state === 'stopped' || this.state === 'refused') return;
    const { logger } = this.opts;
    this.discard();
    this.state = 'connecting';
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, {
        headers: { Authorization: this.authorization },
        handshakeTimeout: this.timings.handshakeMs,
        maxPayload: 1024 * 1024,
      });
    } catch (err) {
      logger.warn('could not open the wake-up socket', { err, url: this.url });
      this.later(this.timings.retryMs);
      return;
    }
    this.ws = ws;
    let opened = false;
    let reason: string | undefined;
    let refused = false;

    ws.on('open', () => {
      opened = true;
      this.state = 'open';
      this.lastHeard = Date.now();
      logger.info('wake-up socket open', { url: this.url });
      ws.send(
        JSON.stringify({ message: 'hello', data: { capabilities: this.opts.capabilities ?? [] } }),
      );
      // The server pings regularly; silence means the connection is dead.
      this.watchdog = setInterval(
        () => {
          if (Date.now() - this.lastHeard > this.timings.silenceMs) {
            logger.warn('the wake-up socket went silent; reconnecting');
            ws.terminate();
          }
        },
        Math.max(50, Math.floor(this.timings.silenceMs / 6)),
      );
      this.watchdog.unref();
      this.armIdle();
    });
    ws.on('ping', () => {
      this.lastHeard = Date.now();
    });
    ws.on('message', (data, isBinary) => {
      this.lastHeard = Date.now();
      if (isBinary) return;
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!validFrame(frame)) return;
      if (frame.message === 'connection-closed') {
        if (typeof frame.data.reason === 'string') reason = frame.data.reason;
        return;
      }
      this.receive(frame);
    });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      if (response.statusCode === 401) refused = true;
      logger.debug('the wake-up socket was not accepted', { status: response.statusCode });
      ws.terminate();
    });
    ws.on('error', (err) => {
      if (!refused) logger.debug('wake-up socket error', { err });
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      clearInterval(this.watchdog);
      this.watchdog = undefined;
      if (this.state === 'stopped') return;
      const why =
        reason ?? (code === 4001 ? 'replaced' : code === 4002 ? 'token-revoked' : undefined);
      if (refused || why === 'token-revoked') {
        this.state = 'refused';
        clearTimeout(this.idleTimer);
        logger.warn(
          refused
            ? 'the intercom refused the token for the wake-up socket; notifications are off until the helper is restarted'
            : 'the token was revoked; notifications are off until the helper is restarted',
        );
        return;
      }
      if (why === 'replaced') {
        logger.warn(
          'another client took the wake-up socket of this agent; one agent must have one helper. Trying again later',
          { seconds: Math.round(this.timings.replacedMs / 1000) },
        );
        this.later(this.timings.replacedMs);
        return;
      }
      if (opened) {
        logger.info('wake-up socket closed; reconnecting', { code, reason: why });
        this.later(this.timings.reopenMs);
      } else {
        logger.warn('could not open the wake-up socket; trying again later', {
          seconds: Math.round(this.timings.retryMs / 1000),
        });
        this.later(this.timings.retryMs);
      }
    });
  }

  private receive(frame: Notification): void {
    if (frame.message === 'hello') {
      const before = this.highest;
      this.highest = Math.max(before ?? 0, frame.seq);
      // Something happened while no socket was open: after a reconnect the
      // number tells, and on the first connection the server says so.
      const missed = before === undefined ? frame.data.pending === true : frame.seq > before;
      if (missed) {
        this.opts.deliver({ message: 'missed', seq: frame.seq, time: frame.time, data: {} });
      }
      return;
    }
    if (!FORWARDED.has(frame.message)) {
      this.opts.logger.debug('ignoring an unknown frame', { message: frame.message });
      return;
    }
    if (this.highest === undefined || frame.seq > this.highest) this.highest = frame.seq;
    this.opts.deliver(frame);
  }
}
