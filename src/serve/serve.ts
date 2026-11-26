import WebSocket from 'ws';

import {
  BridgeError,
  checkAcceptUrl,
  dialLocal,
  runBridge,
  shownAddress,
  type LocalTarget,
} from '../stream/bridge.js';

/**
 * The serving side of a stream service.
 *
 * It holds the control socket of the service, on which the intercom
 * announces every client that connects. For each one it connects to the
 * local server first. When that worked it opens the URL the client was
 * announced with, and the two are joined; when it did not, it refuses the
 * client with a DELETE on that URL and the reason. So a client that is
 * connected has the server behind it.
 *
 * It runs until it is stopped, and reopens the control socket when it is
 * lost. The control URL is the only credential and is never printed or
 * logged; nor are the URLs of the announced connections.
 */

export interface ServeTimings {
  /** Wait before the control socket is opened again the first time, and every time after. */
  firstRetryMs: number;
  retryMs: number;
  /** Wait after another serving side took the service over. */
  replacedMs: number;
  /** How long the intercom may take to answer the hello. */
  helloMs: number;
}

const DEFAULT_TIMINGS: ServeTimings = {
  firstRetryMs: 5_000,
  retryMs: 60_000,
  replacedMs: 10 * 60_000,
  helloMs: 15_000,
};

export interface ServeOptions {
  /** The control URL of the stream service. */
  url: URL;
  /** Where the server is. */
  target: LocalTarget;
  /** A line for the person, never with a URL in it. */
  say(message: string): void;
  /** Leave out the lines about connections that came and went as they should. */
  quiet?: boolean;
  /** Aborting it closes everything and ends the program. */
  signal?: AbortSignal;
  timings?: Partial<ServeTimings>;
}

/** Why the intercom closed the control socket, in words. */
const CLOSED: Record<string, string> = {
  replaced: 'another serving side connected to this stream service',
  'no-hello': 'the intercom did not get our hello',
  'access-ended':
    'the stream service is closed for now: its agent is disabled or may no longer register stream services',
  'exchange-suspended': 'the exchange of the stream service is suspended',
  'service-ended': 'the stream service was removed',
  'url-renewed': 'the control URL of the stream service was renewed',
  'server-shutdown': 'the intercom stopped',
};
/** After these the URL is of no use any more. */
const FINAL = new Set(['service-ended', 'url-renewed']);

export const sizeText = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
};
const timeText = (ms: number): string =>
  ms < 1000
    ? `${ms} ms`
    : ms < 60_000
      ? `${Math.round(ms / 100) / 10} s`
      : `${Math.round(ms / 6000) / 10} min`;

interface ConnectionFrame {
  connection: string;
  url: string;
  client?: { address?: string | null } | undefined;
}

function connectionFrame(data: unknown): ConnectionFrame | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.connection !== 'string' || typeof d.url !== 'string') return null;
  return d as unknown as ConnectionFrame;
}

/**
 * Run until stopped. Resolves with the exit status: 130 when interrupted, 1
 * when the control URL is of no use (unknown, renewed, or its service
 * removed).
 */
export function runServe(opts: ServeOptions): Promise<number> {
  const { url, target, say } = opts;
  const timings = { ...DEFAULT_TIMINGS, ...opts.timings };
  const to = shownAddress(target);
  return new Promise((resolve) => {
    let done = false;
    let ws: WebSocket | null = null;
    let retry: NodeJS.Timeout | null = null;
    /** Whether the last attempt got as far as the hello. */
    let greeted = false;
    let failures = 0;
    /** Said once per stretch of the same trouble, not at every attempt. */
    let trouble = '';
    const stop = new AbortController();
    const running = new Set<Promise<unknown>>();

    const finish = (status: number): void => {
      if (done) return;
      done = true;
      if (retry) clearTimeout(retry);
      opts.signal?.removeEventListener('abort', onAbort);
      stop.abort();
      const socket = ws;
      ws = null;
      if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000);
      else socket?.terminate();
      void Promise.allSettled([...running]).then(() => resolve(status));
    };
    const onAbort = (): void => {
      say('interrupted');
      finish(130);
    };

    const again = (ms: number): void => {
      if (done) return;
      retry = setTimeout(connect, ms);
    };
    const problem = (text: string): void => {
      if (text === trouble) return;
      trouble = text;
      say(text);
    };

    /** One client: the server first, then the intercom. */
    const take = async (frame: ConnectionFrame): Promise<void> => {
      const who = `${frame.connection} from ${frame.client?.address ?? 'an unknown address'}`;
      let accept: URL;
      try {
        accept = checkAcceptUrl(frame.url);
      } catch (err) {
        say(`${who}: not taken, ${(err as Error).message}`);
        return;
      }
      let socket;
      try {
        socket = await dialLocal(target);
      } catch (err) {
        const why = `${(err as Error).message} (${to})`;
        const refuse = new URL(accept);
        refuse.protocol = refuse.protocol === 'wss:' ? 'https:' : 'http:';
        const told = await fetch(refuse, {
          method: 'DELETE',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: `the server could not be reached: ${(err as Error).message}`,
          signal: AbortSignal.timeout(10_000),
        }).then(
          (res) => res.status === 204,
          () => false,
        );
        say(`${who}: refused, ${why}${told ? '' : '; the intercom could not be told'}`);
        return;
      }
      if (done) {
        socket.destroy();
        return;
      }
      await runBridge({
        url: accept,
        port: { socket },
        say: () => undefined,
        signal: stop.signal,
        opened: () => {
          if (!opts.quiet) say(`${who}: connected to ${to}`);
        },
        report: (r) => {
          if (!r.opened) {
            say(`${who}: not taken, ${r.detail}`);
            return;
          }
          if (opts.quiet && r.status === 0) return;
          const how =
            r.status === 0
              ? /port ended/.test(r.detail)
                ? 'the server closed'
                : 'the client closed'
              : r.detail;
          say(
            `${who}: ended after ${timeText(r.ms)}, ${sizeText(r.sent)} to the client, ${sizeText(r.received)} from it (${how})`,
          );
        },
      });
    };

    function connect(): void {
      if (done) return;
      retry = null;
      greeted = false;
      let said = '';
      const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 });
      ws = socket;
      const hello = setTimeout(() => socket.terminate(), timings.helloMs);
      hello.unref();
      socket.on('open', () => {
        socket.send(JSON.stringify({ message: 'hello', data: { capabilities: [] } }));
      });
      socket.on('message', (raw, isBinary) => {
        if (isBinary) return;
        let frame: { message?: unknown; data?: unknown };
        try {
          frame = JSON.parse(String(raw)) as typeof frame;
        } catch {
          return;
        }
        if (frame.message === 'hello') {
          clearTimeout(hello);
          greeted = true;
          failures = 0;
          trouble = '';
          const service = (frame.data as { service?: unknown } | undefined)?.service;
          say(
            `serving${typeof service === 'string' ? ` ${service}` : ''}: every client of the stream service is connected to ${to}`,
          );
        } else if (frame.message === 'connection') {
          const announced = connectionFrame(frame.data);
          if (!announced) return;
          const one = take(announced).catch((err: unknown) =>
            say(`${announced.connection}: failed, ${(err as Error).message}`),
          );
          running.add(one);
          void one.finally(() => running.delete(one));
        } else if (frame.message === 'connection-closed') {
          const reason = (frame.data as { reason?: unknown } | undefined)?.reason;
          if (typeof reason === 'string') said = reason;
        }
      });
      socket.on('unexpected-response', (_request, response) => {
        clearTimeout(hello);
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        response.on('end', () => {
          if (done || ws !== socket) return;
          ws = null;
          const text = body.trim() || 'no reason given';
          if (response.statusCode === 404) {
            say(`the intercom does not know this control URL (404): ${text}`);
            finish(1);
            return;
          }
          problem(
            `the intercom refused the control URL (${response.statusCode}): ${text}; trying again every ${timeText(timings.retryMs)}`,
          );
          again(timings.retryMs);
        });
        response.on('error', () => undefined);
      });
      socket.on('error', (err: Error) => {
        if (greeted || done || ws !== socket) return;
        problem(`could not connect to the intercom: ${err.message}; trying again`);
      });
      socket.on('close', (code, reasonBytes) => {
        clearTimeout(hello);
        if (done || ws !== socket) return;
        ws = null;
        const reason = reasonBytes.toString('utf8') || said;
        if (FINAL.has(reason)) {
          say(`${CLOSED[reason]}; this control URL is of no use any more`);
          finish(1);
          return;
        }
        if (reason === 'replaced') {
          say(
            `${CLOSED.replaced}; not trying again for ${timeText(timings.replacedMs)}. Run one serving program per stream service`,
          );
          again(timings.replacedMs);
          return;
        }
        if (greeted) {
          say(
            `the control socket was closed (${CLOSED[reason] ?? (code === 1006 ? 'the connection to the intercom was lost' : reason || String(code))}); connections that run go on, and it is opened again`,
          );
        }
        failures += 1;
        again(failures === 1 ? timings.firstRetryMs : timings.retryMs);
      });
    }

    if (opts.signal?.aborted) {
      say('interrupted');
      return resolve(130);
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    connect();
  });
}

export { BridgeError };
