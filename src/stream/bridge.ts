import type { Readable, Writable } from 'node:stream';
import WebSocket, { type RawData } from 'ws';

/**
 * One end of a stream of an intercom, connected to an input and an output.
 *
 * A stream is a relayed, two-way flow of bytes that an agent opened on its
 * intercom; each of its two ends is a single-use WebSocket URL. This puts
 * one end on a pair of byte streams, normally standard input and output, so
 * that a file, a pipe or another program can be at that end.
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

export interface BridgeOptions {
  url: URL;
  mode: BridgeMode;
  input: Readable;
  output: Writable;
  /** A line for the person, never with the URL in it. */
  say(message: string): void;
  /** Aborting it closes the stream and ends the bridge. */
  signal?: AbortSignal;
}

/**
 * Run until the stream is over. Resolves with the exit status: 0 when the
 * other end closed it or this end did after sending everything, 1 when the
 * URL was refused or could not be reached, 2 for any other ending, 130 when
 * interrupted.
 */
export function runBridge(opts: BridgeOptions): Promise<number> {
  const { url, mode, input, output, say } = opts;
  return new Promise((resolve) => {
    let done = false;
    let opened = false;
    /** This end is closing the stream itself: after --send, or interrupted. */
    let own: 'sent' | 'interrupted' | null = null;
    let drain: NodeJS.Timeout | null = null;
    const finish = (status: number): void => {
      if (done) return;
      done = true;
      if (drain) clearInterval(drain);
      opts.signal?.removeEventListener('abort', onAbort);
      input.off('data', onData);
      input.off('end', onEnd);
      if (mode !== 'receive') input.pause();
      // Let what was received reach a pipe or file before the status is given.
      output.write('', () => resolve(status));
    };

    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 });

    const onAbort = (): void => {
      own = 'interrupted';
      if (ws.readyState === WebSocket.OPEN) ws.close(1000);
      else ws.terminate();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    /** Stop reading the input while too much waits to leave. */
    const holdInput = (): void => {
      if (drain || ws.bufferedAmount <= HELD_BYTES) return;
      input.pause();
      drain = setInterval(() => {
        if (ws.bufferedAmount > HELD_BYTES / 4) return;
        clearInterval(drain!);
        drain = null;
        if (!done) input.resume();
      }, 20);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
        ws.send(bytes.subarray(at, at + CHUNK_BYTES), { binary: true });
      }
      holdInput();
    };
    const onEnd = (): void => {
      if (mode !== 'send' || ws.readyState !== WebSocket.OPEN) return;
      // Everything handed to the socket is delivered before the closing.
      own = 'sent';
      ws.close(1000);
    };

    ws.on('open', () => {
      opened = true;
      if (mode === 'receive') return;
      input.on('data', onData);
      input.on('end', onEnd);
      input.resume();
    });
    ws.on('message', (data) => {
      // A slow reader of the output slows the stream.
      if (output.write(toBuffer(data))) return;
      ws.pause();
      output.once('drain', () => ws.resume());
    });
    ws.on('unexpected-response', (_request, response) => {
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
    ws.on('error', (err: Error & { code?: string }) => {
      if (opened || done) return;
      say(`could not connect to the intercom: ${err.message}`);
      finish(1);
    });
    ws.on('close', (code, reasonBytes) => {
      if (done) return;
      if (!opened) {
        // Refused or unreachable: said already, or about to be.
        setTimeout(() => finish(1), 50).unref();
        return;
      }
      const reason = reasonBytes.toString('utf8');
      if (own === 'interrupted') {
        say('interrupted; the stream is closed');
        finish(130);
      } else if (own === 'sent') {
        say('everything was sent; the stream is closed');
        finish(0);
      } else if (reason === 'peer-closed') {
        say(REASONS[reason]!);
        finish(0);
      } else {
        say(
          REASONS[reason] ??
            (code === 1006
              ? 'the connection to the intercom was lost'
              : `the stream was closed (${reason || code})`),
        );
        finish(2);
      }
    });
  });
}
