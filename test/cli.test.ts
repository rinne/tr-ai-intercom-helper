import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AUTH, startStub, until, type Stub } from './stub.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'dist', 'cli.js');
const notify = path.join(root, 'dist', 'notify-cli.js');

let stub: Stub;
let dir: string;
let child: ChildProcess | undefined;

// The program is tested as it is shipped: built (test/build.ts), and run with node.

beforeEach(async () => {
  stub = await startStub();
  dir = await mkdtemp(path.join(tmpdir(), 'helper-cli-'));
});
afterEach(async () => {
  child?.kill('SIGKILL');
  child = undefined;
  await stub.close();
  await rm(dir, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = {}, program = cli): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [program, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += String(c)));
    p.stderr.on('data', (c) => (stderr += String(c)));
    p.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Start the program and wait until it listens; returns its port and its log. */
async function start(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ port: number; log: () => Record<string, unknown>[]; exited: Promise<number | null> }> {
  const p = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
  child = p;
  let stderr = '';
  p.stderr.on('data', (c) => (stderr += String(c)));
  const log = (): Record<string, unknown>[] =>
    stderr
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const exited = new Promise<number | null>((resolve) => p.on('exit', (code) => resolve(code)));
  await until(() => log().some((l) => l.msg === 'listening for the agent'), 10_000);
  const port = log().find((l) => l.msg === 'listening for the agent')!.port as number;
  return { port, log, exited };
}

describe('the command', () => {
  it('prints its usage with --help', async () => {
    const out = await run(['--help']);
    const text = out.stdout + out.stderr;
    expect(text).toContain('--mcp-server-url');
    expect(text).toContain('--notification-command');
    expect(text).toContain('INTERCOM_HELPER_OPT_LISTEN_PORT');
  });

  it('ends with an error when the intercom is not named', async () => {
    const out = await run([]);
    expect(out.code).not.toBe(0);
    expect(out.stdout + out.stderr).toContain('mcp-server-url');
  });

  it('ends with an error when the port is taken', async () => {
    const out = await run([
      '--mcp-server-url',
      stub.url,
      '--listen-port',
      String(stub.port),
      '--log-level',
      'silent',
    ]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('already in use');
  });

  it('forwards requests, opens the socket and writes notifications', async () => {
    const file = path.join(dir, 'notifications');
    const helper = await start([
      `--mcp-server-url=${stub.url}/`,
      '--listen-port=0',
      `--notification-file=${file}`,
      `--notification-dir=${path.join(dir, 'spool')}`,
    ]);
    const next = stub.nextSocket();
    const res = await fetch(`http://127.0.0.1:${helper.port}/mcp`, {
      method: 'POST',
      headers: { Authorization: AUTH },
      body: '{"hello":1}',
    });
    expect(await res.json()).toEqual({ method: 'POST', url: '/mcp', body: '{"hello":1}' });

    const socket = await next;
    await socket.hello();
    socket.send({
      message: 'hello',
      seq: 1,
      time: '2026-11-15T12:00:00.000Z',
      data: { pending: true },
    });
    const frame = { message: 'inbox-activity', seq: 2, time: '2026-11-15T12:00:01.000Z', data: {} };
    socket.send(frame);

    const lines = async (): Promise<string[]> =>
      (await readFile(file, 'utf8').catch(() => '')).split('\n').filter((l) => l !== '');
    let seen: string[] = [];
    for (let i = 0; i < 200 && seen.length < 2; i++) {
      seen = await lines();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen.map((l) => JSON.parse(l))).toEqual([
      { message: 'missed', seq: 1, time: '2026-11-15T12:00:00.000Z', data: {} },
      frame,
    ]);
    expect(JSON.parse(await readFile(path.join(dir, 'spool', '00000002.json'), 'utf8'))).toEqual(
      frame,
    );

    const started = helper.log().find((l) => l.msg === 'tr-ai-intercom-helper starting')!;
    expect(started).toMatchObject({ methods: ['file', 'dir'] });
    expect(JSON.stringify(helper.log())).not.toContain('tai_');

    child!.kill('SIGTERM');
    expect(await helper.exited).toBe(0);
    child = undefined;
    expect(await socket.closed).toBe(1000);
  });

  it('takes its configuration from the environment', async () => {
    const helper = await start([], {
      INTERCOM_HELPER_OPT_MCP_SERVER_URL: stub.url,
      INTERCOM_HELPER_OPT_LISTEN_PORT: '0',
    });
    const res = await fetch(`http://127.0.0.1:${helper.port}/mcp`, {
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(helper.log().some((l) => String(l.msg).startsWith('no delivery method'))).toBe(true);
  });
});

describe('the notify command', () => {
  const usage = (args: string[]): Promise<Run> => run(args, {}, notify);

  it('prints its usage with --help', async () => {
    const out = await usage(['--help']);
    const text = out.stdout + out.stderr;
    for (const option of [
      '--monitor',
      '--oneshot',
      '--reconnect',
      '--helper-port',
      '--socket-path',
    ]) {
      expect(text).toContain(option);
    }
  });

  it('needs exactly one mode and exactly one way to find the socket', async () => {
    const bad = [
      ['--helper-port', '32323'],
      ['--monitor'],
      ['--monitor', '--oneshot', '--helper-port', '32323'],
      ['--oneshot', '--reconnect', '--helper-port', '32323'],
      ['--reconnect', '--helper-port', '32323'],
      ['--monitor', '--helper-port', '32323', '--socket-path', '/tmp/x.sock'],
      ['--monitor', '--helper-port', 'many'],
      ['--monitor', '--helper-port', '32323', '--idle-notification-interval', 'soon'],
      ['--monitor', '--helper-port', '32323', '--idle-notification-interval', '0'],
    ];
    for (const args of bad) {
      const out = await usage(args);
      expect(out.code, args.join(' ')).not.toBe(0);
      expect(out.stdout, args.join(' ')).not.toContain('{');
    }
  });

  it('ends with an error when no helper listens there', async () => {
    const out = await usage(['--oneshot', '--socket-path', path.join(dir, 'nothing.sock')]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('tr-ai-intercom-notify: Could not connect');
    expect(out.stdout).toBe('');
  });

  it('prints the notifications of a running helper', async () => {
    const socketPath = path.join(dir, 's.sock');
    const helper = await start([
      `--mcp-server-url=${stub.url}`,
      '--listen-port=0',
      `--notification-listener-path=${socketPath}`,
    ]);
    await until(() => helper.log().some((l) => l.msg === 'notification listener ready'), 5000);
    const ready = helper.log().find((l) => l.msg === 'notification listener ready')!;
    expect(ready.path).toBe(socketPath);
    expect(ready.command).toBe(
      `npx -y -p tr-ai-intercom-helper tr-ai-intercom-notify --monitor --socket-path '${socketPath}'`,
    );

    const next = stub.nextSocket();
    const res = await fetch(`http://127.0.0.1:${helper.port}/mcp`, {
      headers: { Authorization: AUTH },
    });
    await res.text();
    const socket = await next;
    await socket.hello();
    socket.send({
      message: 'hello',
      seq: 0,
      time: '2026-11-15T12:00:00.000Z',
      data: { pending: false },
    });
    const frame = (seq: number): Record<string, unknown> => ({
      message: 'inbox-activity',
      seq,
      time: '2026-11-15T12:00:01.000Z',
      data: {},
    });

    // One notification arrives before anybody listens: it is kept for the first client.
    socket.send(frame(1));
    await new Promise((r) => setTimeout(r, 200));
    const once = await usage(['--oneshot', '--socket-path', socketPath]);
    expect(once.code).toBe(0);
    expect(once.stdout).toBe(`${JSON.stringify(frame(1))}\n`);

    const monitor = spawn(process.execPath, [notify, '--monitor', '--socket-path', socketPath]);
    let printed = '';
    monitor.stdout.on('data', (c) => (printed += String(c)));
    const ended = new Promise<number | null>((resolve) => monitor.on('exit', resolve));
    await new Promise((r) => setTimeout(r, 400));
    socket.send(frame(2));
    socket.send(frame(3));
    await until(() => printed.split('\n').length === 3, 5000);
    expect(printed).toBe(`${JSON.stringify(frame(2))}\n${JSON.stringify(frame(3))}\n`);
    monitor.kill('SIGTERM');
    expect(await ended).toBe(0);
  });

  it('prints an idle notification when asked to and nothing happens', async () => {
    const socketPath = path.join(dir, 's.sock');
    await start([
      `--mcp-server-url=${stub.url}`,
      '--listen-port=0',
      `--notification-listener-path=${socketPath}`,
    ]);
    const out = await usage([
      '--oneshot',
      '--socket-path',
      socketPath,
      '--idle-notification-interval',
      '0.3',
    ]);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      message: 'local-idle-notification',
      seq: 0,
      time: expect.any(String),
      data: { idle: 0 },
    });
  });

  it('ends with an error when the helper stops', async () => {
    const socketPath = path.join(dir, 's.sock');
    const helper = await start([
      `--mcp-server-url=${stub.url}`,
      '--listen-port=0',
      `--notification-listener-path=${socketPath}`,
    ]);
    const monitor = usage(['--monitor', '--socket-path', socketPath]);
    await new Promise((r) => setTimeout(r, 400));
    child!.kill('SIGTERM');
    await helper.exited;
    child = undefined;
    const out = await monitor;
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('the helper stopped');
  });
});
