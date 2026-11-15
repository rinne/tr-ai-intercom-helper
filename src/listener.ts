import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import type { Logger } from './logger.js';
import type { Sink, StartInfo } from './sinks.js';

/**
 * The notification listener: a local (Unix domain) socket of the helper's
 * own, on which every program that connects is sent each notification as one
 * line of JSON. It is the opposite of the local-socket delivery method, where
 * the helper connects out to a socket somebody else listens on.
 *
 * Unless a path is given, the socket is
 * /tmp/tr-ai-intercom-helper.<uid>/<port>.sock, with <port> the local port
 * the helper listens on, so that a client finds it from the port alone.
 */

/** The longest socket path every supported system accepts. */
const MAX_PATH_BYTES = 103;

/** The user's own directory for listener sockets. Undefined where there are no user ids. */
export function listenerDirectory(): string | undefined {
  const uid = process.getuid?.();
  return uid === undefined ? undefined : `/tmp/tr-ai-intercom-helper.${uid}`;
}

/** The default socket path of the helper that listens on `port`. */
export function defaultListenerPath(port: number): string {
  const dir = listenerDirectory();
  if (!dir) {
    throw new Error(
      'This system has no default place for the notification listener. Give the socket path explicitly.',
    );
  }
  return path.join(dir, `${port}.sock`);
}

/**
 * Make sure a directory in /tmp is really the user's own. /tmp is shared, so
 * somebody else may have created a directory of that name first, to read or
 * to fake what goes through it.
 */
export async function checkOwnDirectory(dir: string): Promise<void> {
  const info = await lstat(dir);
  const problem = !info.isDirectory()
    ? 'is not a directory'
    : info.uid !== process.getuid?.()
      ? 'belongs to another user'
      : (info.mode & 0o077) !== 0
        ? 'is open to other users'
        : undefined;
  if (problem) {
    throw new Error(
      `${dir} ${problem}, so it cannot be trusted. Remove it, or use a socket path of your own instead.`,
    );
  }
}

function assertUsablePath(socketPath: string): void {
  if (Buffer.byteLength(socketPath) > MAX_PATH_BYTES) {
    throw new Error(
      `The socket path ${socketPath} is longer than ${MAX_PATH_BYTES} bytes, which a local socket cannot have.`,
    );
  }
}

/** True when something accepts connections on the socket. */
function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    const finish = (alive: boolean): void => {
      probe.destroy();
      resolve(alive);
    };
    probe.setTimeout(1000, () => finish(false));
    probe.on('connect', () => finish(true));
    probe.on('error', () => finish(false));
  });
}

/** A client that reads nothing gets this much buffered before it is dropped. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

export interface ListenerSink extends Sink {
  start(info: StartInfo): Promise<void>;
  stop(): void;
  /** Where the socket is, once started. */
  path(): string | undefined;
  clientCount(): number;
}

/**
 * The delivery method behind --notification-listener. Each connected client
 * gets every notification as one line of compact JSON. While nobody is
 * connected the latest notification is kept and handed to the next client
 * that connects, so that a program which reads one notification, acts, and
 * connects again does not lose what came in between.
 */
export function listenerSink(logger: Logger, configuredPath?: string): ListenerSink {
  const clients = new Set<net.Socket>();
  let server: net.Server | undefined;
  let socketPath: string | undefined;
  /** The latest notification that no client received. */
  let kept: string | undefined;

  const send = (client: net.Socket, line: string): void => {
    if (client.writableLength > MAX_BUFFERED_BYTES) {
      logger.warn('a notification listener client stopped reading and was dropped');
      client.destroy();
      return;
    }
    client.write(line);
  };

  return {
    name: 'listener',
    path: () => socketPath,
    clientCount: () => clients.size,

    async start({ port }) {
      let target: string;
      if (configuredPath) {
        target = path.resolve(configuredPath);
      } else {
        target = defaultListenerPath(port);
        const dir = path.dirname(target);
        await mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'EEXIST') throw err;
        });
        await checkOwnDirectory(dir);
      }
      assertUsablePath(target);
      if (configuredPath) {
        // tr-ai-intercom-notify applies this check and would refuse the socket.
        const dirInfo = await lstat(path.dirname(target)).catch(() => undefined);
        if (dirInfo && (dirInfo.mode & 0o022) !== 0) {
          logger.warn(
            'the directory of the notification listener can be written by other users; tr-ai-intercom-notify will not connect to a socket there. Use a directory of your own',
            { directory: path.dirname(target) },
          );
        }
      }

      // A socket file left behind by a helper that did not stop cleanly.
      const existing = await lstat(target).catch(() => undefined);
      if (existing) {
        if (!existing.isSocket()) {
          throw new Error(`${target} exists and is not a socket. Remove it or use another path.`);
        }
        if (await answers(target)) {
          throw new Error(`Another program is already listening on ${target}.`);
        }
        await unlink(target);
      }

      const created = net.createServer((client) => {
        clients.add(client);
        // Clients only listen; whatever they send is discarded.
        client.resume();
        client.on('error', () => undefined);
        client.on('close', () => clients.delete(client));
        if (kept !== undefined) {
          send(client, kept);
          kept = undefined;
        }
      });
      await new Promise<void>((resolve, reject) => {
        created.once('error', reject);
        created.listen(target, () => {
          created.off('error', reject);
          resolve();
        });
      });
      await chmod(target, 0o600);
      server = created;
      socketPath = target;
    },

    async deliver(_notification, json) {
      const line = `${json}\n`;
      if (clients.size === 0) {
        kept = line;
        return;
      }
      for (const client of clients) send(client, line);
    },

    stop() {
      for (const client of clients) client.destroy();
      clients.clear();
      server?.close();
      server = undefined;
      // Node removes the socket file on close; this covers the case where it did not.
      if (socketPath) void unlink(socketPath).catch(() => undefined);
    },
  };
}

/** The command line that connects to a listener, for the log and the documentation. */
export function notifyCommand(opts: { port: number; path?: string | undefined }): string {
  const where = opts.path ? `--socket-path '${opts.path}'` : `--helper-port ${opts.port}`;
  return `npx -y -p tr-ai-intercom-helper tr-ai-intercom-notify --monitor ${where}`;
}
