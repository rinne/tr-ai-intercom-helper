import { spawn } from 'node:child_process';
import { mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { listenerSink } from './listener.js';
import type { Logger } from './logger.js';
import type { Config } from './options.js';
import type { Notification } from './wakeup.js';

/** What a delivery method is told when it starts. */
export interface StartInfo {
  /** The local port the helper listens on. */
  port: number;
}

/** One way of handing a notification to something local. */
export interface Sink {
  /** Short name for the log: file, dir, url, local-socket, command, listener. */
  readonly name: string;
  /** The method queues by itself; the dispatcher then hands over at once. */
  readonly queuesItself?: boolean;
  /** Prepare, once, before the first notification. The helper listens by then. */
  start?(info: StartInfo): Promise<void>;
  deliver(notification: Notification, json: string): Promise<void>;
  stop?(): void;
}

/** Append to a file: open, one write of the JSON and a newline, close. */
export function fileSink(file: string): Sink {
  return {
    name: 'file',
    async deliver(_n, json) {
      const handle = await open(file, 'a');
      try {
        await handle.write(`${json}\n`);
      } finally {
        await handle.close();
      }
    },
  };
}

/** The file name of a notification: its number as at least eight hex digits. */
export function fileNameOf(seq: number): string {
  return `${Math.max(0, Math.trunc(seq)).toString(16).padStart(8, '0')}.json`;
}

const LEFTOVER = /^[0-9a-f]{8,}\.json\.\d+\.tmp$/;

/**
 * One file per notification in a directory. The file is written in a
 * temporary directory and renamed into place, so whoever watches the
 * directory sees one event, for a complete file. By default the temporary
 * directory is `.tmp` inside the directory itself: the helper then needs
 * write access to nothing else, and both are on one file system.
 */
export function dirSink(dir: string, tmpDir: string = path.join(dir, '.tmp')): Sink {
  return {
    name: 'dir',
    async start() {
      await mkdir(dir, { recursive: true });
      await mkdir(tmpDir, { recursive: true });
      // Files a previous run left half-written.
      for (const name of await readdir(tmpDir)) {
        if (LEFTOVER.test(name)) await unlink(path.join(tmpDir, name)).catch(() => undefined);
      }
    },
    async deliver(n, json) {
      const name = fileNameOf(n.seq);
      const tmp = path.join(tmpDir, `${name}.${process.pid}.tmp`);
      try {
        await writeFile(tmp, `${json}\n`);
        await rename(tmp, path.join(dir, name));
      } catch (err) {
        await unlink(tmp).catch(() => undefined);
        throw err;
      }
    },
  };
}

/** POST the JSON to a URL. Any 2xx answer is success. */
export function urlSink(
  url: string,
  header?: { name: string; value: string },
  timeoutMs = 10_000,
): Sink {
  return {
    name: 'url',
    async deliver(_n, json) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(header ? { [header.name]: header.value } : {}),
        },
        body: json,
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) throw new Error(`the URL answered ${res.status}`);
    },
  };
}

/** Connect to a local socket, write the JSON and a newline, close. */
export function localSocketSink(socketPath: string, timeoutMs = 10_000): Sink {
  return {
    name: 'local-socket',
    deliver(_n, json) {
      return new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        let done = false;
        const finish = (err?: Error): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          socket.destroy();
          if (err) reject(err);
          else resolve();
        };
        const timer = setTimeout(
          () => finish(new Error('timed out writing to the local socket')),
          timeoutMs,
        );
        socket.on('error', finish);
        socket.on('connect', () => socket.end(`${json}\n`));
        socket.on('close', () => finish());
      });
    },
  };
}

/**
 * Run a command through the shell, with the JSON on its standard input and
 * the kind and number in its environment. One runs at a time: of the
 * notifications that arrive while it runs, only the latest is kept and run
 * afterwards. A run that takes too long is killed.
 */
export function commandSink(command: string, logger: Logger, timeoutMs = 60_000): Sink {
  let running = false;
  let waiting: { n: Notification; json: string; done: (err?: Error) => void } | undefined;
  let stopped = false;
  let current: ReturnType<typeof spawn> | undefined;

  const run = (n: Notification, json: string, done: (err?: Error) => void): void => {
    running = true;
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      current = undefined;
      running = false;
      done(err);
      const next = waiting;
      waiting = undefined;
      if (next && !stopped) run(next.n, next.json, next.done);
      else next?.done();
    };
    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', 'ignore', 'inherit'],
      env: {
        ...process.env,
        INTERCOM_NOTIFICATION_MESSAGE: n.message,
        INTERCOM_NOTIFICATION_SEQ: String(n.seq),
      },
    });
    current = child;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        new Error(`the command ran longer than ${Math.round(timeoutMs / 1000)} s and was killed`),
      );
    }, timeoutMs);
    child.on('error', finish);
    child.on('exit', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`the command ended with ${signal ?? `status ${code}`}`));
    });
    // A command that does not read its input is not an error.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(`${json}\n`);
  };

  return {
    name: 'command',
    queuesItself: true,
    deliver(n, json) {
      return new Promise<void>((resolve, reject) => {
        const done = (err?: Error): void => (err ? reject(err) : resolve());
        if (!running) {
          run(n, json, done);
          return;
        }
        if (waiting) {
          logger.debug('a notification was replaced by a newer one while the command ran', {
            seq: waiting.n.seq,
          });
          waiting.done();
        }
        waiting = { n, json, done };
      });
    },
    stop() {
      stopped = true;
      current?.kill('SIGTERM');
    },
  };
}

/** The delivery methods the configuration asks for. */
export function sinksFor(config: Config, logger: Logger): Sink[] {
  const sinks: Sink[] = [];
  if (config.file) sinks.push(fileSink(config.file));
  if (config.dir) sinks.push(dirSink(config.dir, config.tmpDir));
  if (config.url) sinks.push(urlSink(config.url, config.urlHeader));
  if (config.localSocket) sinks.push(localSocketSink(config.localSocket));
  if (config.command) sinks.push(commandSink(config.command, logger));
  if (config.listener) sinks.push(listenerSink(logger, config.listenerPath));
  return sinks;
}

/**
 * Hands each notification to every delivery method. Each method gets its
 * notifications in order, one after the other, and a failure in one neither
 * stops the others nor is tried again: the notification is dropped for that
 * method with a warning.
 */
export class Dispatcher {
  private readonly queues = new Map<Sink, Promise<void>>();

  constructor(
    private readonly sinks: Sink[],
    private readonly logger: Logger,
  ) {}

  async start(info: StartInfo): Promise<void> {
    for (const sink of this.sinks) await sink.start?.(info);
  }

  deliver(notification: Notification): void {
    const json = JSON.stringify(notification);
    this.logger.debug('notification', { message: notification.message, seq: notification.seq });
    for (const sink of this.sinks) {
      const hand = (): Promise<void> =>
        sink.deliver(notification, json).catch((err: unknown) => {
          this.logger.warn('notification dropped: delivery failed', {
            method: sink.name,
            message: notification.message,
            seq: notification.seq,
            err,
          });
        });
      const before = this.queues.get(sink) ?? Promise.resolve();
      this.queues.set(
        sink,
        sink.queuesItself ? Promise.all([before, hand()]).then(() => undefined) : before.then(hand),
      );
    }
  }

  /** Resolves when everything handed over so far has been delivered or dropped. */
  async idle(): Promise<void> {
    await Promise.all(this.queues.values());
  }

  stop(): void {
    for (const sink of this.sinks) sink.stop?.();
  }
}
