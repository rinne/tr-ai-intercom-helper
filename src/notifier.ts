import net from 'node:net';
import path from 'node:path';

import { checkOwnDirectory, defaultListenerPath, listenerDirectory } from './listener.js';

/**
 * The client of the helper's notification listener: connects to the socket
 * and prints each notification, one line of JSON, as it arrives. An agent
 * runs it in the background to be woken by its output.
 */

export interface NotifierOptions {
  /** The socket to connect to. */
  socketPath: string;
  /** 'monitor' prints everything until stopped; 'oneshot' prints one line and ends. */
  mode: 'monitor' | 'oneshot';
  /** Monitor only: connect again, after a pause, whenever there is no connection. */
  reconnect?: boolean;
  /** The pause before connecting again. */
  cooloffMs?: number;
  /**
   * Print a notification of the notifier's own, `local-idle-notification`, whenever nothing has
   * been printed for this long. Undefined: never.
   */
  idleIntervalMs?: number | undefined;
  /** Receives each complete line, newline included. */
  out(line: string): void;
  /** Receives remarks about the connection. */
  err(message: string): void;
  /** Ends the run; it then resolves with 0. */
  signal?: AbortSignal;
}

export const DEFAULT_COOLOFF_MS = 5000;

/** The socket a notifier is pointed at: an explicit path, or the default for a helper's port. */
export async function resolveSocketPath(where: {
  port?: number | undefined;
  path?: string | undefined;
}): Promise<string> {
  if (where.path) return path.resolve(where.path);
  if (where.port === undefined) throw new Error('Neither a port nor a socket path was given.');
  const target = defaultListenerPath(where.port);
  // Somebody else's directory under our name must not be listened to.
  const dir = listenerDirectory();
  if (dir) {
    await checkOwnDirectory(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
  return target;
}

/**
 * Run the notifier. Resolves with the exit status: 0 when it ended as asked
 * (one line printed in oneshot mode, or stopped), 1 when the connection could
 * not be made or was lost and reconnecting was not asked for.
 */
export function runNotifier(opts: NotifierOptions): Promise<number> {
  const cooloff = opts.cooloffMs ?? DEFAULT_COOLOFF_MS;
  const reconnect = opts.mode === 'monitor' && opts.reconnect === true;

  return new Promise<number>((resolve) => {
    let socket: net.Socket | undefined;
    let timer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let done = false;
    let complained = false;
    /** The highest sequence number printed so far. */
    let highest = 0;
    /** When the last notification from the helper was printed; the start until then. */
    let lastReal = Date.now();

    const finish = (status: number): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      socket?.destroy();
      resolve(status);
    };
    const onAbort = (): void => finish(0);
    if (opts.signal?.aborted) {
      resolve(0);
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    /** Print a line; in oneshot mode that ends the run. Returns false when it did. */
    const print = (line: string): boolean => {
      opts.out(line);
      if (opts.mode === 'oneshot') {
        finish(0);
        return false;
      }
      armIdle();
      return true;
    };
    /** Count the idle time from now: from the start, or from the line just printed. */
    const armIdle = (): void => {
      clearTimeout(idleTimer);
      const interval = opts.idleIntervalMs;
      if (interval === undefined || done) return;
      idleTimer = setTimeout(() => {
        if (done) return;
        // Made here, not by the intercom: the time is this machine's, and the
        // number is the latest one seen.
        const idle = {
          message: 'local-idle-notification',
          seq: highest,
          time: new Date().toISOString(),
          // Whole seconds since the last notification from the helper, or
          // since the notifier started when there has been none.
          data: { idle: Math.round((Date.now() - lastReal) / 1000) },
        };
        print(`${JSON.stringify(idle)}\n`);
      }, interval);
    };
    armIdle();

    const connect = (): void => {
      if (done) return;
      let pending = '';
      let connected = false;
      const current = net.createConnection(opts.socketPath);
      socket = current;
      current.setEncoding('utf8');

      current.on('connect', () => {
        connected = true;
        if (complained) opts.err(`Connected to ${opts.socketPath}.`);
        complained = false;
      });
      current.on('data', (chunk: string) => {
        pending += chunk;
        for (;;) {
          const at = pending.indexOf('\n');
          if (at < 0) break;
          const line = pending.slice(0, at + 1);
          pending = pending.slice(at + 1);
          if (done) return;
          try {
            const seq = (JSON.parse(line) as { seq?: unknown }).seq;
            if (typeof seq === 'number' && seq > highest) highest = seq;
          } catch {
            // Not ours to judge: the line is printed as it came.
          }
          lastReal = Date.now();
          if (!print(line)) return;
        }
      });
      current.on('error', () => undefined);
      current.on('close', () => {
        if (done || socket !== current) return;
        const what = connected
          ? `The connection to ${opts.socketPath} was closed: the helper stopped.`
          : `Could not connect to ${opts.socketPath}: no helper is listening there. Start tr-ai-intercom-helper with --notification-listener.`;
        if (!reconnect) {
          opts.err(what);
          finish(1);
          return;
        }
        // Say it once per outage, not at every attempt.
        if (!complained) {
          opts.err(`${what} Trying again every ${Math.round(cooloff / 1000)} s.`);
          complained = true;
        }
        timer = setTimeout(connect, cooloff);
      });
    };
    connect();
  });
}
