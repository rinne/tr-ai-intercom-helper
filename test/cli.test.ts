import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AUTH, startStub, until, type Stub } from './stub.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'dist', 'cli.js');

let stub: Stub;
let dir: string;
let child: ChildProcess | undefined;

// The program is tested as it is shipped: built, and run with node.
beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
}, 60_000);

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

function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
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
