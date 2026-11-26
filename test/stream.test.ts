import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  BridgeError,
  CHUNK_BYTES,
  checkStreamUrl,
  parseLocalAddress,
  runBridge,
  type PortSide,
} from '../src/stream/bridge.js';
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
  const ends = new Map<
    string,
    { peer: string; ws?: WebSocket; held: Buffer[]; used: boolean; gone: boolean; dead: boolean }
  >();
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
    if (!end || end.dead) return refuse('404 Not Found', 'There is no such stream URL.\n');
    if (end.used) return refuse('410 Gone', 'This stream URL was used already.\n');
    end.used = true;
    wss.handleUpgrade(req, socket, head, (ws) => {
      end.ws = ws;
      const peer = ends.get(end.peer)!;
      for (const m of peer.held.splice(0)) ws.send(m, { binary: true });
      // The other end sent what it had and left: that is all there is.
      if (peer.gone) return ws.close(1000, 'peer-closed');
      ws.on('message', (data) => {
        const bytes = data as Buffer;
        sizes.push(bytes.length);
        if (peer.ws) peer.ws.send(bytes, { binary: true });
        else end.held.push(bytes);
      });
      ws.on('close', () => {
        end.ws = undefined;
        end.gone = true;
        if (peer.ws) peer.ws.close(1000, 'peer-closed');
        // Nothing waits for the other end: the stream is over, and its URL with it.
        else if (end.held.length === 0) peer.dead = true;
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
      ends.set(a, { peer: b, held: [], used: false, gone: false, dead: false });
      ends.set(b, { peer: a, held: [], used: false, gone: false, dead: false });
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
/** What a test opened and the end of the test closes. */
const opened: (() => void)[] = [];

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(what: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('waited in vain');
    await wait(10);
  }
}

/** A TCP server on this machine: it may greet whoever connects, echo, or hang up after the greeting. */
async function tcpServer(opts: { greeting?: string; echo?: boolean; hangUp?: boolean } = {}) {
  const state = { port: 0, connections: 0, closed: 0, received: Buffer.alloc(0) };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    state.connections++;
    sockets.add(s);
    s.on('error', () => undefined);
    s.on('close', () => {
      state.closed++;
      sockets.delete(s);
    });
    s.on('data', (chunk: Buffer) => (state.received = Buffer.concat([state.received, chunk])));
    if (opts.greeting) s.write(opts.greeting);
    if (opts.hangUp) s.end();
    else if (opts.echo) s.pipe(s);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  opened.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return state;
}

/** A program that connects to a port, with what it got. */
async function tcpClient(port: number) {
  const got: Buffer[] = [];
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.on('data', (chunk: Buffer) => got.push(chunk));
  const ended = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  opened.push(() => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.on('error', () => undefined);
  return { socket, ended, received: () => Buffer.concat(got) };
}

/** One end on a port, run in this process. */
function portBridge(url: string, port: PortSide) {
  const said: string[] = [];
  const stop = new AbortController();
  let tell: (port: number) => void = () => undefined;
  /** The port a listening end got. */
  const listening = new Promise<number>((resolve) => (tell = resolve));
  const status = runBridge({
    url: checkStreamUrl(url),
    port,
    say: (message) => {
      said.push(message);
      const at = /^listening on 127\.0\.0\.1:(\d+)/.exec(message);
      if (at) tell(Number(at[1]));
    },
    signal: stop.signal,
  });
  opened.push(() => stop.abort());
  return { said, status, stop, listening };
}
const here = (port: number): { host: string; port: number } => ({ host: '127.0.0.1', port });

beforeEach(async () => {
  relay = await startRelay();
  tmp = await mkdtemp(path.join(tmpdir(), 'tai-stream-'));
});
afterEach(async () => {
  for (const close of opened.splice(0)) close();
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

describe('an end on a port', () => {
  it('reads a port, or an address and a port', () => {
    expect(parseLocalAddress('2222', 'listen')).toEqual({ host: '127.0.0.1', port: 2222 });
    expect(parseLocalAddress(' 0 ', 'listen')).toEqual({ host: '127.0.0.1', port: 0 });
    expect(parseLocalAddress('0.0.0.0:8022', 'listen')).toEqual({ host: '0.0.0.0', port: 8022 });
    expect(parseLocalAddress('[::1]:22', 'connect')).toEqual({ host: '::1', port: 22 });
    expect(parseLocalAddress('db.example.com:5432', 'connect')).toEqual({
      host: 'db.example.com',
      port: 5432,
    });
    for (const [text, option] of [
      ['', 'listen'],
      ['ssh', 'connect'],
      ['127.0.0.1', 'listen'],
      ['::1:22', 'connect'],
      ['127.0.0.1:70000', 'listen'],
      ['0', 'connect'],
      ['127.0.0.1:22/x', 'connect'],
    ] as const) {
      expect(() => parseLocalAddress(text, option), text).toThrow(BridgeError);
      expect(() => parseLocalAddress(text, option), text).toThrow(`--${option} takes a port`);
    }
  });

  it('puts a client and a server on a stream', async () => {
    const greeting = 'hello from the server\n';
    const server = await tcpServer({ greeting, echo: true });
    const { a, b } = relay.stream();
    const far = portBridge(a, { connect: here(server.port) });
    const near = portBridge(b, { listen: here(0) });
    const port = await near.listening;
    // An end on --connect connects to its server as soon as its end of the stream is open.
    await until(() => server.connections === 1);
    const client = await tcpClient(port);
    // The server speaks first; the client has sent nothing.
    await until(() => client.received().toString() === greeting);
    expect(server.connections).toBe(1);
    const sent = randomBytes(300_000);
    client.socket.write(sent);
    await until(() => client.received().length === greeting.length + sent.length);
    expect(client.received().subarray(greeting.length).equals(sent)).toBe(true);
    // The client ends its connection: the stream is closed, and the server's connection with it.
    client.socket.end();
    expect(await near.status).toBe(0);
    expect(await far.status).toBe(0);
    expect(near.said.at(-1)).toBe(
      'the program on the port ended its connection; the stream is closed',
    );
    expect(far.said).toEqual(['the other end closed the stream']);
    await until(() => server.closed === 1);
    await client.ended;
    expect(Math.max(...relay.sizes)).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it('lets the first program in and nobody after it', async () => {
    const { a, b } = relay.stream();
    const near = portBridge(b, { listen: here(0) });
    const other = bridge(a, 'both');
    const port = await near.listening;
    const first = await tcpClient(port);
    first.socket.write('first');
    await until(() => other.received().toString() === 'first');
    await expect(tcpClient(port)).rejects.toThrow(/ECONNREFUSED/);
    other.input.write('still yours');
    await until(() => first.received().toString() === 'still yours');
    // The other end closes: the program's connection is ended after it got everything.
    other.stop.abort();
    expect(await near.status).toBe(0);
    await first.ended;
    expect(near.said.at(-1)).toBe('the other end closed the stream');
  });

  it('keeps what arrived for a program that connects later, also after the other end left', async () => {
    const { a, b } = relay.stream();
    const near = portBridge(b, { listen: here(0) });
    const port = await near.listening;
    await wait(100);
    const sender = bridge(a, 'send');
    sender.input.end('kept for later');
    expect(await sender.status).toBe(0);
    await until(() => near.said.length === 2);
    expect(near.said[1]).toBe(
      'the other end closed the stream; what it sent is kept for the program that connects to the port',
    );
    const client = await tcpClient(port);
    await client.ended;
    expect(client.received().toString()).toBe('kept for later');
    expect(await near.status).toBe(0);
  });

  it('gives what a server says first to an end that only receives', async () => {
    const server = await tcpServer({ greeting: 'the whole log\n', hangUp: true });
    const { a, b } = relay.stream();
    const far = portBridge(a, { connect: here(server.port) });
    await until(() => server.closed === 1);
    // What the server said is kept for the end that comes afterwards.
    const receiver = bridge(b, 'receive');
    expect(await receiver.status).toBe(0);
    expect(receiver.received().toString()).toBe('the whole log\n');
    expect(await far.status).toBe(0);
    expect(far.said).toEqual([
      'the program on the port ended its connection; the stream is closed',
    ]);
  });

  it('carries a file into a port', async () => {
    const server = await tcpServer();
    const { a, b } = relay.stream();
    const far = portBridge(a, { connect: here(server.port) });
    const sender = bridge(b, 'send');
    const sent = randomBytes(200_000);
    sender.input.end(sent);
    expect(await sender.status).toBe(0);
    expect(await far.status).toBe(0);
    await until(() => server.closed === 1);
    expect(server.received.equals(sent)).toBe(true);
  });

  it('fails with status 1 when the port cannot be had, and has not used the URL', async () => {
    const busy = await tcpServer();
    const { a, b } = relay.stream();
    const near = portBridge(b, { listen: here(busy.port) });
    expect(await near.status).toBe(1);
    expect(near.said).toEqual([
      `could not listen on 127.0.0.1:${busy.port}: the port is in use; the URL of the stream was not used`,
    ]);
    const again = bridge(b, 'receive');
    const sender = bridge(a, 'send');
    sender.input.end('the URL still works');
    expect(await again.status).toBe(0);
    expect(again.received().toString()).toBe('the URL still works');
  });

  it('fails with status 1 when nothing listens where it should connect, and closes the stream', async () => {
    const gone = await tcpServer();
    for (const close of opened.splice(0)) close();
    await wait(50);
    const { a, b } = relay.stream();
    const other = bridge(b, 'both');
    await wait(100);
    const far = portBridge(a, { connect: here(gone.port) });
    expect(await far.status).toBe(1);
    expect(far.said).toEqual([
      `could not connect to 127.0.0.1:${gone.port}: nothing listens there; the stream is closed`,
    ]);
    expect(await other.status).toBe(0);
  });

  it('says so when it listens where others can reach it, and ends when interrupted', async () => {
    const { b } = relay.stream();
    const said: string[] = [];
    const stop = new AbortController();
    const status = runBridge({
      url: checkStreamUrl(b),
      port: { listen: { host: '0.0.0.0', port: 0 } },
      say: (message) => said.push(message),
      signal: stop.signal,
    });
    await until(() => said.length === 1);
    expect(said[0]).toMatch(
      /^listening on 0\.0\.0\.0:\d+; the first program that connects is on the stream, and it may be any program that can reach this address/,
    );
    await wait(100);
    stop.abort();
    expect(await status).toBe(130);
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

  it('puts a port on each end: a client reaches a server through two commands', async () => {
    const server = await tcpServer({ echo: true });
    const { a, b } = relay.stream();
    const far = run(['--connect', String(server.port), a], { stdin: 'none' });
    const child = spawn(process.execPath, [program, '--listen', '0', b], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    opened.push(() => child.kill());
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const near = new Promise<number | null>((resolve) => child.on('close', resolve));
    await until(() => /listening on 127\.0\.0\.1:\d+/.test(err), 5000);
    const client = await tcpClient(Number(/listening on 127\.0\.0\.1:(\d+)/.exec(err)![1]));
    client.socket.write('through two commands');
    await until(() => client.received().toString() === 'through two commands');
    client.socket.end();
    expect(await near).toBe(0);
    const farEnd = await far;
    expect(farEnd.status).toBe(0);
    expect(farEnd.stderr).toBe('tr-ai-intercom-stream: the other end closed the stream\n');
    expect(err).toMatch(/the program on the port ended its connection; the stream is closed\n$/);
    expect(err + farEnd.stderr).not.toContain('/mcp/stream/');
  });

  it('wants one of standard input and output, --listen and --connect, and a port it can read', async () => {
    const { a } = relay.stream();
    for (const args of [
      ['--listen', '2222', '--connect', '22', a],
      ['--listen', '2222', '--send', a],
      ['--connect', '22', '--receive', a],
    ]) {
      expect((await run(args, { stdin: 'none' })).status, args.join(' ')).not.toBe(0);
    }
    const bad = await run(['--connect', 'sshd', a], { stdin: 'none' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/--connect takes a port, an address and a port, or the path/);
    // Nothing of that used the URL.
    const receiving = run(['--receive', a], { stdin: 'none' });
    await wait(300);
    relay.cut(1000, 'peer-closed');
    expect((await receiving).status).toBe(0);
  });

  it('wants exactly one URL and at most one of --send and --receive', async () => {
    expect((await run([], { stdin: 'none' })).status).not.toBe(0);
    const { a } = relay.stream();
    expect((await run(['--send', '--receive', a], { stdin: 'none' })).status).not.toBe(0);
    const help = await run(['--help'], { stdin: 'none' });
    const text = help.stdout.toString() + help.stderr;
    expect(text).toContain('tr-ai-intercom-stream [<opt> ...] [<url>]');
    expect(text).toContain('--receive');
    expect(text).toContain('--listen');
    expect(text).toContain('--connect');
    expect(text).toContain('Status 0');
  });

  it('names an environment variable for each option, after its name', () => {
    for (const def of STREAM_OPTIONS) {
      const name = def.longName as string;
      expect(def.environment).toBe(`INTERCOM_STREAM_OPT_${name.toUpperCase().replace(/-/g, '_')}`);
    }
  });
});
