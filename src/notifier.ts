import { lstat, realpath } from 'node:fs/promises';
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

/** Longer than any notification or burst the intercom sends. */
const MAX_LINE_CHARS = 1024 * 1024;

/** A notification as far as the notifier checks it. Other members pass through. */
interface Checked {
  message: string;
  seq: number;
  [member: string]: unknown;
}

function isNotification(value: unknown): value is Checked {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { message, seq } = value as { message?: unknown; seq?: unknown };
  return (
    typeof message === 'string' && message !== '' && typeof seq === 'number' && Number.isFinite(seq)
  );
}

/**
 * The notifications in one line from the helper, or undefined when the line
 * is not what a helper sends. A line must be a JSON object with at least a
 * `message` and a numeric `seq`. A `burst` is unrolled into its members, in
 * order, each of which must be a notification itself and not another burst.
 */
export function parseLine(text: string): Checked[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isNotification(value)) return undefined;
  if (value.message !== 'burst') return [value];
  const members = (value.data as { burst?: unknown } | null | undefined)?.burst;
  if (!Array.isArray(members) || members.length === 0) return undefined;
  for (const member of members) {
    if (!isNotification(member) || member.message === 'burst') return undefined;
  }
  return members as Checked[];
}

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
 * Why a socket must not be connected to, or undefined when it may be.
 *
 * The notifier listens only to a socket of the user who runs it: what it
 * prints is acted on, so it must not come from somebody else. Looking at the
 * socket and then connecting to it would leave a moment in which the path
 * could be made to lead elsewhere. So the trust is taken from the directories
 * instead: nobody but the user (and root) may be able to change what the path
 * leads to. That holds when
 *
 * - the directory the socket is in belongs to the user or to root and cannot
 *   be written by anybody else, and
 * - every directory above it belongs to the user or to root and can be
 *   written by others only if it is sticky, as /tmp is, so that they cannot
 *   move or remove what is not theirs.
 *
 * Then the socket itself is checked: it must be a socket and the user's own.
 * A path with nothing at it is left for the connection attempt to report.
 */
export async function socketProblem(socketPath: string): Promise<string | undefined> {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const full = path.resolve(socketPath);
  // Symbolic links on the way are followed here, once, and what they lead to is checked.
  const parent = await realpath(path.dirname(full)).catch(() => undefined);
  if (!parent) return undefined;

  for (let dir = parent; ; dir = path.dirname(dir)) {
    const info = await lstat(dir).catch(() => undefined);
    if (!info) return undefined;
    const direct = dir === parent;
    if (info.uid !== uid && info.uid !== 0) {
      return `${dir} belongs to another user, so a socket in it cannot be trusted. Use a socket in a directory of your own.`;
    }
    const writable = (info.mode & 0o022) !== 0;
    const sticky = (info.mode & 0o1000) !== 0;
    if (writable && (direct || !sticky)) {
      return `${dir} can be written by other users, so a socket in it cannot be trusted. Use a socket in a directory of your own.`;
    }
    if (path.dirname(dir) === dir) break;
  }

  const info = await lstat(path.join(parent, path.basename(full))).catch(() => undefined);
  if (!info) return undefined;
  if (!info.isSocket()) return `${socketPath} is not a socket, so it is not connected to.`;
  if (info.uid !== uid) return `${socketPath} belongs to another user, so it is not connected to.`;
  return undefined;
}

/** The socket path with the symbolic links of its directory resolved. */
async function realSocketPath(socketPath: string): Promise<string> {
  const full = path.resolve(socketPath);
  const parent = await realpath(path.dirname(full)).catch(() => undefined);
  return parent ? path.join(parent, path.basename(full)) : full;
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

    /** There is no usable connection: end, or try again later. */
    const lost = (what: string): void => {
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
    };

    const connect = (): void => {
      if (done) return;
      // The path is resolved once, and the same resolved path is then both
      // checked and connected to, so that a symbolic link changed in between
      // cannot lead the connection elsewhere than the check looked.
      void realSocketPath(opts.socketPath).then(async (target) => {
        const problem = await socketProblem(target);
        if (done) return;
        if (problem) lost(problem);
        else open(target);
      });
    };

    const open = (target: string): void => {
      let pending = '';
      let connected = false;
      const current = net.createConnection(target);
      socket = current;
      current.setEncoding('utf8');

      current.on('connect', () => {
        connected = true;
        if (complained) opts.err(`Connected to ${opts.socketPath}.`);
        complained = false;
      });
      let invalid: string | undefined;
      /** What came is not what a helper sends: say so and drop the connection. */
      const reject = (why: string): void => {
        invalid = why;
        current.destroy();
      };
      current.on('data', (chunk: string) => {
        pending += chunk;
        if (pending.length > MAX_LINE_CHARS && !pending.includes('\n')) {
          reject('a line longer than a notification can be');
          return;
        }
        for (;;) {
          const at = pending.indexOf('\n');
          if (at < 0) break;
          const text = pending.slice(0, at);
          pending = pending.slice(at + 1);
          if (done) return;
          const notifications = parseLine(text);
          if (!notifications) {
            reject('a line that is not a notification');
            return;
          }
          lastReal = Date.now();
          // In oneshot mode several that came together are one event: the
          // latest of them is the one line.
          const chosen = opts.mode === 'oneshot' ? notifications.slice(-1) : notifications;
          for (const n of chosen) {
            if (n.seq > highest) highest = n.seq;
            if (!print(`${JSON.stringify(n)}\n`)) return;
          }
        }
      });
      current.on('error', () => undefined);
      current.on('close', () => {
        if (done || socket !== current) return;
        const what = invalid
          ? `${opts.socketPath} sent ${invalid}, so the connection was closed. Is it the socket of a tr-ai-intercom-helper?`
          : connected
            ? `The connection to ${opts.socketPath} was closed: the helper stopped.`
            : `Could not connect to ${opts.socketPath}: no helper is listening there. Start tr-ai-intercom-helper with --notification-listener.`;
        lost(what);
      });
    };
    connect();
  });
}
