import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { BridgeError, CHUNK_BYTES, checkStreamUrl, runBridge } from '../src/stream/bridge.js';
import { STREAM_OPTIONS } from '../src/stream-options.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const program = path.join(root, 'dist', 'stream-cli.js');

/**
 * A stand-in for the stream endpoint of an intercom: every stream has two
 * ends, and what one end sends the other gets. It relays like the real one:
 * the first end is held until the second comes, and when one closes the
 * other is closed with "peer-closed".
 */
interface Relay {
  url: string;
  /** The URLs of a new stream's two ends. */
  stream(): { a: string; b: string };
  /** Close both ends of every stream, as an administrator would. */
  cut(code: number, reason: string): void;
  /** The sizes of the messages that arrived, to see how they were cut. */
  sizes: number[];
  close(): Promise<void>;
}

async function startRelay(): Promise<Relay> {
  const wss = new WebSocketServer({ noServer: true });
  const ends = new Map<string, { peer: string; ws?: WebSocket; held: Buffer[]; used: boolean }>();
  const sizes: number[] = [];
  const server = http.createServer((_req, res) => {
    res
      .writeHead(426, { 'Content-Type': 'text/plain' })
      .end('A stream URL is opened as a WebSocket.\n');
  });
  server.on('upgrade', (req, socket, head) => {
    const token = (req.url ?? '').replace('/mcp/stream/', '');
    const end = ends.get(token);
    const refuse = (status: string, body: string): void => {
      socket.write(
        `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      socket.destroy();
    };
    if (!end) return refuse('404 Not Found', 'There is no such stream URL.\n');
    if (end.used) return refuse('410 Gone', 'This stream URL was used already.\n');
    end.used = true;
    wss.handleUpgrade(req, socket, head, (ws) => {
      end.ws = ws;
      const peer = ends.get(end.peer)!;
      for (const m of peer.held.splice(0)) ws.send(m, { binary: true });
      ws.on('message', (data) => {
        const bytes = data as Buffer;
        sizes.push(bytes.length);
        if (peer.ws) peer.ws.send(bytes, { binary: true });
        else end.held.push(bytes);
      });
      ws.on('close', () => {
        end.ws = undefined;
        peer.ws?.close(1000, 'peer-closed');
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    stream() {
      const a = randomBytes(24).toString('base64url');
      const b = randomBytes(24).toString('base64url');
      ends.set(a, { peer: b, held: [], used: false });
      ends.set(b, { peer: a, held: [], used: false });
      return { a: `${url}/mcp/stream/${a}`, b: `${url}/mcp/stream/${b}` };
    },
    cut(code, reason) {
      for (const end of ends.values()) end.ws?.close(code, reason);
    },
    sizes,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let relay: Relay;
let tmp: string;

beforeEach(async () => {
  relay = await startRelay();
  tmp = await mkdtemp(path.join(tmpdir(), 'tai-stream-'));
});
afterEach(async () => {
  await relay.close();
  await rm(tmp, { recursive: true, force: true });
});

/** One end run in this process, with what it was told and what it wrote. */
function bridge(url: string, mode: 'send' | 'receive' | 'both') {
  const input = new PassThrough();
  const output = new PassThrough();
  const said: string[] = [];
  const got: Buffer[] = [];
  output.on('data', (chunk: Buffer) => got.push(chunk));
  const stop = new AbortController();
  const status = runBridge({
    url: checkStreamUrl(url),
    mode,
    input,
    output,
    say: (message) => said.push(message),
    signal: stop.signal,
  });
  return { input, said, status, stop, received: () => Buffer.concat(got) };
}

describe('the URL of an end', () => {
  it('is a WebSocket URL of a stream, however it is written', () => {
    const code = 'a'.repeat(43);
    expect(checkStreamUrl(`wss://intercom.example.com/mcp/stream/${code}`).href).toBe(
      `wss://intercom.example.com/mcp/stream/${code}`,
    );
    expect(checkStreamUrl(` https://intercom.example.com/mcp/stream/${code}\n`).protocol).toBe(
      'wss:',
    );
    expect(checkStreamUrl(`http://localhost:8080/mcp/stream/${code}`).protocol).toBe('ws:');
    expect(checkStreamUrl(`wss://intercom.example.com/base/mcp/stream/${code}`).pathname).toBe(
      `/base/mcp/stream/${code}`,
    );
  });

  it('is refused when it is something else, before anything is sent', () => {
    const code = 'a'.repeat(43);
    for (const [url, why] of [
      ['not a url', /not a URL/],
      [`ws://intercom.example.com/mcp/stream/${code}`, /must be a wss:\/\/ URL/],
      [`wss://intercom.example.com/mcp/join/${code}`, /not the URL of an end of a stream/],
      [`wss://intercom.example.com/mcp/stream/short`, /not the URL of an end of a stream/],
      [`wss://intercom.example.com/mcp/stream/${code}?x=1`, /not the URL of an end of a stream/],
      [`wss://user:pw@intercom.example.com/mcp/stream/${code}`, /not the URL of an end/],
    ] as const) {
      expect(() => checkStreamUrl(url), url).toThrow(BridgeError);
      expect(() => checkStreamUrl(url), url).toThrow(why);
    }
  });
});

describe('an end in a program', () => {
  it('sends its input and closes; the other end receives it all and ends', async () => {
    const { a, b } = relay.stream();
    const sent = randomBytes(1024 * 1024 + 123);
    const receiver = bridge(b, 'receive');
    const sender = bridge(a, 'send');
    sender.input.end(sent);
    expect(await sender.status).toBe(0);
    expect(await receiver.status).toBe(0);
    expect(receiver.received().equals(sent)).toBe(true);
    expect(sender.said).toEqual(['everything was sent; the stream is closed']);
    expect(receiver.said).toEqual(['the other end closed the stream']);
    expect(Math.max(...relay.sizes)).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it('delivers what was sent before the other end came', async () => {
    const { a, b } = relay.stream();
    const sender = bridge(a, 'both');
    sender.input.write('early ');
    await new Promise((r) => setTimeout(r, 100));
    const receiver = bridge(b, 'receive');
    sender.input.write('bird');
    await new Promise((r) => setTimeout(r, 100));
    expect(receiver.received().toString()).toBe('early bird');
    sender.stop.abort();
    expect(await sender.status).toBe(130);
    expect(await receiver.status).toBe(0);
  });

  it('does not read its input with --receive, and does not end when the input does', async () => {
    const { a, b } = relay.stream();
    const receiver = bridge(b, 'receive');
    receiver.input.write('must not be sent');
    receiver.input.end();
    const both = bridge(a, 'both');
    both.input.write('one way');
    // The end of the input of a two-way end does not close the stream.
    both.input.end();
    await new Promise((r) => setTimeout(r, 150));
    expect(receiver.received().toString()).toBe('one way');
    expect(both.received().toString()).toBe('');
    let ended = false;
    void both.status.then(() => (ended = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(ended).toBe(false);
    receiver.stop.abort();
    expect(await both.status).toBe(0);
  });

  it('says why the intercom closed the stream, and that it was not a normal end', async () => {
    const { a, b } = relay.stream();
    const one = bridge(a, 'both');
    const two = bridge(b, 'both');
    await new Promise((r) => setTimeout(r, 100));
    relay.cut(4011, 'closed-by-administrator');
    expect(await one.status).toBe(2);
    expect(await two.status).toBe(2);
    expect(one.said).toEqual(['the stream was disconnected by an administrator of the intercom']);
  });

  it('gives the reason of a refused URL, and of an intercom that is not there', async () => {
    const { a } = relay.stream();
    const first = bridge(a, 'receive');
    await new Promise((r) => setTimeout(r, 100));
    const again = bridge(a, 'receive');
    expect(await again.status).toBe(1);
    expect(again.said[0]).toMatch(/refused the URL \(410\): This stream URL was used already/);
    expect(again.said.join(' ')).not.toContain('/mcp/stream/');
    const unknown = bridge(`${relay.url}/mcp/stream/${'x'.repeat(32)}`, 'send');
    expect(await unknown.status).toBe(1);
    expect(unknown.said[0]).toMatch(/\(404\)/);
    const nowhere = bridge(`ws://127.0.0.1:1/mcp/stream/${'x'.repeat(32)}`, 'send');
    expect(await nowhere.status).toBe(1);
    expect(nowhere.said[0]).toMatch(/could not connect to the intercom/);
    first.stop.abort();
    await first.status;
  });
});

describe('tr-ai-intercom-stream', () => {
  const run = (
    args: string[],
    opts: { stdin?: Buffer | 'none' } = {},
  ): Promise<{ status: number | null; stdout: Buffer; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [program, ...args], {
        stdio: [opts.stdin === 'none' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      let err = '';
      child.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString()));
      if (opts.stdin instanceof Buffer) child.stdin!.end(opts.stdin);
      child.on('close', (status) => resolve({ status, stdout: Buffer.concat(out), stderr: err }));
    });

  it('carries a file from one command to another', async () => {
    const { a, b } = relay.stream();
    const sent = randomBytes(300_000);
    writeFileSync(path.join(tmp, 'in'), sent);
    // The receiver has no standard input at all, like a command an agent runs in the background.
    const receiving = run(['--receive', b], { stdin: 'none' });
    await new Promise((r) => setTimeout(r, 300));
    const sending = run(['--send', a], { stdin: readFileSync(path.join(tmp, 'in')) });
    const [received, sender] = await Promise.all([receiving, sending]);
    expect(sender.status).toBe(0);
    expect(received.status).toBe(0);
    expect(received.stdout.equals(sent)).toBe(true);
    expect(sender.stderr).toBe(
      'tr-ai-intercom-stream: everything was sent; the stream is closed\n',
    );
    expect(received.stderr).toBe('tr-ai-intercom-stream: the other end closed the stream\n');
    expect(sender.stderr + received.stderr).not.toContain('/mcp/stream/');
  });

  it('refuses a URL that is not of a stream, and a refused one, with status 1', async () => {
    const bad = await run(['--send', 'https://intercom.example.com/mcp'], {
      stdin: Buffer.from('x'),
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/not the URL of an end of a stream/);
    const gone = await run(['--receive', `${relay.url}/mcp/stream/${'y'.repeat(32)}`], {
      stdin: 'none',
    });
    expect(gone.status).toBe(1);
    expect(gone.stderr).toMatch(/refused the URL \(404\)/);
  });

  it('wants exactly one URL and at most one of --send and --receive', async () => {
    expect((await run([], { stdin: 'none' })).status).not.toBe(0);
    const { a } = relay.stream();
    expect((await run(['--send', '--receive', a], { stdin: 'none' })).status).not.toBe(0);
    const help = await run(['--help'], { stdin: 'none' });
    const text = help.stdout.toString() + help.stderr;
    expect(text).toContain('tr-ai-intercom-stream [<opt> ...] <url>');
    expect(text).toContain('--receive');
    expect(text).toContain('Status 0');
  });

  it('names an environment variable for each option, after its name', () => {
    for (const def of STREAM_OPTIONS) {
      const name = def.longName as string;
      expect(def.environment).toBe(`INTERCOM_STREAM_OPT_${name.toUpperCase().replace(/-/g, '_')}`);
    }
  });
});
