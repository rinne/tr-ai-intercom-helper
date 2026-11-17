import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHelper, type RunningHelper } from '../src/helper.js';
import { createLogger, silentLogger } from '../src/logger.js';
import type { Config } from '../src/options.js';
import type { Sink } from '../src/sinks.js';
import type { Notification, Timings } from '../src/wakeup.js';
import { AUTH, sleep, startStub, until, type ServerSocket, type Stub } from './stub.js';

let stub: Stub;
let helper: RunningHelper | undefined;
let base: string;
let got: Notification[];
let logged: string[];

/** Short timings, so that the reconnection rules can be watched. */
const FAST: Partial<Timings> = { retryMs: 400, reopenMs: 100, replacedMs: 1500, silenceMs: 60_000 };

function config(over: Partial<Config> = {}): Config {
  return {
    upstreamUrl: stub.url,
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    socketTimeout: undefined,
    file: undefined,
    dir: undefined,
    tmpDir: undefined,
    url: undefined,
    urlHeader: undefined,
    localSocket: undefined,
    command: undefined,
    listener: false,
    listenerPath: undefined,
    ...over,
  };
}

async function start(over: Partial<Config> = {}, timings: Partial<Timings> = FAST): Promise<void> {
  got = [];
  logged = [];
  const collect: Sink = {
    name: 'collect',
    deliver: async (n) => {
      got.push(n);
    },
  };
  helper = await startHelper({
    config: config(over),
    logger: createLogger('debug', (line) => logged.push(line)),
    sinks: [collect],
    timings,
  });
  base = `http://127.0.0.1:${helper.port}`;
}

/** One request through the helper, as the agent would make it. */
async function request(authorization: string | null = AUTH, path = '/mcp'): Promise<number> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: authorization ? { Authorization: authorization } : {},
    body: '{}',
  });
  await res.text();
  return res.status;
}

/** Make a request and complete the handshake of the socket it leads to. */
async function connected(
  hello: { seq: number; pending: boolean } = { seq: 0, pending: false },
): Promise<ServerSocket> {
  const next = stub.nextSocket();
  await request();
  const socket = await next;
  await socket.hello();
  socket.send({
    message: 'hello',
    seq: hello.seq,
    time: '2026-11-15T12:00:00.000Z',
    data: { pending: hello.pending },
  });
  return socket;
}

const frame = (message: string, seq: number, data: Record<string, unknown> = {}) => ({
  message,
  seq,
  time: `2026-11-15T12:00:${String(seq % 60).padStart(2, '0')}.000Z`,
  data,
});

const state = (): string => helper!.wakeup.status().state;

beforeEach(async () => {
  stub = await startStub();
});
afterEach(async () => {
  await helper?.stop();
  helper = undefined;
  await stub.close();
});

describe('opening the socket', () => {
  it('does nothing until a response names the socket', async () => {
    stub.header = null;
    await start();
    expect(await request()).toBe(200);
    await sleep(150);
    expect(stub.attempts).toEqual([]);
    expect(state()).toBe('unknown');
  });

  it('does not open it for a request that was refused', async () => {
    await start();
    expect(await request('Bearer tai_wrong')).toBe(401);
    expect(await request(null)).toBe(401);
    await sleep(150);
    expect(stub.attempts).toEqual([]);
  });

  it('opens it with the token of the request, and says hello first', async () => {
    await start();
    const next = stub.nextSocket();
    await request();
    const socket = await next;
    expect(socket.authorization).toBe(AUTH);
    expect(socket.path).toBe('/mcp/ws');
    expect(await socket.hello()).toEqual({ message: 'hello', data: { capabilities: [] } });
    expect(socket.received).toHaveLength(1);
    await until(() => state() === 'open');
  });

  it('takes a relative socket address from the request it came with', async () => {
    stub.header = 'ws';
    await start({ upstreamUrl: `${stub.url}/prefix/` });
    const next = stub.nextSocket();
    await request(AUTH, '/mcp/');
    expect((await next).path).toBe('/prefix/mcp/ws');
  });

  it('takes a full socket address as it is, mapping http to ws', async () => {
    stub.header = `http://localhost:${stub.port}/elsewhere/ws`;
    await start();
    const next = stub.nextSocket();
    await request();
    expect((await next).path).toBe('/elsewhere/ws');
    expect(helper!.wakeup.status().url).toBe(`ws://localhost:${stub.port}/elsewhere/ws`);
  });

  it('keeps one socket across many requests', async () => {
    await start();
    await connected();
    for (let i = 0; i < 5; i++) await request();
    await sleep(100);
    expect(stub.attempts).toHaveLength(1);
  });

  it('moves to another socket when the intercom names another', async () => {
    await start();
    const first = await connected();
    stub.header = '/other/ws';
    const next = stub.nextSocket();
    await request();
    const second = await next;
    expect(second.path).toBe('/other/ws');
    expect(await first.closed).toBe(1000);
  });

  it('never logs the token', async () => {
    await start();
    await connected();
    await request('Bearer tai_another');
    expect(logged.join('')).not.toContain('tai_');
    expect(logged.join('')).toContain('wake-up socket open');
  });
});

describe('notifications', () => {
  it('hands on what the server sends, as it came', async () => {
    await start();
    const socket = await connected();
    socket.send(frame('inbox-activity', 1));
    socket.send(frame('shared-memory-update', 2));
    socket.send(frame('inbox-reminder', 3));
    const burst = frame('burst', 5, {
      burst: [frame('inbox-activity', 4), frame('inbox-activity', 5)],
    });
    socket.send(burst);
    await until(() => got.length === 4);
    expect(got.map((n) => [n.message, n.seq])).toEqual([
      ['inbox-activity', 1],
      ['shared-memory-update', 2],
      ['inbox-reminder', 3],
      ['burst', 5],
    ]);
    expect(got[0]).toEqual(frame('inbox-activity', 1));
    expect(got[3]).toEqual(burst);
    expect(helper!.wakeup.status().highest).toBe(5);
  });

  it('does not hand on the hello, the close notice, or what it does not know', async () => {
    await start();
    const socket = await connected();
    socket.send(frame('something-new', 1));
    socket.send(frame('connection-closed', 1, { reason: 'server-shutdown' }));
    socket.ws.send('not json');
    socket.ws.send('{"message":"inbox-activity"}');
    socket.send(frame('inbox-activity', 2));
    await until(() => got.length === 1);
    expect(got).toEqual([frame('inbox-activity', 2)]);
  });

  it('says that something was missed when the first hello reports something pending', async () => {
    await start();
    await connected({ seq: 7, pending: true });
    await until(() => got.length === 1);
    expect(got[0]).toEqual({
      message: 'missed',
      seq: 7,
      time: '2026-11-15T12:00:00.000Z',
      data: {},
    });
  });

  it('says nothing when the first hello reports nothing pending', async () => {
    await start();
    const socket = await connected({ seq: 7, pending: false });
    socket.send(frame('inbox-activity', 8));
    await until(() => got.length === 1);
    expect(got.map((n) => n.message)).toEqual(['inbox-activity']);
  });

  it('says that something was missed when the number grew while it was away', async () => {
    await start();
    const first = await connected();
    first.send(frame('inbox-activity', 1));
    await until(() => got.length === 1);

    const next = stub.nextSocket();
    first.ws.close(1011);
    const second = await next;
    await second.hello();
    second.send({
      message: 'hello',
      seq: 4,
      time: '2026-11-15T13:00:00.000Z',
      data: { pending: true },
    });
    await until(() => got.length === 2);
    expect(got[1]).toEqual({
      message: 'missed',
      seq: 4,
      time: '2026-11-15T13:00:00.000Z',
      data: {},
    });
    expect(helper!.wakeup.status().highest).toBe(4);
  });

  it('takes numbers that skip as they come, without calling it a loss', async () => {
    // The counter is the agent's: the intercom may give numbers to things
    // this socket is not told of, such as reminders for the agent's webhook.
    await start();
    const first = await connected({ seq: 2, pending: false });
    first.send(frame('inbox-activity', 3));
    first.send(frame('inbox-activity', 7));
    first.send(frame('shared-memory-update', 12));
    await until(() => got.length === 3);
    expect(got.map((n) => [n.message, n.seq])).toEqual([
      ['inbox-activity', 3],
      ['inbox-activity', 7],
      ['shared-memory-update', 12],
    ]);
    expect(helper!.wakeup.status().highest).toBe(12);

    // After a reconnect only a number beyond the highest seen counts as missed.
    const next = stub.nextSocket();
    first.ws.close(1011);
    const second = await next;
    await second.hello();
    second.send({
      message: 'hello',
      seq: 12,
      time: '2026-11-17T13:00:00.000Z',
      data: { pending: true },
    });
    second.send(frame('inbox-activity', 20));
    await until(() => got.length === 4);
    expect(got.map((n) => n.message)).toEqual([
      'inbox-activity',
      'inbox-activity',
      'shared-memory-update',
      'inbox-activity',
    ]);
  });

  it('says nothing after a reconnect when the number is the same', async () => {
    await start();
    const first = await connected({ seq: 3, pending: false });
    first.send(frame('inbox-activity', 4));
    await until(() => got.length === 1);
    const next = stub.nextSocket();
    first.ws.close(1011);
    const second = await next;
    await second.hello();
    // Still unfetched, but nothing new: the agent was told already.
    second.send({
      message: 'hello',
      seq: 4,
      time: '2026-11-15T13:00:00.000Z',
      data: { pending: true },
    });
    second.send(frame('inbox-activity', 5));
    await until(() => got.length === 2);
    expect(got.map((n) => n.message)).toEqual(['inbox-activity', 'inbox-activity']);
  });
});

describe('staying connected', () => {
  it('reopens a socket that closed after a short pause', async () => {
    await start();
    const first = await connected();
    const next = stub.nextSocket();
    const closedAt = Date.now();
    first.ws.close(1011);
    const second = await next;
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(90);
    expect(Date.now() - closedAt).toBeLessThan(350);
    expect(await second.hello()).toMatchObject({ message: 'hello' });
  });

  it('keeps trying, more slowly, while the socket does not open', async () => {
    await start();
    stub.refuseWith = 503;
    await request();
    await until(() => stub.attempts.length === 1);
    expect(state()).toBe('waiting');
    await sleep(250);
    expect(stub.attempts).toHaveLength(1);
    await until(() => stub.attempts.length === 2, 1000);
    stub.refuseWith = undefined;
    const socket = await stub.nextSocket();
    expect(await socket.hello()).toMatchObject({ message: 'hello' });
  });

  it('does not hurry because requests keep coming', async () => {
    await start();
    stub.refuseWith = 503;
    await request();
    await until(() => stub.attempts.length === 1);
    for (let i = 0; i < 5; i++) await request();
    await sleep(150);
    expect(stub.attempts).toHaveLength(1);
  });

  it('waits a long time after another client took the socket', async () => {
    await start();
    const first = await connected();
    first.send(frame('connection-closed', 0, { reason: 'replaced' }));
    first.ws.close(4001, 'replaced');
    await until(() => state() === 'waiting');
    await request();
    await sleep(700);
    expect(stub.attempts).toHaveLength(1);
    expect(logged.join('')).toContain('another client took the wake-up socket');
    await until(() => stub.attempts.length === 2, 2500);
  });

  it('recognises a replacement by its close code alone', async () => {
    await start();
    const first = await connected();
    first.ws.close(4001);
    await until(() => state() === 'waiting');
    await sleep(500);
    expect(stub.attempts).toHaveLength(1);
  });

  it('stops for good when the token is refused', async () => {
    await start();
    stub.refuseWith = 401;
    await request();
    await until(() => state() === 'refused');
    stub.refuseWith = undefined;
    await request();
    await sleep(600);
    expect(stub.attempts).toHaveLength(1);
    expect(logged.join('')).toContain('refused the token');
    // Requests are still forwarded.
    expect(await request()).toBe(200);
  });

  it('stops for good when the token is revoked', async () => {
    await start();
    const socket = await connected();
    socket.send(frame('connection-closed', 0, { reason: 'token-revoked' }));
    socket.ws.close(4002, 'token-revoked');
    await until(() => state() === 'refused');
    await request();
    await sleep(600);
    expect(stub.attempts).toHaveLength(1);
  });

  it('uses the first token it saw, whatever comes later', async () => {
    await start();
    const first = await connected();
    stub.accepted.add('Bearer tai_other');
    expect(await request('Bearer tai_other')).toBe(200);
    const next = stub.nextSocket();
    first.ws.close(1011);
    expect((await next).authorization).toBe(AUTH);
    expect(logged.join('')).toContain('different token');
  });

  it('reconnects when the server goes silent', async () => {
    await start({}, { ...FAST, silenceMs: 300 });
    const first = await connected();
    const next = stub.nextSocket();
    expect(await first.closed).toBe(1006);
    expect(logged.join('')).toContain('went silent');
    await next;
  });

  it('stays connected while the server pings', async () => {
    await start({}, { ...FAST, silenceMs: 300 });
    const socket = await connected();
    const pinger = setInterval(() => socket.ws.ping(), 80);
    await sleep(700);
    clearInterval(pinger);
    expect(stub.attempts).toHaveLength(1);
    expect(state()).toBe('open');
  });
});

describe('the socket timeout', () => {
  it('closes the socket when no request has come for that long, and reopens with the next', async () => {
    await start({ socketTimeout: 0.3 });
    const first = await connected();
    expect(await first.closed).toBe(1000);
    expect(state()).toBe('idle');
    await sleep(300);
    expect(stub.attempts).toHaveLength(1);

    const next = stub.nextSocket();
    await request();
    const second = await next;
    expect(await second.hello()).toMatchObject({ message: 'hello' });
  });

  it('keeps the socket while a request is in flight', async () => {
    await start({ socketTimeout: 0.2 });
    await connected();
    const long = fetch(`${base}/slow?ms=700`, { headers: { Authorization: AUTH } });
    await sleep(500);
    expect(state()).toBe('open');
    await (await long).text();
    await until(() => state() === 'idle', 1500);
  });

  it('keeps the socket for ever without the option', async () => {
    await start();
    await connected();
    await sleep(500);
    expect(state()).toBe('open');
  });
});

describe('stopping', () => {
  it('closes the socket and the listener', async () => {
    await start();
    const socket = await connected();
    await helper!.stop();
    helper = undefined;
    expect(await socket.closed).toBe(1000);
    await expect(fetch(`${base}/mcp`)).rejects.toThrow();
  });

  it('runs without any delivery method', async () => {
    helper = await startHelper({ config: config(), logger: silentLogger, timings: FAST });
    base = `http://127.0.0.1:${helper.port}`;
    const socket = await connected({ seq: 1, pending: true });
    socket.send(frame('inbox-activity', 2));
    await sleep(100);
    expect(state()).toBe('open');
  });
});
