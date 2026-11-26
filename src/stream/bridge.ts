import { readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import type { Readable, Writable } from 'node:stream';
import WebSocket, { type RawData } from 'ws';

/**
 * One end of a stream of an intercom, or one client of a stream service,
 * connected to an input and an output.
 *
 * A stream is a relayed, two-way flow of bytes that an agent opened on its
 * intercom; each of its two ends is a single-use WebSocket URL. A stream
 * service is a standing door to a server program: its URL for clients can
 * be opened any number of times, and each time is one connection. This puts
 * such a connection on a pair of byte streams, normally standard input and
 * output, so that a file, a pipe or another program can be at that end; or
 * on a local TCP port, so that a program that speaks TCP can be.
 *
 * The URL is the only credential and is never printed or logged.
 */

/**
 * What is done with the input.
 * - `send`: it is read and sent; when it ends, what was sent is delivered
 *   and the stream is closed.
 * - `receive`: it is not read at all.
 * - `both`: it is read and sent, and its end does not close the stream.
 */
export type BridgeMode = 'send' | 'receive' | 'both';

export class BridgeError extends Error {}

/** The largest message this end sends. The intercom relays messages of up to 1 MiB. */
export const CHUNK_BYTES = 64 * 1024;
/** What may wait to leave this process before the input is no longer read. */
const HELD_BYTES = 1024 * 1024;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const TOKEN = '[A-Za-z0-9_-]{16,}';
const STREAM_PATH = new RegExp(`/mcp/stream/${TOKEN}$`);
const SERVICE_PATH = new RegExp(`/mcp/service/${TOKEN}$`);
const CONTROL_PATH = new RegExp(`/mcp/control/${TOKEN}$`);
const ACCEPT_PATH = new RegExp(`/mcp/accept/${TOKEN}$`);

/** What a URL is of: an end of a stream, or the door of a stream service. */
export type UrlKind = 'stream' | 'service';

/** A URL as a WebSocket URL, with TLS unless it is of this machine itself. */
function webSocketUrl(text: string, what: string, example: string): URL {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new BridgeError(`That is not a URL. ${what} looks like ${example}`);
  }
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  const secure =
    url.protocol === 'wss:' || (url.protocol === 'ws:' && LOCAL_HOSTS.has(url.hostname));
  if (!secure) {
    throw new BridgeError(
      `${what} must be a wss:// URL (ws:// is accepted for localhost only): the URL is the only credential, and without TLS anybody on the way could read it.`,
    );
  }
  return url;
}

const plain = (url: URL): boolean => !url.username && !url.password && !url.search && !url.hash;

/**
 * Check the URL of an end of a stream, or of a stream service for its
 * clients, before anything is sent to it, and return it as a WebSocket URL
 * with what it is of. It may be given as wss:// or https://.
 */
export function checkEndUrl(text: string): { url: URL; kind: UrlKind } {
  const url = webSocketUrl(
    text,
    'The URL of a stream',
    'wss://intercom.example.com/mcp/stream/… and comes from the agent that opened the stream; the URL of a stream service for its clients has /mcp/service/ in that place.',
  );
  const kind: UrlKind | null = STREAM_PATH.test(url.pathname)
    ? 'stream'
    : SERVICE_PATH.test(url.pathname)
      ? 'service'
      : null;
  if (!kind || !plain(url)) {
    throw new BridgeError(
      CONTROL_PATH.test(url.pathname)
        ? 'That is the control URL of a stream service, which is for the program that serves: tr-ai-intercom-serve. Clients connect to the other URL of the service, the one with /mcp/service/ in it.'
        : 'That is not the URL of an end of a stream: it should end in /mcp/stream/ and a long code, with nothing after it (or in /mcp/service/ and a long code, for a stream service).',
    );
  }
  return { url, kind };
}

/** The URL of an end of a stream or of a stream service, as a WebSocket URL. */
export const checkStreamUrl = (text: string): URL => checkEndUrl(text).url;

/** Check the control URL of a stream service, and return it as a WebSocket URL. */
export function checkControlUrl(text: string): URL {
  const url = webSocketUrl(
    text,
    'The control URL of a stream service',
    'wss://intercom.example.com/mcp/control/… and comes from the agent that registered the service.',
  );
  if (!CONTROL_PATH.test(url.pathname) || !plain(url)) {
    throw new BridgeError(
      SERVICE_PATH.test(url.pathname)
        ? 'That is the URL of a stream service for its clients. The program that serves needs the other one, the control URL, with /mcp/control/ in it.'
        : 'That is not the control URL of a stream service: it should end in /mcp/control/ and a long code, with nothing after it.',
    );
  }
  return url;
}

/**
 * Check the URL of one announced connection, as a control socket hands it
 * out. It is the intercom's own, but it is where data is about to go.
 */
export function checkAcceptUrl(text: string): URL {
  const url = webSocketUrl(text, 'The URL of an announced connection', 'wss://…/mcp/accept/…');
  if (!ACCEPT_PATH.test(url.pathname) || !plain(url)) {
    throw new BridgeError('That is not the URL of an announced connection.');
  }
  return url;
}

/**
 * Read a URL from a file that holds nothing else. A file that others can
 * read is refused: the URL is a credential.
 */
export function readUrlFile(path: string): string {
  let mode: number;
  let text: string;
  try {
    mode = statSync(path).mode;
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new BridgeError(`The file with the URL could not be read: ${(err as Error).message}`);
  }
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new BridgeError(
      `The file with the URL can be read by others (mode ${(mode & 0o777).toString(8)}). The URL is a credential: make the file yours alone (chmod 600) and try again.`,
    );
  }
  const url = text.trim();
  if (!url || /\s/.test(url)) {
    throw new BridgeError('The file with the URL holds one URL and nothing else.');
  }
  return url;
}

/** Why the intercom closed a stream or a connection of a stream service, in words. */
const REASONS: Record<string, string> = {
  'peer-closed': 'the other end closed the stream',
  'closed-by-creator': 'the agent that opened the stream closed it',
  'closed-by-administrator': 'the stream was disconnected by an administrator of the intercom',
  'never-connected': 'the other end did not connect in time',
  idle: 'nothing passed for the idle time of the stream',
  'access-ended': 'the agent that opened the stream may no longer have it',
  'exchange-suspended': 'the exchange of the agent that opened the stream was suspended',
  'service-ended': 'the stream service was removed',
  'url-renewed': 'the URL of the stream service was renewed',
  'message-too-large': 'a message was larger than the intercom relays',
  'server-shutdown': 'the intercom stopped',
  'stream-ended': 'the stream had ended already',
};

const toBuffer = (data: RawData): Buffer =>
  Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data as ArrayBuffer);

/** A TCP address on this machine, or one it can reach. */
export interface LocalAddress {
  host: string;
  port: number;
}

/** Where a connection is made to: a TCP address, or a local domain socket. */
export type LocalTarget = LocalAddress | { path: string };

/**
 * A TCP port at this end instead of an input and an output.
 * - `listen`: the port is opened here, and the first program that connects
 *   to it is on the stream. Nobody else is let in afterwards.
 * - `connect`: the bridge connects to the port (or the local domain socket)
 *   as soon as its end of the stream is open.
 * - `socket`: a connection that is there already.
 * One stream carries one connection. When the connection ends, the stream
 * is closed, and the other way round: a stream has no half-close.
 */
export type PortSide = { listen: LocalAddress } | { connect: LocalTarget } | { socket: net.Socket };

const ADDRESS = /^(?:(\[[0-9A-Fa-f:.]+\]|[^:\s[\]/]+):)?(\d{1,5})$/;

/**
 * Read what --listen or --connect was given: a port, or an address and a
 * port. Without an address it is this machine itself, 127.0.0.1.
 */
export function parseLocalAddress(text: string, option: 'listen' | 'connect'): LocalAddress {
  const match = ADDRESS.exec(text.trim());
  const port = match ? Number(match[2]) : NaN;
  const lowest = option === 'listen' ? 0 : 1;
  if (!match || port < lowest || port > 65535) {
    throw new BridgeError(
      `--${option} takes a port, or an address and a port: 2222, 127.0.0.1:2222 or [::1]:2222.${
        option === 'listen' ? ' Port 0 lets the system choose one, which is then said.' : ''
      }`,
    );
  }
  return { host: match[1] ? match[1].replace(/^\[|\]$/g, '') : '127.0.0.1', port };
}

/**
 * Read where connections go: what `parseLocalAddress` reads, or the path of
 * a local domain socket, which is anything with a "/" in it.
 */
export function parseLocalTarget(text: string): LocalTarget {
  const trimmed = text.trim();
  if (trimmed.includes('/')) return { path: trimmed };
  try {
    return parseLocalAddress(trimmed, 'connect');
  } catch {
    throw new BridgeError(
      '--connect takes a port, an address and a port, or the path of a local domain socket: 5432, 127.0.0.1:5432, [::1]:5432 or /run/postgresql/.s.PGSQL.5432.',
    );
  }
}

/** An address as it is written: 127.0.0.1:2222, [::1]:2222, /run/x.sock. */
export const shownAddress = (address: LocalTarget): string =>
  'path' in address
    ? address.path
    : address.host.includes(':')
      ? `[${address.host}]:${address.port}`
      : `${address.host}:${address.port}`;

const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '::1' || /^127\./.test(host);

const NET_ERRORS: Record<string, string> = {
  EADDRINUSE: 'the port is in use',
  EACCES: 'not permitted',
  EADDRNOTAVAIL: 'this machine has no such address',
  ECONNREFUSED: 'nothing listens there',
  ECONNRESET: 'the connection was reset',
  EHOSTUNREACH: 'the host cannot be reached',
  ENETUNREACH: 'the network cannot be reached',
  ENOENT: 'there is no such socket',
  ENOTFOUND: 'the name is not known',
  ETIMEDOUT: 'no answer in time',
  EPIPE: 'the connection was closed',
};
export const netError = (err: Error & { code?: string }): string =>
  (err.code && NET_ERRORS[err.code]) ?? err.message;

/** How long a connection to a port or a local domain socket may take. */
export const DIAL_TIMEOUT_MS = 10_000;

/**
 * Connect to a port or a local domain socket. Resolves with the connection,
 * or rejects with a BridgeError that says why not in a few words.
 */
export function dialLocal(to: LocalTarget, timeoutMs = DIAL_TIMEOUT_MS): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = 'path' in to ? net.connect({ path: to.path }) : net.connect(to);
    let settled = false;
    const fail = (why: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(slow);
      s.destroy();
      reject(new BridgeError(why));
    };
    const slow = setTimeout(() => fail('no answer in time'), timeoutMs);
    slow.unref();
    s.once('error', (err) => fail(netError(err)));
    s.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(slow);
      s.setNoDelay(true);
      resolve(s);
    });
  });
}

/** How a bridge ended, for whoever keeps a log of connections. */
export interface BridgeReport {
  status: number;
  /** The stream was open: the connection was made. */
  opened: boolean;
  /** Why it ended, in the words that are otherwise said. */
  detail: string;
  /** Bytes from the local side into the stream, and from the stream to the local side. */
  sent: number;
  received: number;
  /** From the opening of the stream to its end. */
  ms: number;
}

interface BridgeCommon {
  url: URL;
  /** A line for the person, never with the URL in it. */
  say(message: string): void;
  /** Aborting it closes the stream and ends the bridge. */
  signal?: AbortSignal;
  /** The stream is open: the local side is connected to the other end. */
  opened?(): void;
  /** How it ended. */
  report?(report: BridgeReport): void;
}

export type BridgeOptions = BridgeCommon &
  ({ mode: BridgeMode; input: Readable; output: Writable; port?: undefined } | { port: PortSide });

/**
 * Run until the stream is over. Resolves with the exit status: 0 when the
 * other end closed it or this end did after sending everything (for a port:
 * after its program ended the connection), 1 when this end could not be set
 * up (the URL was refused or could not be reached, the port could not be
 * listened on or connected to), 2 for any other ending, 130 when
 * interrupted.
 *
 * Nothing but the payload is sent on the stream.
 */
export function runBridge(opts: BridgeOptions): Promise<number> {
  const { url } = opts;
  const port = opts.port;
  // A program on a port is like --send: when it ends, the stream is closed.
  const mode: BridgeMode = opts.port ? 'send' : opts.mode;
  return new Promise((resolve) => {
    let done = false;
    let opened = false;
    let openedAt = 0;
    let sent = 0;
    let received = 0;
    let said = '';
    const say = (message: string): void => {
      said = message;
      opts.say(message);
    };
    /** This end is closing the stream itself: its input or program ended, it could not reach its port, or it was interrupted. */
    let own: 'sent' | 'interrupted' | 'no-port' | null = null;
    let drain: NodeJS.Timeout | null = null;
    let ws: WebSocket | null = null;
    let server: net.Server | null = null;
    let socket: net.Socket | null = null;
    let dialling = false;
    /** The local connection ended, and how, when it was not a normal end. */
    let localOver = false;
    let localError: string | null = null;
    /** What the stream is connected to here, once it is there. */
    let local: { input: Readable; output: Writable } | null = opts.port
      ? null
      : { input: opts.input, output: opts.output };
    let attached = false;
    /** What arrived before the local side was there. */
    const waiting: Buffer[] = [];
    let waitingBytes = 0;
    let held = false;
    /** The stream is over, and its status is given once what waits was handed on. */
    let over: { status: number } | null = null;

    const finish = (status: number): void => {
      if (done) return;
      done = true;
      if (drain) clearInterval(drain);
      opts.signal?.removeEventListener('abort', onAbort);
      server?.close();
      if (local) {
        local.input.off('data', onData);
        local.input.off('end', onEnd);
      }
      const settle = (): void => {
        opts.report?.({
          status,
          opened,
          detail: said,
          sent,
          received,
          ms: opened ? Date.now() - openedAt : 0,
        });
        resolve(status);
      };
      if (!opts.port) {
        if (mode !== 'receive') opts.input.pause();
        // Let what was received reach a pipe or file before the status is given.
        opts.output.write('', settle);
        return;
      }
      const s = socket;
      if (!s || s.destroyed) return settle();
      // What arrived reaches the program before its connection is ended.
      const giveUp = setTimeout(() => s.destroy(), 2000);
      giveUp.unref();
      s.once('close', () => {
        clearTimeout(giveUp);
        settle();
      });
      s.end(() => s.destroy());
    };

    const onAbort = (): void => {
      own = 'interrupted';
      if (!ws || over) {
        say('interrupted');
        finish(130);
      } else if (ws.readyState === WebSocket.OPEN) ws.close(1000);
      else ws.terminate();
    };

    /** Stop reading the local side while too much waits to leave. */
    const holdInput = (): void => {
      if (drain || !ws || !local || ws.bufferedAmount <= HELD_BYTES) return;
      const input = local.input;
      input.pause();
      drain = setInterval(() => {
        if (ws!.bufferedAmount > HELD_BYTES / 4) return;
        clearInterval(drain!);
        drain = null;
        if (!done) input.resume();
      }, 20);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      sent += bytes.length;
      for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
        ws!.send(bytes.subarray(at, at + CHUNK_BYTES), { binary: true });
      }
      holdInput();
    };
    /** The local side has nothing more to send, which closes the stream unless it only receives or goes both ways on standard input. */
    const onEnd = (): void => {
      if (mode !== 'send' || !ws || ws.readyState !== WebSocket.OPEN) return;
      // Everything handed to the socket is delivered before the closing.
      own ??= 'sent';
      ws.close(1000);
    };

    const write = (bytes: Buffer): void => {
      if (bytes.length === 0 || !local || !ws) return;
      // Nothing can be given to a program that has ended its connection.
      if (socket && (socket.destroyed || socket.writableEnded)) return;
      received += bytes.length;
      // A slow reader of the output slows the stream.
      if (local.output.write(bytes)) return;
      const stream = ws;
      stream.pause();
      local.output.once('drain', () => stream.resume());
    };

    /** Connect the stream and the local side, once both are there. */
    const attach = (): void => {
      if (attached || done || !local || !opened || !ws) return;
      attached = true;
      for (const bytes of waiting.splice(0)) write(bytes);
      waitingBytes = 0;
      if (held) {
        held = false;
        ws.resume();
      }
      if (over) return finish(over.status);
      if (localOver) return onLocalOver();
      if (mode === 'receive') return;
      local.input.on('data', onData);
      local.input.on('end', onEnd);
      local.input.resume();
    };

    /** The program on the port is gone: nothing more can be given to it or come from it. */
    const onLocalOver = (): void => {
      localOver = true;
      if (done) return;
      if (over) return finish(over.status);
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      own ??= 'sent';
      ws.close(1000);
    };
    const adopt = (s: net.Socket): void => {
      socket = s;
      s.setNoDelay(true);
      s.on('error', (err: Error & { code?: string }) => (localError = netError(err)));
      s.on('close', onLocalOver);
      local = { input: s, output: s };
      attach();
    };

    /** Connect to the port, now that this end of the stream is open. */
    const dial = (to: LocalTarget): void => {
      if (dialling || socket || done) return;
      dialling = true;
      dialLocal(to).then(
        (s) => {
          dialling = false;
          if (done) return void s.destroy();
          adopt(s);
        },
        (err: Error) => {
          dialling = false;
          if (done) return;
          say(`could not connect to ${shownAddress(to)}: ${err.message}; the stream is closed`);
          own = 'no-port';
          if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000);
          finish(1);
        },
      );
    };

    const start = (): void => {
      const stream = new WebSocket(url, { perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 });
      ws = stream;
      stream.on('open', () => {
        opened = true;
        openedAt = Date.now();
        opts.opened?.();
        if (port && 'connect' in port) dial(port.connect);
        attach();
      });
      stream.on('message', (data) => {
        const bytes = toBuffer(data);
        if (attached) return write(bytes);
        if (bytes.length === 0) return;
        waiting.push(bytes);
        waitingBytes += bytes.length;
        if (waitingBytes > HELD_BYTES && !held) {
          held = true;
          stream.pause();
        }
      });
      stream.on('unexpected-response', (_request, response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        response.on('end', () => {
          say(
            `the intercom refused the URL (${response.statusCode}): ${body.trim() || 'no reason given'}`,
          );
          finish(1);
        });
        response.on('error', () => finish(1));
      });
      stream.on('error', (err: Error & { code?: string }) => {
        if (opened || done) return;
        say(`could not connect to the intercom: ${err.message}`);
        finish(1);
      });
      stream.on('close', (code, reasonBytes) => {
        if (done) return;
        if (!opened) {
          // Refused or unreachable: said already, or about to be.
          setTimeout(() => finish(own === 'interrupted' ? 130 : 1), 50).unref();
          return;
        }
        const reason = reasonBytes.toString('utf8');
        let status: number;
        let message: string;
        if (own === 'interrupted') {
          [status, message] = [130, 'interrupted; the stream is closed'];
        } else if (own === 'sent' && port) {
          [status, message] = localError
            ? [2, `the connection on the port was lost (${localError}); the stream is closed`]
            : [0, 'the program on the port ended its connection; the stream is closed'];
        } else if (own === 'sent') {
          [status, message] = [0, 'everything was sent; the stream is closed'];
        } else if (reason === 'peer-closed') {
          [status, message] = [0, REASONS[reason]!];
        } else {
          status = 2;
          message =
            REASONS[reason] ??
            (code === 1006
              ? 'the connection to the intercom was lost'
              : `the stream was closed (${reason || code})`);
        }
        // What the other end sent before it left is still given to the
        // program on the port: the one that is being connected to, or the
        // one that has not come yet.
        const owed = port && !attached && own === null && status === 0;
        if (owed && (dialling || ('listen' in port && waitingBytes > 0))) {
          over = { status };
          say(
            dialling
              ? message
              : `${message}; what it sent is kept for the program that connects to the port`,
          );
          return;
        }
        say(message);
        finish(status);
      });
    };

    if (opts.signal?.aborted) {
      say('interrupted');
      return resolve(130);
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    if (port && 'socket' in port) adopt(port.socket);
    if (!port || !('listen' in port)) return start();

    // The port is opened before the URL is used: a port that cannot be had
    // costs no stream.
    const at = port.listen;
    const listener = net.createServer();
    server = listener;
    listener.on('error', (err: Error & { code?: string }) => {
      if (listener.listening || done) return;
      say(
        `could not listen on ${shownAddress(at)}: ${netError(err)}; the URL of the stream was not used`,
      );
      finish(1);
    });
    listener.on('connection', (s) => {
      // One stream carries one connection: the first one.
      if (socket || done) return void s.destroy();
      listener.close();
      adopt(s);
    });
    listener.listen({ host: at.host, port: at.port }, () => {
      const bound = { host: at.host, port: (listener.address() as net.AddressInfo).port };
      say(
        `listening on ${shownAddress(bound)}; the first program that connects is on the stream${
          isLoopback(at.host)
            ? ''
            : ', and it may be any program that can reach this address: the port has no other protection'
        }`,
      );
      start();
    });
  });
}

/**
 * A port for the clients of a stream service: it stays open, and every
 * program that connects to it gets a connection of its own to the service.
 * A program whose connection the service does not take is disconnected, and
 * a line says why. Runs until it is interrupted (status 130) or the port
 * cannot be had (status 1).
 */
export function runListener(opts: {
  url: URL;
  listen: LocalAddress;
  say(message: string): void;
  signal?: AbortSignal;
}): Promise<number> {
  const { url, say } = opts;
  const at = opts.listen;
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      say('interrupted');
      return resolve(130);
    }
    const stop = new AbortController();
    const running = new Set<Promise<number>>();
    const listener = net.createServer();
    let done = false;
    const finish = (status: number): void => {
      if (done) return;
      done = true;
      listener.close();
      stop.abort();
      void Promise.allSettled([...running]).then(() => resolve(status));
    };
    opts.signal?.addEventListener(
      'abort',
      () => {
        say('interrupted');
        finish(130);
      },
      { once: true },
    );
    listener.on('error', (err: Error & { code?: string }) => {
      if (listener.listening || done) return;
      say(`could not listen on ${shownAddress(at)}: ${netError(err)}`);
      finish(1);
    });
    listener.on('connection', (s) => {
      if (done) return void s.destroy();
      const from = `${s.remoteAddress ?? '?'}:${s.remotePort ?? '?'}`;
      const one = runBridge({
        url,
        port: { socket: s },
        say: () => undefined,
        signal: stop.signal,
        // A connection that came and went as it should is not worth a line.
        report: (r) => {
          if (r.status !== 0 && r.status !== 130) say(`${from}: ${r.detail}`);
        },
      });
      running.add(one);
      void one.finally(() => running.delete(one));
    });
    listener.listen({ host: at.host, port: at.port }, () => {
      const bound = { host: at.host, port: (listener.address() as net.AddressInfo).port };
      say(
        `listening on ${shownAddress(bound)}; every program that connects gets a connection of its own to the stream service${
          isLoopback(at.host)
            ? ''
            : ', and it may be any program that can reach this address: the port has no other protection'
        }`,
      );
    });
  });
}
