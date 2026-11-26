import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { runServe, type ServeTimings } from '../src/serve/serve.js';
import { SERVE_OPTIONS } from '../src/serve-options.js';
import {
  BridgeError,
  checkControlUrl,
  checkEndUrl,
  parseLocalTarget,
  readUrlFile,
  runBridge,
  runListener,
  type LocalTarget,
} from '../src/stream/bridge.js';
import { startFakeService, type FakeService } from './fake-service.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const serveProgram = path.join(root, 'dist', 'serve-cli.js');
const streamProgram = path.join(root, 'dist', 'stream-cli.js');

let fake: FakeService;
let tmp: string;
/** What a test opened and the end of the test closes. */
const opened: (() => void)[] = [];

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(what: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('waited in vain');
    await wait(10);
  }
}

/** A server on this machine: it may greet whoever connects, and echoes. */
async function tcpServer(opts: { greeting?: string; at?: string } = {}) {
  const state = { port: 0, connections: 0, closed: 0 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    state.connections++;
    sockets.add(s);
    s.on('error', () => undefined);
    s.on('close', () => {
      state.closed++;
      sockets.delete(s);
    });
    if (opts.greeting) s.write(opts.greeting);
    s.pipe(s);
  });
  await new Promise<void>((resolve) =>
    opts.at ? server.listen(opts.at, resolve) : server.listen(0, '127.0.0.1', resolve),
  );
  if (!opts.at) state.port = (server.address() as AddressInfo).port;
  opened.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return state;
}

/** A port on this machine that nothing listens on. */
async function deadPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const QUICK: ServeTimings = { firstRetryMs: 60, retryMs: 120, replacedMs: 500, helloMs: 2000 };

/** A serving side run in this process. */
function serve(
  target: LocalTarget,
  opts: { quiet?: boolean; timings?: Partial<ServeTimings> } = {},
) {
  const said: string[] = [];
  const stop = new AbortController();
  const status = runServe({
    url: checkControlUrl(fake.controlUrl),
    target,
    say: (message) => said.push(message),
    quiet: opts.quiet ?? false,
    signal: stop.signal,
    timings: { ...QUICK, ...opts.timings },
  });
  opened.push(() => stop.abort());
  return { said, status, stop };
}

/** A client of the service as a WebSocket, with what it got or how it was turned away. */
function client(url = fake.endpointUrl) {
  const ws = new WebSocket(url);
  opened.push(() => ws.terminate());
  const got: Buffer[] = [];
  ws.on('message', (data) => got.push(data as Buffer));
  ws.on('error', () => undefined);
  const outcome = new Promise<{ open: true } | { open: false; status: number; body: string }>(
    (resolve) => {
      ws.on('open', () => resolve({ open: true }));
      ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ open: false, status: res.statusCode ?? 0, body }));
      });
    },
  );
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  return { ws, outcome, closed, received: () => Buffer.concat(got) };
}

/** A program that connects to a port. */
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

const here = (port: number): LocalTarget => ({ host: '127.0.0.1', port });

beforeEach(async () => {
  fake = await startFakeService();
  tmp = await mkdtemp(path.join(tmpdir(), 'tai-serve-'));
});
afterEach(async () => {
  for (const close of opened.splice(0)) close();
  await fake.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('the URLs of a stream service', () => {
  const code = 'a'.repeat(43);
  it('are told apart by their paths', () => {
    expect(checkEndUrl(`wss://intercom.example.com/mcp/stream/${code}`).kind).toBe('stream');
    const service = checkEndUrl(` https://intercom.example.com/mcp/service/${code}\n`);
    expect(service.kind).toBe('service');
    expect(service.url.href).toBe(`wss://intercom.example.com/mcp/service/${code}`);
    expect(checkControlUrl(`https://intercom.example.com/mcp/control/${code}`).href).toBe(
      `wss://intercom.example.com/mcp/control/${code}`,
    );
    expect(checkControlUrl(`http://localhost:8080/mcp/control/${code}`).protocol).toBe('ws:');
  });

  it('are refused where they do not belong, with what to use instead', () => {
    expect(() => checkEndUrl(`wss://intercom.example.com/mcp/control/${code}`)).toThrow(
      /control URL of a stream service.*tr-ai-intercom-serve/,
    );
    expect(() => checkControlUrl(`wss://intercom.example.com/mcp/service/${code}`)).toThrow(
      /for its clients.*the control URL/,
    );
    expect(() => checkControlUrl(`wss://intercom.example.com/mcp/stream/${code}`)).toThrow(
      /not the control URL/,
    );
    expect(() => checkControlUrl(`ws://intercom.example.com/mcp/control/${code}`)).toThrow(
      /must be a wss:\/\/ URL/,
    );
    expect(() => checkControlUrl(`wss://intercom.example.com/mcp/control/${code}?x=1`)).toThrow(
      BridgeError,
    );
    expect(() => checkControlUrl('nonsense')).toThrow(/not a URL/);
  });

  it('are read from a file that is its owner’s alone', () => {
    const file = path.join(tmp, 'control.url');
    writeFileSync(file, `wss://intercom.example.com/mcp/control/${code}\n`, { mode: 0o600 });
    expect(readUrlFile(file)).toBe(`wss://intercom.example.com/mcp/control/${code}`);
    chmodSync(file, 0o644);
    expect(() => readUrlFile(file)).toThrow(/can be read by others \(mode 644\).*chmod 600/);
    chmodSync(file, 0o600);
    writeFileSync(file, 'two words');
    expect(() => readUrlFile(file)).toThrow(/one URL and nothing else/);
    expect(() => readUrlFile(path.join(tmp, 'missing'))).toThrow(/could not be read/);
  });

  it('go to a port, an address and a port, or a local domain socket', () => {
    expect(parseLocalTarget('22')).toEqual({ host: '127.0.0.1', port: 22 });
    expect(parseLocalTarget('build.example.com:22')).toEqual({
      host: 'build.example.com',
      port: 22,
    });
    expect(parseLocalTarget('/run/postgresql/.s.PGSQL.5432')).toEqual({
      path: '/run/postgresql/.s.PGSQL.5432',
    });
    expect(parseLocalTarget('./x.sock')).toEqual({ path: './x.sock' });
    expect(() => parseLocalTarget('sshd')).toThrow(/local domain socket/);
  });
});

describe('the serving side', () => {
  it('says hello and connects every client to its server', async () => {
    const server = await tcpServer({ greeting: 'ready\n' });
    const s = serve(here(server.port));
    await until(() => fake.serving());
    expect(s.said).toEqual([
      `serving sv_Test0001: every client of the stream service is connected to 127.0.0.1:${server.port}`,
    ]);

    const one = client();
    expect(await one.outcome).toEqual({ open: true });
    // The server spoke first; the client had sent nothing.
    await until(() => one.received().toString() === 'ready\n');
    const sent = randomBytes(200_000);
    one.ws.send(sent);
    await until(() => one.received().length === 6 + sent.length);
    expect(one.received().subarray(6).equals(sent)).toBe(true);
    expect(server.connections).toBe(1);

    one.ws.close();
    await until(() => server.closed === 1);
    await until(() => s.said.length === 3);
    expect(s.said[1]).toBe(`cn_00000001 from 203.0.113.7: connected to 127.0.0.1:${server.port}`);
    expect(s.said[2]).toMatch(
      /^cn_00000001 from 203\.0\.113\.7: ended after [\d.]+ m?s, 195\.3 KB to the client, 195\.3 KB from it \(the client closed\)$/,
    );
    expect(s.said.join('\n')).not.toMatch(/\/mcp\//);
  });

  it('serves several clients at once, each on a connection of its own to the server', async () => {
    const server = await tcpServer();
    const s = serve(here(server.port), { quiet: true });
    await until(() => fake.serving());
    const clients = [client(), client(), client()];
    for (const c of clients) expect(await c.outcome).toEqual({ open: true });
    clients.forEach((c, i) => c.ws.send(`from ${i}`));
    for (const [i, c] of clients.entries()) {
      await until(() => c.received().toString() === `from ${i}`);
    }
    expect(server.connections).toBe(3);
    // The server ends one of them: its client is closed, the others go on.
    clients[1]!.ws.close();
    await until(() => server.closed === 1);
    clients[0]!.ws.send(' again');
    await until(() => clients[0]!.received().toString() === 'from 0 again');
    // With --quiet, connections that go as they should are not worth a line.
    expect(s.said).toHaveLength(1);
  });

  it('refuses a client when the server cannot be reached, with the reason', async () => {
    const port = await deadPort();
    const s = serve(here(port));
    await until(() => fake.serving());
    const one = client();
    expect(await one.outcome).toEqual({
      open: false,
      status: 502,
      body: 'The server of this stream service refused the connection: the server could not be reached: nothing listens there\n',
    });
    await until(() => s.said.length === 2);
    expect(s.said[1]).toBe(
      `cn_00000001 from 203.0.113.7: refused, nothing listens there (127.0.0.1:${port})`,
    );
    expect(fake.refusals).toEqual(['the server could not be reached: nothing listens there']);
  });

  it('connects to a local domain socket', async () => {
    const at = path.join(tmp, 'server.sock');
    const server = await tcpServer({ at });
    const s = serve({ path: at });
    await until(() => fake.serving());
    expect(s.said[0]).toContain(`is connected to ${at}`);
    const one = client();
    expect(await one.outcome).toEqual({ open: true });
    one.ws.send('over the socket');
    await until(() => one.received().toString() === 'over the socket');
    expect(server.connections).toBe(1);
    // A socket that is not there refuses the client.
    const none = serve({ path: path.join(tmp, 'missing.sock') });
    await until(() => fake.served === 2);
    const two = client();
    expect(await two.outcome).toMatchObject({ open: false, status: 502 });
    await until(() => none.said.some((line) => /refused, there is no such socket/.test(line)));
  });

  it('says how a connection ended when it was not the client or the server', async () => {
    const server = await tcpServer();
    const s = serve(here(server.port));
    await until(() => fake.serving());
    const one = client();
    await one.outcome;
    fake.cut(4011, 'closed-by-administrator');
    await until(() => s.said.length === 3);
    expect(s.said[2]).toMatch(
      /ended after .* \(the stream was disconnected by an administrator of the intercom\)$/,
    );
    await until(() => server.closed === 1);
  });

  it('opens its control socket again when it is lost, and what runs goes on', async () => {
    const server = await tcpServer();
    const s = serve(here(server.port));
    await until(() => fake.serving());
    const one = client();
    await one.outcome;
    fake.closeControl(1001, 'server-shutdown');
    await until(() => fake.served === 2);
    expect(
      s.said.some((line) => /control socket was closed \(the intercom stopped\)/.test(line)),
    ).toBe(true);
    one.ws.send('still here');
    await until(() => one.received().toString() === 'still here');
    const two = client();
    expect(await two.outcome).toEqual({ open: true });
  });

  it('keeps trying while the service is closed for now, and says so once', async () => {
    fake.mode = 'dark';
    const server = await tcpServer();
    const s = serve(here(server.port));
    await wait(400);
    expect(s.said).toEqual([
      'the intercom refused the control URL (403): Closed for now.; trying again every 120 ms',
    ]);
    fake.mode = 'ok';
    await until(() => fake.serving());
    expect(await client().outcome).toEqual({ open: true });
  });

  it('gives up when the control URL is of no use any more', async () => {
    const server = await tcpServer();
    fake.mode = 'gone';
    const unknown = serve(here(server.port));
    expect(await unknown.status).toBe(1);
    expect(unknown.said).toEqual([
      'the intercom does not know this control URL (404): No such control URL.',
    ]);

    fake.mode = 'ok';
    for (const [code, reason, words] of [
      [4017, 'url-renewed', /control URL of the stream service was renewed/],
      [4016, 'service-ended', /stream service was removed/],
    ] as const) {
      const before = fake.served;
      const s = serve(here(server.port));
      await until(() => fake.served === before + 1);
      fake.closeControl(code, reason);
      expect(await s.status).toBe(1);
      expect(s.said.at(-1)).toMatch(words);
      expect(s.said.at(-1)).toMatch(/of no use any more/);
    }
  });

  it('waits long after another serving side took the service over', async () => {
    const server = await tcpServer();
    const first = serve(here(server.port), { timings: { replacedMs: 400 } });
    await until(() => fake.served === 1);
    const second = serve(here(server.port), { timings: { replacedMs: 60_000 } });
    await until(() => fake.served === 2);
    await until(() => first.said.some((line) => /another serving side connected/.test(line)));
    // Not at once, or the two would take the service from each other for ever.
    await wait(200);
    expect(fake.served).toBe(2);
    await until(() => fake.served === 3);
    expect(second.said.some((line) => /not trying again for 1 min/.test(line))).toBe(true);
  });

  it('ends when it is interrupted, and its connections with it', async () => {
    const server = await tcpServer();
    const s = serve(here(server.port));
    await until(() => fake.serving());
    const one = client();
    await one.outcome;
    s.stop.abort();
    expect(await s.status).toBe(130);
    expect((await one.closed).code).toBe(1000);
    await until(() => server.closed === 1);
    await until(() => !fake.serving());
  });
});

describe('a client of a stream service', () => {
  it('is one connection on an input and an output', async () => {
    const server = await tcpServer({ greeting: 'SSH-2.0-test\r\n' });
    serve(here(server.port), { quiet: true });
    await until(() => fake.serving());
    const input = new PassThrough();
    const output = new PassThrough();
    const got: Buffer[] = [];
    output.on('data', (chunk: Buffer) => got.push(chunk));
    const said: string[] = [];
    const stop = new AbortController();
    const status = runBridge({
      url: checkEndUrl(fake.endpointUrl).url,
      mode: 'both',
      input,
      output,
      say: (m) => said.push(m),
      signal: stop.signal,
    });
    await until(() => Buffer.concat(got).toString() === 'SSH-2.0-test\r\n');
    input.write('SSH-2.0-client\r\n');
    await until(() => Buffer.concat(got).toString() === 'SSH-2.0-test\r\nSSH-2.0-client\r\n');
    stop.abort();
    expect(await status).toBe(130);
    await until(() => server.closed === 1);
    // Twice: the URL of a service is not used up.
    const again = new PassThrough();
    const second = runBridge({
      url: checkEndUrl(fake.endpointUrl).url,
      mode: 'send',
      input: again,
      output: new PassThrough(),
      say: () => undefined,
    });
    again.end('and once more');
    expect(await second).toBe(0);
    expect(server.connections).toBe(2);
  });

  it('is a port that stays open: every program that connects gets its own connection', async () => {
    const server = await tcpServer();
    serve(here(server.port), { quiet: true });
    await until(() => fake.serving());
    const said: string[] = [];
    const stop = new AbortController();
    const status = runListener({
      url: checkEndUrl(fake.endpointUrl).url,
      listen: { host: '127.0.0.1', port: 0 },
      say: (m) => said.push(m),
      signal: stop.signal,
    });
    await until(() => said.length === 1);
    expect(said[0]).toMatch(
      /^listening on 127\.0\.0\.1:\d+; every program that connects gets a connection of its own to the stream service$/,
    );
    const port = Number(/:(\d+);/.exec(said[0]!)![1]);
    const programs = [await tcpClient(port), await tcpClient(port), await tcpClient(port)];
    programs.forEach((p, i) => p.socket.write(`program ${i}`));
    for (const [i, p] of programs.entries()) {
      await until(() => p.received().toString() === `program ${i}`);
    }
    expect(server.connections).toBe(3);
    // One ends its connection: the server's side of it is closed; the port stays.
    programs[0]!.socket.end();
    await until(() => server.closed === 1);
    const later = await tcpClient(port);
    later.socket.write('later');
    await until(() => later.received().toString() === 'later');
    // Nothing of that was worth a line.
    expect(said).toHaveLength(1);

    stop.abort();
    expect(await status).toBe(130);
    await later.ended;
    await expect(tcpClient(port)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('disconnects a program whose connection the service does not take, and says why', async () => {
    const said: string[] = [];
    const stop = new AbortController();
    opened.push(() => stop.abort());
    void runListener({
      url: checkEndUrl(fake.endpointUrl).url,
      listen: { host: '127.0.0.1', port: 0 },
      say: (m) => said.push(m),
      signal: stop.signal,
    });
    await until(() => said.length === 1);
    const port = Number(/:(\d+);/.exec(said[0]!)![1]);
    // Nobody serves.
    const program = await tcpClient(port);
    await program.ended;
    expect(program.received().length).toBe(0);
    await until(() => said.length === 2);
    expect(said[1]).toMatch(
      /^127\.0\.0\.1:\d+: the intercom refused the URL \(503\): No server is connected\.$/,
    );
    // The serving side cannot reach its server.
    serve(here(await deadPort()), { quiet: true });
    await until(() => fake.serving());
    const other = await tcpClient(port);
    await other.ended;
    await until(() => said.length === 3);
    expect(said[2]).toMatch(/refused the URL \(502\): .*nothing listens there/);
    expect(said.join('\n')).not.toMatch(/\/mcp\//);
  });
});

describe('the programs', () => {
  const run = (
    program: string,
    args: string[],
  ): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [program, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      child.on('close', (status) => resolve({ status, stdout: out, stderr: err }));
    });

  /** Start a program that keeps running; gives what it writes to standard error. */
  const start = (program: string, args: string[], stdin: 'ignore' | 'pipe' = 'ignore') => {
    const child = spawn(process.execPath, [program, ...args], { stdio: [stdin, 'pipe', 'pipe'] });
    opened.push(() => child.kill('SIGKILL'));
    const state = { err: '', out: Buffer.alloc(0) };
    child.stderr!.on('data', (chunk: Buffer) => (state.err += chunk.toString()));
    child.stdout!.on('data', (chunk: Buffer) => (state.out = Buffer.concat([state.out, chunk])));
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
    return { child, state, exited };
  };

  it('serve and connect: a program reaches a server through the two commands', async () => {
    const server = await tcpServer();
    const controlFile = path.join(tmp, 'control.url');
    const endpointFile = path.join(tmp, 'endpoint.url');
    writeFileSync(controlFile, `${fake.controlUrl}\n`, { mode: 0o600 });
    writeFileSync(endpointFile, `${fake.endpointUrl}\n`, { mode: 0o600 });

    const serving = start(serveProgram, [
      '--connect',
      String(server.port),
      '--url-file',
      controlFile,
    ]);
    await until(() => fake.serving(), 8000);
    const listening = start(streamProgram, ['--listen', '0', '--url-file', endpointFile]);
    await until(() => /listening on 127\.0\.0\.1:\d+/.test(listening.state.err), 8000);
    const port = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(listening.state.err)![1]);
    for (const text of ['first', 'second']) {
      const program = await tcpClient(port);
      program.socket.write(text);
      await until(() => program.received().toString() === text);
      program.socket.end();
      await program.ended;
    }
    await until(() => (serving.state.err.match(/ended after/g) ?? []).length === 2);
    expect(serving.state.err).toMatch(
      /^tr-ai-intercom-serve: serving sv_Test0001: every client of the stream service is connected to 127\.0\.0\.1:\d+\n/,
    );
    expect(serving.state.err).toMatch(
      /cn_00000001 from 203\.0\.113\.7: connected to 127\.0\.0\.1:/,
    );
    expect(serving.state.err).toMatch(/\(the client closed\)/);

    // As a proxy command: one connection on standard input and output, ended with SIGHUP as ssh does.
    const proxy = start(streamProgram, [fake.endpointUrl], 'pipe');
    proxy.child.stdin!.write('through the proxy');
    await until(() => proxy.state.out.toString() === 'through the proxy');
    proxy.child.kill('SIGHUP');
    expect(await proxy.exited).toBe(130);
    await until(() => server.closed === 3);

    listening.child.kill('SIGTERM');
    expect(await listening.exited).toBe(130);
    serving.child.kill('SIGINT');
    expect(await serving.exited).toBe(130);
    // Neither program ever wrote a URL.
    expect(serving.state.err + listening.state.err + proxy.state.err).not.toMatch(/\/mcp\//);
  });

  it('refuse what they cannot work with, with status 1', async () => {
    const file = path.join(tmp, 'control.url');
    writeFileSync(file, `${fake.controlUrl}\n`, { mode: 0o644 });
    const open = await run(serveProgram, ['--connect', '22', '--url-file', file]);
    expect(open.status).toBe(1);
    expect(open.stderr).toMatch(/can be read by others/);
    chmodSync(file, 0o600);
    const both = await run(serveProgram, ['--connect', '22', '--url-file', file, fake.controlUrl]);
    expect(both.status).toBe(1);
    expect(both.stderr).toMatch(/not both/);
    const none = await run(serveProgram, ['--connect', '22']);
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/control URL of the stream service is missing/);
    const wrong = await run(serveProgram, ['--connect', '22', fake.endpointUrl]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toMatch(/for its clients.*control URL/);
    const noTarget = await run(serveProgram, [fake.controlUrl]);
    expect(noTarget.status).not.toBe(0);
    const badTarget = await run(serveProgram, ['--connect', 'sshd', fake.controlUrl]);
    expect(badTarget.status).toBe(1);
    expect(badTarget.stderr).toMatch(/local domain socket/);
    // The clients' program does not take the control URL, nor --connect with a service.
    const control = await run(streamProgram, [fake.controlUrl]);
    expect(control.status).toBe(1);
    expect(control.stderr).toMatch(/tr-ai-intercom-serve/);
    const connect = await run(streamProgram, ['--connect', '22', fake.endpointUrl]);
    expect(connect.status).toBe(1);
    expect(connect.stderr).toMatch(/use --listen.*tr-ai-intercom-serve/s);
    const nothing = await run(streamProgram, []);
    expect(nothing.status).toBe(1);
    expect(nothing.stderr).toMatch(/The URL is missing/);
    // None of that reached the intercom.
    expect(fake.served).toBe(0);
    expect(fake.announced).toEqual([]);
  });

  it('say what they do in their help', async () => {
    const help = await run(serveProgram, ['--help']);
    const text = help.stdout + help.stderr;
    expect(text).toContain('tr-ai-intercom-serve [<opt> ...] [<url>]');
    expect(text).toContain('--connect');
    expect(text).toContain('--url-file');
    expect(text).toContain('Status 1');
  });

  it('name an environment variable for each option, after its name', () => {
    for (const def of SERVE_OPTIONS) {
      const name = def.longName as string;
      expect(def.environment).toBe(`INTERCOM_SERVE_OPT_${name.toUpperCase().replace(/-/g, '_')}`);
    }
  });
});
