import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHelper, type RunningHelper } from '../src/helper.js';
import {
  checkOwnDirectory,
  defaultListenerPath,
  listenerSink,
  notifyCommand,
  type ListenerSink,
} from '../src/listener.js';
import { silentLogger } from '../src/logger.js';
import { resolveSocketPath, runNotifier } from '../src/notifier.js';
import { NOTIFY_OPTIONS } from '../src/notify-options.js';
import { loadConfig } from '../src/options.js';
import { sinksFor } from '../src/sinks.js';
import type { Notification } from '../src/wakeup.js';
import { sleep, startStub, until, type Stub } from './stub.js';

let dir: string;
let socketPath: string;
let sink: ListenerSink | undefined;
const cleanup: (() => Promise<void> | void)[] = [];

const note = (seq: number, message = 'inbox-activity'): Notification => ({
  message,
  seq,
  time: '2026-11-15T12:00:00.000Z',
  data: {},
});
const line = (seq: number, message?: string): string => `${JSON.stringify(note(seq, message))}\n`;
const push = (seq: number, message?: string): Promise<void> =>
  sink!.deliver(note(seq, message), JSON.stringify(note(seq, message)));

/** A client of the listener that collects what it is sent. */
async function client(at = socketPath): Promise<{ text: () => string; socket: net.Socket }> {
  let text = '';
  const socket = net.createConnection(at);
  socket.setEncoding('utf8');
  socket.on('data', (c: string) => (text += c));
  socket.on('error', () => undefined);
  cleanup.push(() => {
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return { text: () => text, socket };
}

/** Wait until nothing is left at a path. */
async function gone(at: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (!(await lstat(at).catch(() => undefined))) return;
    await sleep(10);
  }
  throw new Error(`${at} is still there`);
}

async function listen(at = socketPath): Promise<ListenerSink> {
  sink = listenerSink(silentLogger, at);
  await sink.start({ port: 0 });
  return sink;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hl-'));
  socketPath = path.join(dir, 's.sock');
});
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
  sink?.stop();
  sink = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('the notification listener', () => {
  it('sends every client each notification as one line of JSON', async () => {
    await listen();
    const a = await client();
    const b = await client();
    await until(() => sink!.clientCount() === 2);
    await push(1);
    await push(2, 'inbox-reminder');
    await until(() => a.text().split('\n').length === 3 && b.text().split('\n').length === 3);
    expect(a.text()).toBe(line(1) + line(2, 'inbox-reminder'));
    expect(b.text()).toBe(a.text());
  });

  it('keeps the latest notification nobody received for the next client, once', async () => {
    await listen();
    await push(1);
    await push(2);
    await push(3);
    const first = await client();
    await until(() => first.text() !== '');
    expect(first.text()).toBe(line(3));

    const second = await client();
    await until(() => sink!.clientCount() === 2);
    await sleep(50);
    expect(second.text()).toBe('');
    await push(4);
    await until(() => second.text() !== '');
    expect(first.text()).toBe(line(3) + line(4));
    expect(second.text()).toBe(line(4));
  });

  it('keeps nothing that a client did receive', async () => {
    await listen();
    const first = await client();
    await until(() => sink!.clientCount() === 1);
    await push(1);
    await until(() => first.text() !== '');
    first.socket.destroy();
    await until(() => sink!.clientCount() === 0);
    const second = await client();
    await sleep(80);
    expect(second.text()).toBe('');
  });

  it('ignores what clients send', async () => {
    await listen();
    const a = await client();
    a.socket.write('hello?\n');
    await push(1);
    await until(() => a.text() !== '');
    expect(a.text()).toBe(line(1));
  });

  it('makes the socket private and removes it when it stops', async () => {
    await listen();
    const info = await stat(socketPath);
    expect(info.isSocket()).toBe(true);
    expect(info.mode & 0o777).toBe(0o600);
    const a = await client();
    let closed = false;
    a.socket.on('close', () => (closed = true));
    sink!.stop();
    sink = undefined;
    await until(() => closed);
    await gone(socketPath);
  });

  it('takes over a socket file that a dead helper left behind', async () => {
    // A helper that was killed leaves its socket file behind.
    const dead = spawn(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('up'))`,
    ]);
    await new Promise((resolve) => dead.stdout.once('data', resolve));
    dead.kill('SIGKILL');
    await new Promise((resolve) => dead.once('exit', resolve));
    expect((await lstat(socketPath)).isSocket()).toBe(true);

    await listen();
    const a = await client();
    await push(1);
    await until(() => a.text() !== '');
  });

  it('refuses a socket somebody is listening on', async () => {
    await listen();
    const other = listenerSink(silentLogger, socketPath);
    await expect(other.start({ port: 0 })).rejects.toThrow(/already listening/);
    // The first one is untouched.
    const a = await client();
    await push(1);
    await until(() => a.text() !== '');
  });

  it('refuses a path that is something else', async () => {
    await writeFile(socketPath, 'a file');
    await expect(listen()).rejects.toThrow(/not a socket/);
    sink = undefined;
  });

  it('refuses a path too long for a socket', async () => {
    await expect(listen(path.join(dir, `${'x'.repeat(120)}.sock`))).rejects.toThrow(/longer than/);
    sink = undefined;
  });
});

describe('the default place of the socket', () => {
  const uid = process.getuid!();

  it('is named by the user and the port', () => {
    expect(defaultListenerPath(32323)).toBe(`/tmp/tr-ai-intercom-helper.${uid}/32323.sock`);
    expect(notifyCommand({ port: 32323 })).toBe(
      'npx -y -p tr-ai-intercom-helper tr-ai-intercom-notify --monitor --helper-port 32323',
    );
    expect(notifyCommand({ port: 32323, path: '/run/x.sock' })).toBe(
      "npx -y -p tr-ai-intercom-helper tr-ai-intercom-notify --monitor --socket-path '/run/x.sock'",
    );
  });

  it('is used by a helper started with the listener, for the port it got', async () => {
    const stub: Stub = await startStub();
    let helper: RunningHelper | undefined;
    try {
      const config = loadConfig(
        ['--mcp-server-url', stub.url, '--listen-port', '0', '--notification-listener'],
        { exitOnError: false },
      );
      const sinks = sinksFor(config, silentLogger);
      expect(sinks.map((s) => s.name)).toEqual(['listener']);
      helper = await startHelper({ config, logger: silentLogger, sinks });
      const expected = defaultListenerPath(helper.port);
      expect((sinks[0] as ListenerSink).path()).toBe(expected);
      const info = await stat(path.dirname(expected));
      expect(info.mode & 0o777).toBe(0o700);
      expect(await resolveSocketPath({ port: helper.port })).toBe(expected);

      const a = await client(expected);
      helper.dispatcher.deliver(note(9));
      await until(() => a.text() !== '');
      expect(a.text()).toBe(line(9));

      await helper.stop();
      helper = undefined;
      await gone(expected);
    } finally {
      await helper?.stop();
      await stub.close();
    }
  });

  it('does not start a helper whose listener cannot be set up', async () => {
    const stub: Stub = await startStub();
    try {
      await writeFile(socketPath, 'in the way');
      const config = loadConfig(
        [
          '--mcp-server-url',
          stub.url,
          '--listen-port',
          '0',
          `--notification-listener-path=${socketPath}`,
        ],
        { exitOnError: false },
      );
      expect(config).toMatchObject({ listener: true, listenerPath: socketPath });
      await expect(startHelper({ config, logger: silentLogger })).rejects.toThrow(/not a socket/);
    } finally {
      await stub.close();
    }
  });

  it('trusts only a private directory of the user', async () => {
    const own = path.join(dir, 'own');
    await mkdir(own, { mode: 0o700 });
    await expect(checkOwnDirectory(own)).resolves.toBeUndefined();

    await chmod(own, 0o755);
    await expect(checkOwnDirectory(own)).rejects.toThrow(/open to other users/);

    const file = path.join(dir, 'file');
    await writeFile(file, '');
    await expect(checkOwnDirectory(file)).rejects.toThrow(/not a directory/);

    // Something that is certainly not ours.
    await expect(checkOwnDirectory('/')).rejects.toThrow(/cannot be trusted/);
  });
});

describe('the notifier', () => {
  interface Run {
    lines: string[];
    errors: string[];
    status: Promise<number>;
    stop: AbortController;
  }
  function run(
    mode: 'monitor' | 'oneshot',
    extra: { reconnect?: boolean; cooloffMs?: number; idleIntervalMs?: number } = {},
  ): Run {
    const lines: string[] = [];
    const errors: string[] = [];
    const stop = new AbortController();
    cleanup.push(() => stop.abort());
    const status = runNotifier({
      socketPath,
      mode,
      out: (l) => lines.push(l),
      err: (m) => errors.push(m),
      signal: stop.signal,
      ...extra,
    });
    return { lines, errors, status, stop };
  }

  it('prints everything that arrives while it monitors', async () => {
    await listen();
    const r = run('monitor');
    await until(() => sink!.clientCount() === 1);
    await push(1);
    await push(2);
    await until(() => r.lines.length === 2);
    expect(r.lines).toEqual([line(1), line(2)]);
    r.stop.abort();
    expect(await r.status).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it('prints one notification and ends in oneshot mode', async () => {
    await listen();
    const r = run('oneshot');
    await until(() => sink!.clientCount() === 1);
    await push(1);
    await push(2);
    expect(await r.status).toBe(0);
    expect(r.lines).toEqual([line(1)]);
  });

  it('loses nothing between two oneshot runs', async () => {
    await listen();
    const first = run('oneshot');
    await until(() => sink!.clientCount() === 1);
    await push(1);
    expect(await first.status).toBe(0);
    await until(() => sink!.clientCount() === 0);
    // The agent is busy with its inbox here, and more arrives.
    await push(2);
    await push(3);
    const second = run('oneshot');
    expect(await second.status).toBe(0);
    expect(second.lines).toEqual([line(3)]);
  });

  it('prints whole lines only, however the bytes arrive', async () => {
    const conns: net.Socket[] = [];
    const server = net.createServer((conn) => {
      conns.push(conn);
      const text = line(1) + line(2);
      conn.write(text.slice(0, 10));
      setTimeout(() => conn.write(text.slice(10, 60)), 30);
      setTimeout(() => conn.write(text.slice(60)), 60);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const r = run('monitor');
    await until(() => r.lines.length === 2);
    expect(r.lines).toEqual([line(1), line(2)]);
    for (const conn of conns) conn.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('ends with an error when no helper listens', async () => {
    for (const mode of ['monitor', 'oneshot'] as const) {
      const r = run(mode);
      expect(await r.status).toBe(1);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/Could not connect .* --notification-listener/);
      expect(r.lines).toEqual([]);
    }
  });

  it('ends with an error when the helper stops', async () => {
    await listen();
    const r = run('monitor');
    await until(() => sink!.clientCount() === 1);
    sink!.stop();
    sink = undefined;
    expect(await r.status).toBe(1);
    expect(r.errors[0]).toMatch(/the helper stopped/);
  });

  it('waits for the helper and survives its restart when told to reconnect', async () => {
    const r = run('monitor', { reconnect: true, cooloffMs: 60 });
    await sleep(250);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/Could not connect .* Trying again/);

    await listen();
    await until(() => sink!.clientCount() === 1);
    expect(r.errors.at(-1)).toMatch(/^Connected to /);
    await push(1);
    await until(() => r.lines.length === 1);

    sink!.stop();
    sink = undefined;
    await until(() => r.errors.some((e) => /the helper stopped/.test(e)));
    await listen();
    await until(() => sink!.clientCount() === 1);
    await push(3);
    await until(() => r.lines.length === 2);
    expect(r.lines).toEqual([line(1), line(3)]);

    r.stop.abort();
    expect(await r.status).toBe(0);
  });

  it('says nothing while nothing happens, unless asked to', async () => {
    await listen();
    const r = run('monitor');
    await sleep(300);
    expect(r.lines).toEqual([]);
  });

  it('prints a notification of its own each time it has been idle for the given time', async () => {
    await listen();
    const r = run('monitor', { idleIntervalMs: 120 });
    await until(() => r.lines.length === 2);
    const idle = JSON.parse(r.lines[0]!);
    expect(idle).toEqual({
      message: 'local-idle-notification',
      seq: 0,
      time: expect.any(String),
      data: { idle: expect.any(Number) },
    });
    expect(Math.abs(Date.parse(idle.time) - Date.now())).toBeLessThan(5000);
    expect(r.lines[0]!.endsWith('}\n')).toBe(true);

    // A real notification starts the count again, and its number is carried on.
    await until(() => sink!.clientCount() === 1);
    await push(7);
    const at = Date.now();
    await until(() => r.lines.includes(line(7)));
    const after = r.lines.length;
    await until(() => r.lines.length > after);
    expect(Date.now() - at).toBeGreaterThanOrEqual(100);
    expect(JSON.parse(r.lines.at(-1)!)).toMatchObject({
      message: 'local-idle-notification',
      seq: 7,
    });
  });

  it('counts the idle time from the last real notification, across repeats', async () => {
    await listen();
    const r = run('monitor', { idleIntervalMs: 700 });
    await until(() => r.lines.length === 3, 6000);
    expect(r.lines.map((l) => JSON.parse(l).data.idle)).toEqual([1, 1, 2]);
    await push(1);
    await until(() => r.lines.length === 5, 6000);
    expect(JSON.parse(r.lines[4]!)).toMatchObject({ seq: 1, data: { idle: 1 } });
  });

  it('ends a oneshot run with the idle notification when nothing else came', async () => {
    await listen();
    const r = run('oneshot', { idleIntervalMs: 100 });
    expect(await r.status).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(JSON.parse(r.lines[0]!)).toMatchObject({
      message: 'local-idle-notification',
      seq: 0,
      data: { idle: 0 },
    });
  });

  it('keeps saying idle while it waits for a helper that is not there', async () => {
    const r = run('monitor', { reconnect: true, cooloffMs: 50, idleIntervalMs: 100 });
    await until(() => r.lines.length === 2);
    expect(r.lines.map((l) => JSON.parse(l).message)).toEqual([
      'local-idle-notification',
      'local-idle-notification',
    ]);
  });

  it('finds the socket from a port or takes a path as it is', async () => {
    expect(await resolveSocketPath({ path: socketPath })).toBe(socketPath);
    expect(await resolveSocketPath({ port: 40001 })).toBe(defaultListenerPath(40001));
    await expect(resolveSocketPath({})).rejects.toThrow(/Neither/);
  });

  it('names its options in the environment after themselves', () => {
    for (const def of NOTIFY_OPTIONS) {
      const name = def.longName as string;
      expect(def.environment).toBe(`INTERCOM_NOTIFY_OPT_${name.toUpperCase().replace(/-/g, '_')}`);
    }
  });
});
