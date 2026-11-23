import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MCP_OPTIONS } from '../src/mcp-options.js';
import { INBOX, PNG, startFakeIntercom, type FakeIntercom } from './fake-intercom.js';
import { until } from './stub.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const program = path.join(root, 'dist', 'mcp-cli.js');

let fake: FakeIntercom;
let tmp: string;
let state: string;
let project: string;
const open: Client[] = [];

beforeEach(async () => {
  fake = await startFakeIntercom();
  tmp = realpathSync(await mkdtemp(path.join(tmpdir(), 'helper-mcp-')));
  state = path.join(tmp, 'state');
  project = path.join(tmp, 'project');
  mkdirSync(project);
});
afterEach(async () => {
  for (const c of open.splice(0)) await c.close().catch(() => undefined);
  await fake.close();
  await rm(tmp, { recursive: true, force: true });
});

interface Session {
  client: Client;
  /** How often the server said that its tools changed. */
  changed(): number;
  /** Resources the server said were updated. */
  updated: string[];
  /** Everything the program wrote to standard error. */
  log(): string;
  tools(): Promise<string[]>;
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

/** A session of a client, started in a directory, as the client would start the program. */
async function session(
  opts: { name?: string; cwd?: string; args?: string[]; env?: Record<string, string> } = {},
): Promise<Session> {
  const client = new Client({ name: opts.name ?? 'claude-code', version: '9.9.9' });
  let changed = 0;
  const updated: string[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => void changed++);
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    updated.push(n.params.uri);
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [program, '--state-dir', state, '--log-level', 'debug', ...(opts.args ?? [])],
    cwd: opts.cwd ?? project,
    env: { PATH: process.env.PATH ?? '', HOME: tmp, ...opts.env },
    stderr: 'pipe',
  });
  let log = '';
  transport.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()));
  await client.connect(transport);
  open.push(client);
  return {
    client,
    changed: () => changed,
    updated,
    log: () => log,
    tools: async () => (await client.listTools()).tools.map((t) => t.name),
    call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text?: string }[];
      return { text: content[0]?.text ?? '', isError: result.isError === true };
    },
  };
}

describe('a session that has not joined', () => {
  it('has one tool and is told that it is not connected', async () => {
    const s = await session();
    expect(s.client.getInstructions()).toContain('not connected to an intercom');
    expect(await s.tools()).toEqual(['intercom_join']);
    const other = await s.call('whoami');
    expect(other.isError).toBe(true);
    expect(other.text).toContain('not connected');
    expect((await s.client.listResources()).resources).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it('sends nothing to a URL that is not a join URL', async () => {
    const s = await session();
    for (const url of [
      'not a url',
      `${fake.url}/mcp`,
      `${fake.url}/mcp/join/short`,
      `${fake.joinUrl()}?x=1`,
      'http://intercom.example.com/mcp/join/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'ftp://127.0.0.1/mcp/join/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]) {
      const res = await s.call('intercom_join', { url });
      expect(res.isError, url).toBe(true);
    }
    expect(fake.requests).toEqual([]);
    expect(await s.tools()).toEqual(['intercom_join']);
  });

  it('joins only the intercoms it was told to allow, when told', async () => {
    const elsewhere = await session({ args: ['--intercom', 'https://intercom.example.com'] });
    const refused = await elsewhere.call('intercom_join', { url: fake.joinUrl() });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('may join these intercoms only: https://intercom.example.com');
    expect(fake.requests).toEqual([]);

    const here = await session({
      args: ['--intercom', 'https://intercom.example.com', '--intercom', `${fake.url}/`],
    });
    expect((await here.call('intercom_join', { url: fake.joinUrl() })).isError).toBe(false);
  });

  it('says what the intercom said when it refuses the URL, and stays unjoined', async () => {
    const s = await session();
    const url = fake.joinUrl();
    fake.refuseJoin = { status: 410, body: 'This join URL was used already; ask for a new one.\n' };
    const res = await s.call('intercom_join', { url });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('HTTP 410');
    expect(res.text).toContain('ask for a new one');
    expect(await s.tools()).toEqual(['intercom_join']);
    expect(s.changed()).toBe(0);
    expect(readdirSync(tmp)).not.toContain('state');
  });

  it('reports an intercom that cannot be reached, without giving up the URL', async () => {
    const s = await session();
    const url = fake.joinUrl();
    await fake.close();
    const res = await s.call('intercom_join', { url });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('could not be reached');
    expect(res.text).toContain('not used up');
    fake = await startFakeIntercom();
  });
});

describe('joining', () => {
  it('makes the session the agent, with the tools of the intercom, and says so once done', async () => {
    const s = await session();
    const url = fake.joinUrl();
    const res = await s.call('intercom_join', { url });
    expect(res.isError).toBe(false);
    // The introduction is the intercom's, written for the client that was named.
    expect(res.text).toBe(
      'You have joined the fake intercom as "builder", in a claude-code session.',
    );
    expect(fake.joins).toEqual([
      {
        program: expect.stringMatching(/^tr-ai-intercom-mcp\/\d+\.\d+\.\d+$/),
        client: { name: 'claude-code', version: '9.9.9' },
      },
    ]);

    // The tool list changed, announced after the join and once more.
    await until(() => s.changed() >= 2, 5000);
    expect(await s.tools()).toEqual(['whoami', 'picture', 'slow']);

    // Calls and their answers pass through as they are.
    const who = await s.call('whoami', { hello: 'there' });
    expect(JSON.parse(who.text)).toEqual({ name: 'builder', said: { hello: 'there' } });
    const picture = await s.client.callTool({ name: 'picture', arguments: {} });
    expect(picture.content).toEqual([
      { type: 'text', text: 'a picture' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
    ]);
    const unknown = await s.call('no_such_tool');
    expect(unknown).toEqual({ text: 'No tool no_such_tool.', isError: true });

    // The intercom was told the session's own client.
    expect(fake.clients).toEqual(['claude-code']);

    // Stored for the user only, and nothing secret was logged.
    const dir = path.join(state, 'identities');
    const [file] = readdirSync(dir);
    expect(statSync(path.join(dir, file!)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(path.join(dir, file!), 'utf8'));
    expect(stored).toMatchObject({
      directory: project,
      mcpUrl: `${fake.url}/mcp`,
      token: fake.token,
      agent: fake.agent,
      exchange: { name: 'Default' },
    });
    expect(s.log()).toContain('"msg":"joined"');
    expect(s.log()).not.toContain(fake.token);
    expect(s.log()).not.toContain(url.split('/').at(-1)!);
  });

  it('cannot be done again from the chat while the identity works', async () => {
    const s = await session();
    await s.call('intercom_join', { url: fake.joinUrl() });
    expect(await s.tools()).not.toContain('intercom_join');
    const again = await s.call('intercom_join', { url: fake.joinUrl() });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('already the intercom agent "builder"');
    expect(fake.joins).toHaveLength(1);
  });

  it('uses the URL up: a second session cannot join with it', async () => {
    const first = await session();
    const url = fake.joinUrl();
    await first.call('intercom_join', { url });
    const other = path.join(tmp, 'other');
    mkdirSync(other);
    const second = await session({ cwd: other });
    const res = await second.call('intercom_join', { url });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('HTTP 410');
  });
});

describe('a session that starts as an agent', () => {
  beforeEach(async () => {
    const s = await session();
    await s.call('intercom_join', { url: fake.joinUrl() });
    await s.client.close();
    fake.clients.length = 0;
  });

  it('is the agent at once, with the instructions the intercom wrote for its client', async () => {
    const s = await session({ name: 'codex-mcp-client' });
    expect(s.client.getInstructions()).toBe(
      'RULES OF THE FAKE INTERCOM, worded for the client "codex-mcp-client".',
    );
    expect(fake.clients).toEqual(['codex-mcp-client']);
    expect(await s.tools()).toEqual(['whoami', 'picture', 'slow']);
    expect(JSON.parse((await s.call('whoami')).text).name).toBe('builder');
    expect(fake.joins).toHaveLength(1);
  });

  it('belongs to exactly its directory: not to one below, not to another', async () => {
    const below = path.join(project, 'sub');
    mkdirSync(below);
    expect(await (await session({ cwd: below })).tools()).toEqual(['intercom_join']);
    expect(await (await session({ cwd: tmp })).tools()).toEqual(['intercom_join']);
  });

  it('takes the directory from CLAUDE_PROJECT_DIR when the client names one', async () => {
    const s = await session({ cwd: tmp, env: { CLAUDE_PROJECT_DIR: project } });
    expect(await s.tools()).toEqual(['whoami', 'picture', 'slow']);
  });

  it('passes the inbox resource and its notifications on', async () => {
    const s = await session();
    expect((await s.client.listResources()).resources).toEqual([{ uri: INBOX, name: 'inbox' }]);
    const read = await s.client.readResource({ uri: INBOX });
    expect(read.contents).toEqual([
      { uri: INBOX, mimeType: 'application/json', text: '{"unread":[]}' },
    ]);
    await fake.inboxChanged();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.updated).toEqual([]);
    await s.client.subscribeResource({ uri: INBOX });
    await fake.inboxChanged();
    await until(() => s.updated.length === 1, 5000);
    expect(s.updated).toEqual([INBOX]);
    await s.client.unsubscribeResource({ uri: INBOX });
    await fake.inboxChanged();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.updated).toEqual([INBOX]);
  });

  it('carries on when the intercom has forgotten the session, without repeating a call', async () => {
    const s = await session();
    await s.call('whoami');
    fake.forgetSessions();
    expect(JSON.parse((await s.call('whoami')).text).name).toBe('builder');
    expect(fake.calls.whoami).toBe(2);
  });

  it('passes a cancellation on', async () => {
    const s = await session();
    const stop = new AbortController();
    const slow = s.client.callTool({ name: 'slow', arguments: {} }, undefined, {
      signal: stop.signal,
    });
    await until(() => fake.calls.slow === 1, 5000);
    stop.abort();
    await expect(slow).rejects.toThrow();
    await until(() => fake.calls.cancelled === 1, 5000);
  });

  it('offers the join again when the intercom refuses the stored token', async () => {
    const s = await session();
    expect(await s.tools()).toContain('whoami');
    const url = fake.rotate();
    const refused = await s.call('whoami');
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('no longer accepts the credentials of the agent "builder"');
    expect(refused.text).toContain('intercom_join');
    await until(() => s.changed() >= 1, 5000);
    expect(await s.tools()).toEqual(['intercom_join']);

    // A new join URL from the person repairs it, in the same session.
    const res = await s.call('intercom_join', { url });
    expect(res.isError).toBe(false);
    expect(await s.tools()).toEqual(['whoami', 'picture', 'slow']);
    expect(JSON.parse((await s.call('whoami')).text).name).toBe('builder');
    expect(s.log()).not.toContain(fake.token);
  });

  it('says so when the token is refused already at the start', async () => {
    fake.rotate();
    const s = await session();
    expect(s.client.getInstructions()).toContain('no longer accepts its credentials');
    expect(await s.tools()).toEqual(['intercom_join']);
  });

  it('starts and says so when the intercom cannot be reached', async () => {
    await fake.close();
    const s = await session();
    expect(s.client.getInstructions()).toContain('could not be reached when the session started');
    const res = await s.call('whoami');
    expect(res.isError).toBe(true);
    expect(res.text).toContain('could not be reached');
    expect(await s.tools()).toEqual([]);
    fake = await startFakeIntercom();
  });
});

describe('for the person', () => {
  const cli = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const res = spawnSync(process.execPath, [program, '--state-dir', state, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: tmp },
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  };

  it('lists the identities and forgets one', async () => {
    expect(cli(['--list']).stdout).toBe('No session has joined an intercom yet.\n');
    const s = await session();
    await s.call('intercom_join', { url: fake.joinUrl() });
    await s.client.close();

    const listed = cli(['--list']);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain(project);
    expect(listed.stdout).toContain(`agent "builder" in exchange "Default" at ${fake.url}`);
    expect(listed.stdout).not.toContain(fake.token);

    expect(cli(['--forget', path.join(tmp, 'nowhere')]).stdout).toContain('has no identity');
    const forgot = cli(['--forget', project]);
    expect(forgot.stdout).toContain(`Forgot the identity of ${project}`);
    expect(cli(['--list']).stdout).toBe('No session has joined an intercom yet.\n');
    expect(await (await session()).tools()).toEqual(['intercom_join']);
  });

  it('refuses an --intercom that is not an https URL', () => {
    const res = cli(['--intercom', 'http://intercom.example.com', '--list']);
    expect(res.status).not.toBe(0);
  });

  it('gives every option an environment variable named after it', () => {
    for (const def of MCP_OPTIONS) {
      const name = def.longName as string;
      expect(def.environment).toBe(`INTERCOM_MCP_OPT_${name.toUpperCase().replace(/-/g, '_')}`);
      expect(def.description).toBeTruthy();
    }
  });
});
