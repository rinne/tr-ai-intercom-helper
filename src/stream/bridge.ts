import net from 'node:net';
import type { Readable, Writable } from 'node:stream';
import WebSocket, { type RawData } from 'ws';

/**
 * One end of a stream of an intercom, connected to an input and an output.
 *
 * A stream is a relayed, two-way flow of bytes that an agent opened on its
 * intercom; each of its two ends is a single-use WebSocket URL. This puts
 * one end on a pair of byte streams, normally standard input and output, so
 * that a file, a pipe or another program can be at that end; or on a local
 * TCP port, so that a program that speaks TCP can be.
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
const STREAM_PATH = /\/mcp\/stream\/[A-Za-z0-9_-]{16,}$/;

/**
 * Check the URL of an end before anything is sent to it, and return it as a
 * WebSocket URL. It may be given as wss:// or https://; without TLS only
 * for this machine itself.
 */
export function checkStreamUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new BridgeError(
      'That is not a URL. The URL of an end of a stream looks like wss://intercom.example.com/mcp/stream/… and comes from the agent that opened the stream.',
    );
  }
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  const secure =
    url.protocol === 'wss:' || (url.protocol === 'ws:' && LOCAL_HOSTS.has(url.hostname));
  if (!secure) {
    throw new BridgeError(
      'The URL of a stream must be a wss:// URL (ws:// is accepted for localhost only): the URL is the only credential, and without TLS anybody on the way could read it.',
    );
  }
  if (url.username || url.password || url.search || url.hash || !STREAM_PATH.test(url.pathname)) {
    throw new BridgeError(
      'That is not the URL of an end of a stream: it should end in /mcp/stream/ and a long code, with nothing after it.',
    );
  }
  return url;
}

/** Why the intercom closed a stream, in words. */
const REASONS: Record<string, string> = {
  'peer-closed': 'the other end closed the stream',
  'closed-by-creator': 'the agent that opened the stream closed it',
  'closed-by-administrator': 'the stream was disconnected by an administrator of the intercom',
  'never-connected': 'the other end did not connect in time',
  idle: 'nothing passed for the idle time of the stream',
  'access-ended': 'the agent that opened the stream may no longer have it',
  'exchange-suspended': 'the exchange of the agent that opened the stream was suspended',
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

/**
 * A TCP port at this end instead of an input and an output.
 * - `listen`: the port is opened here, and the first program that connects
 *   to it is on the stream. Nobody else is let in afterwards.
 * - `connect`: the bridge connects to the port once the other end says that
 *   it is there, so that a server is not kept waiting for a peer that has
 *   not come yet.
 * One stream carries one connection. When the connection ends, the stream
 * is closed, and the other way round: a stream has no half-close.
 */
export type PortSide = { listen: LocalAddress } | { connect: LocalAddress };

const ADDRESS = /^(?:(\[[0-9A-Fa-f:.]+\]|[^:\s[\]]+):)?(\d{1,5})$/;

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

/** An address as it is written: 127.0.0.1:2222, [::1]:2222. */
export const shownAddress = (address: LocalAddress): string =>
  address.host.includes(':')
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
  ENOTFOUND: 'the name is not known',
  ETIMEDOUT: 'no answer in time',
  EPIPE: 'the connection was closed',
};
const netError = (err: Error & { code?: string }): string =>
  (err.code && NET_ERRORS[err.code]) ?? err.message;

/** How long a --connect end waits for its port to answer. */
const DIAL_TIMEOUT_MS = 10_000;
const EMPTY = Buffer.alloc(0);

interface BridgeCommon {
  url: URL;
  /** A line for the person, never with the URL in it. */
  say(message: string): void;
  /** Aborting it closes the stream and ends the bridge. */
  signal?: AbortSignal;
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
 * An end says that it is there by sending an empty message once its local
 * side is ready: at once for an input and an output, when a program
 * connected for a port. An end on `connect` waits for the first message of
 * the other end, empty or not, before it connects.
 */
export function runBridge(opts: BridgeOptions): Promise<number> {
  const { url, say } = opts;
  const port = opts.port;
  // A program on a port is like --send: when it ends, the stream is closed.
  const mode: BridgeMode = opts.port ? 'send' : opts.mode;
  return new Promise((resolve) => {
    let done = false;
    let opened = false;
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
      if (!opts.port) {
        if (mode !== 'receive') opts.input.pause();
        // Let what was received reach a pipe or file before the status is given.
        opts.output.write('', () => resolve(status));
        return;
      }
      const s = socket;
      if (!s || s.destroyed) return resolve(status);
      // What arrived reaches the program before its connection is ended.
      const giveUp = setTimeout(() => s.destroy(), 2000);
      giveUp.unref();
      s.once('close', () => {
        clearTimeout(giveUp);
        resolve(status);
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
      // Say that this end is there: an end on a port it connects to waits for that.
      if (ws.readyState === WebSocket.OPEN) ws.send(EMPTY, { binary: true });
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

    /** Connect to the port, when the other end has said that it is there. */
    const dial = (to: LocalAddress): void => {
      if (dialling || socket || done) return;
      dialling = true;
      const s = net.connect({ host: to.host, port: to.port });
      const failed = (why: string): void => {
        if (!dialling) return;
        dialling = false;
        s.destroy();
        say(`could not connect to ${shownAddress(to)}: ${why}; the stream is closed`);
        own = 'no-port';
        if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000);
        finish(1);
      };
      const slow = setTimeout(() => failed('no answer in time'), DIAL_TIMEOUT_MS);
      slow.unref();
      s.once('error', (err) => {
        clearTimeout(slow);
        failed(netError(err));
      });
      s.once('connect', () => {
        clearTimeout(slow);
        dialling = false;
        if (done) return void s.destroy();
        adopt(s);
      });
    };

    const start = (): void => {
      const stream = new WebSocket(url, { perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 });
      ws = stream;
      stream.on('open', () => {
        opened = true;
        attach();
      });
      stream.on('message', (data) => {
        const bytes = toBuffer(data);
        if (attached) return write(bytes);
        if (bytes.length > 0) {
          waiting.push(bytes);
          waitingBytes += bytes.length;
          if (waitingBytes > HELD_BYTES && !held) {
            held = true;
            stream.pause();
          }
        }
        if (port && 'connect' in port) dial(port.connect);
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

    if (!port || 'connect' in port) return start();

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
