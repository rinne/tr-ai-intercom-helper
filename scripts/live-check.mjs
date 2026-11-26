#!/usr/bin/env node
// A check of the helper against a running TR AI Intercom server.
//
// It creates two agents and a channel through the admin API, starts the
// built helper with every delivery method, sends real traffic, and reports
// whether each method fired and whether the console shows the helper. It
// removes the agents and the channel it created. No agent program is
// involved: the "agents" here are plain MCP requests.
//
// On an intercom with exchanges (2.0 and later) the check works in one
// exchange: the one --exchange names, or else one named "Helper live check"
// that the user owns, which is created the first time and left in place. An
// intercom without exchanges (1.x) is recognised and needs no option.
//
// On an intercom that gives join URLs (2.1 and later) it also checks
// tr-ai-intercom-mcp: a session joins with a join URL, has the intercom's
// tools, and is the same agent when it starts again; and, on an intercom
// that takes a token back (2.2 and later), that it can leave again.
//
// On an intercom with streams (2.3 and later), where the owner of the
// exchange is allowed any, it checks tr-ai-intercom-stream: an agent opens
// a stream, and a file goes from one command to another through it; and
// with a port on each end, a program talks to a server through another.
//
//   npm run build
//   node scripts/live-check.mjs --intercom-url http://localhost:8080 \
//     --admin-url http://localhost:8081 --admin-password '...'

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import Optist from 'optist';
import ou from 'optist/util.js';

const opt = new Optist()
  .opts([
    {
      longName: 'intercom-url',
      environment: 'INTERCOM_HELPER_CHECK_OPT_INTERCOM_URL',
      description: 'Root URL of the intercom, where agents reach it.',
      hasArg: true,
      defaultValue: 'http://localhost:8080',
      optArgCb: ou.nonEmptyCb,
    },
    {
      longName: 'admin-url',
      environment: 'INTERCOM_HELPER_CHECK_OPT_ADMIN_URL',
      description: 'Root URL of the admin console of the intercom.',
      hasArg: true,
      defaultValue: 'http://localhost:8081',
      optArgCb: ou.nonEmptyCb,
    },
    {
      longName: 'admin-username',
      environment: 'INTERCOM_HELPER_CHECK_OPT_ADMIN_USERNAME',
      description: "A user of the intercom's console (one without two-step login).",
      hasArg: true,
      defaultValue: 'admin',
      optArgCb: ou.nonEmptyCb,
    },
    {
      longName: 'admin-password',
      environment: 'INTERCOM_HELPER_CHECK_OPT_ADMIN_PASSWORD',
      description: 'The password of that user.',
      hasArg: true,
      required: true,
      optArgCb: ou.nonEmptyCb,
    },
    {
      longName: 'exchange',
      environment: 'INTERCOM_HELPER_CHECK_OPT_EXCHANGE',
      description:
        'Short id of the exchange to work in, where the user may manage agents and channels. Without it, an exchange named "Helper live check" that the user owns, created when missing.',
      hasArg: true,
      optArgCb: ou.nonEmptyCb,
    },
    {
      longName: 'wait',
      environment: 'INTERCOM_HELPER_CHECK_OPT_WAIT',
      description:
        'Seconds to wait for a notification the server may hold back. More than its --notify-burst-interval.',
      hasArg: true,
      defaultValue: '40',
      optArgCb: ou.integerWithLimitsCbFactory(1, 3600),
    },
  ])
  .help('live-check.mjs')
  .additional(0, 0)
  .parse();

const INTERCOM = String(opt.value('intercom-url')).replace(/\/+$/, '');
const ADMIN = String(opt.value('admin-url')).replace(/\/+$/, '');
const WAIT_MS = opt.value('wait') * 1000;
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const NOTIFY = fileURLToPath(new URL('../dist/notify-cli.js', import.meta.url));
const LOCAL = fileURLToPath(new URL('../dist/mcp-cli.js', import.meta.url));
const STREAM = fileURLToPath(new URL('../dist/stream-cli.js', import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
}
async function until(what, test, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// ---- the admin API ---------------------------------------------------------

let cookie = '';
async function admin(method, route, body) {
  const res = await fetch(`${ADMIN}/api${route}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie().map((line) => line.split(';')[0]);
  if (set.length > 0) cookie = set.join('; ');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const OWN_EXCHANGE = 'Helper live check';
/**
 * The exchange to work in, as the prefix of its routes: '' on an intercom
 * that has no exchanges (1.x), where the same routes are at the top.
 */
async function exchangePrefix() {
  const me = await admin('GET', '/me');
  const wanted = opt.value('exchange');
  if (!Array.isArray(me.exchanges)) {
    if (wanted) throw new Error('this intercom has no exchanges (1.x): leave --exchange out');
    return { prefix: '', label: '' };
  }
  let exchange;
  if (wanted) {
    exchange = me.exchanges.find((x) => x.id === wanted);
    if (!exchange) {
      throw new Error(
        `${me.user.username} cannot open an exchange with the short id "${wanted}"; they can open: ${
          me.exchanges.map((x) => `${x.id} (${x.name})`).join(', ') || 'none'
        }`,
      );
    }
    const lacking = ['agents.manage', 'channels.manage'].filter(
      (permission) => !exchange.permissions.includes(permission),
    );
    if (lacking.length > 0) {
      throw new Error(
        `in exchange ${exchange.id} (${exchange.name}) ${me.user.username} is ${exchange.role}, which may not add agents and channels: the check needs a manager or the owner`,
      );
    }
  } else {
    exchange =
      me.exchanges.find((x) => x.name === OWN_EXCHANGE && x.role === 'owner') ??
      (
        await admin('POST', '/exchanges', {
          name: OWN_EXCHANGE,
          description: 'Used by the live check of tr-ai-intercom-helper. Safe to delete.',
          mark: 'slate',
        })
      ).exchange;
  }
  if (exchange.suspended) {
    throw new Error(
      `exchange ${exchange.id} (${exchange.name}) is suspended: resume it, or name another with --exchange`,
    );
  }
  return {
    prefix: `/exchanges/${exchange.id}`,
    label: `, exchange ${exchange.id} (${exchange.name})`,
  };
}

// ---- an agent, as plain MCP requests ---------------------------------------

function agentAt(base, token) {
  let session;
  let id = 0;
  async function rpc(method, params, notification = false) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(session ? { 'Mcp-Session-Id': session } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        ...(notification ? {} : { id: ++id }),
      }),
    });
    session = res.headers.get('mcp-session-id') ?? session;
    const text = await res.text();
    if (!res.ok) throw new Error(`${method}: ${res.status} ${text}`);
    const header = res.headers.get('x-tr-ai-intercom-status-ws');
    if (notification) return { header };
    const payload = (res.headers.get('content-type') ?? '').includes('event-stream')
      ? text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => JSON.parse(line.slice(5)))
          .find((message) => message.id === id)
      : JSON.parse(text);
    if (payload?.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
    return { result: payload?.result, header };
  }
  return {
    async open() {
      const first = await rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'tr-ai-intercom-helper live check', version: '1' },
      });
      await rpc('notifications/initialized', undefined, true);
      return first.header;
    },
    async tool(name, args = {}) {
      const { result } = await rpc('tools/call', { name, arguments: args });
      const text = result?.content?.[0]?.text ?? '';
      if (result?.isError) throw new Error(`${name}: ${text}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
  };
}

// ---- the helper, with every delivery method --------------------------------

const dir = await mkdtemp(path.join(tmpdir(), 'helper-live-'));
const FILE = path.join(dir, 'notifications');
const SPOOL = path.join(dir, 'spool');
const SOCKET = path.join(dir, 'sock');
const COMMAND_OUT = path.join(dir, 'command-out');
const LISTENER = path.join(dir, 'listen.sock');

const posted = [];
const hook = http.createServer((req, res) => {
  let text = '';
  req.on('data', (c) => (text += c));
  req.on('end', () => {
    posted.push({ text, secret: req.headers['x-check'] });
    res.writeHead(204).end();
  });
});
await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));

const socketed = [];
const local = net.createServer((conn) => {
  let text = '';
  conn.on('data', (c) => (text += c));
  conn.on('end', () => {
    socketed.push(text);
    conn.end();
  });
});
await new Promise((resolve) => local.listen(SOCKET, resolve));

// The notify command, connected to the helper's listener for the whole run.
let notified = '';
let notifier;
function startNotifier() {
  notifier = spawn(
    process.execPath,
    [NOTIFY, '--monitor', '--reconnect', '--socket-path', LISTENER],
    {
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  notifier.stdout.on('data', (c) => (notified += c));
}

let helper;
async function startHelper() {
  const child = spawn(
    process.execPath,
    [
      CLI,
      `--mcp-server-url=${INTERCOM}/`,
      '--listen-port=0',
      `--notification-file=${FILE}`,
      `--notification-dir=${SPOOL}`,
      `--notification-url=http://127.0.0.1:${hook.address().port}/hook`,
      '--notification-url-header=X-Check: yes',
      `--notification-local-socket=${SOCKET}`,
      `--notification-command=cat >> '${COMMAND_OUT}'`,
      `--notification-listener-path=${LISTENER}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let log = '';
  child.stderr.on('data', (c) => (log += c));
  const lines = () =>
    log
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l));
  const listening = await until(
    'the helper to listen',
    () => lines().find((l) => l.msg === 'listening for the agent'),
    10_000,
  );
  helper = {
    child,
    lines,
    log: () => log,
    base: `http://127.0.0.1:${listening.port}`,
    exited: new Promise((resolve) => child.on('exit', resolve)),
  };
  return helper;
}

const parse = (text) =>
  text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
/** What each delivery method has received so far, as lists of notifications. */
async function received() {
  const spool = [];
  for (const name of (await readdir(SPOOL).catch(() => []))
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    spool.push({ name, ...JSON.parse(await readFile(path.join(SPOOL, name), 'utf8')) });
  }
  return {
    file: parse(await readFile(FILE, 'utf8').catch(() => '')),
    dir: spool,
    url: posted.map((p) => JSON.parse(p.text)),
    'local-socket': socketed.flatMap(parse),
    command: parse(await readFile(COMMAND_OUT, 'utf8').catch(() => '')),
    listener: parse(notified),
  };
}
/** The sequence numbers a list of notifications covers, bursts unpacked. */
const numbers = (list) =>
  list.flatMap((n) => (n.message === 'burst' ? n.data.burst.map((m) => m.seq) : [n.seq]));

// ---- joining from the chat, with tr-ai-intercom-mcp --------------------------

/** A session of some client, started in a directory: the program as the client runs it. */
async function localSession(stateDir, cwd) {
  const client = new Client({ name: 'claude-code', version: 'live-check' });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => void changed++);
  let log = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [LOCAL, '--state-dir', stateDir, '--intercom', INTERCOM],
    cwd,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (c) => (log += c));
  await client.connect(transport);
  return {
    client,
    changed: () => changed,
    log: () => log,
    tools: async () => (await client.listTools()).tools.map((t) => t.name),
    call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return { text: result.content?.[0]?.text ?? '', isError: result.isError === true };
    },
  };
}

async function checkJoining(joiner, viewOf) {
  console.log('\n  ...  joining from the chat\n');
  const stateDir = path.join(dir, 'join-state');
  const project = path.join(dir, 'join-project');
  await mkdir(project);
  const first = await localSession(stateDir, project);
  try {
    check(
      'join: a new session has the join tool only',
      (await first.tools()).join() === 'intercom_join',
    );
    const waiting = await viewOf(joiner.agent.id);
    check('join: the console shows the agent as waiting to join', Boolean(waiting.join));
    const joined = await first.call('intercom_join', { url: joiner.join.url });
    check(
      'join: the join URL makes the session the agent',
      !joined.isError && joined.text.includes(joiner.agent.name),
      joined.text.split('\n')[0].slice(0, 80),
    );
    check(
      'join: the introduction is written for the client',
      joined.text.includes("curl -fsSN '<url>' | grep -m1 ."),
    );
    await until('the changed tool list', () => first.changed() >= 1, 5000);
    const tools = await first.tools();
    check(
      'join: the session has the tools of the intercom, and no join tool',
      tools.includes('whoami') &&
        tools.includes('check_inbox') &&
        tools.includes('intercom_leave') &&
        !tools.includes('intercom_join'),
      `${tools.length} tools`,
    );
    const me = JSON.parse((await first.call('whoami')).text);
    check('join: tools work as that agent', me.name === joiner.agent.name, me.name);
    check(
      'join: the console no longer shows a join URL',
      (await viewOf(joiner.agent.id)).join === null,
    );
    const again = await first.call('intercom_join', { url: joiner.join.url });
    check('join: a session that is an agent cannot join again', again.isError);
    check(
      'join: neither the token nor the join URL is logged',
      !first.log().includes('tai_') && !first.log().includes(joiner.join.url.split('/').at(-1)),
    );
  } finally {
    await first.client.close();
  }
  const second = await localSession(stateDir, project);
  try {
    const tools = await second.tools();
    check('join: a session started there again is the agent at once', tools.includes('whoami'));
    check(
      'join: it gets the instructions of the intercom, with how its client is woken',
      (second.client.getInstructions() ?? '').includes('HOW THIS CLIENT IS WOKEN'),
    );
  } finally {
    await second.client.close();
  }
  const elsewhere = await localSession(stateDir, dir);
  try {
    check(
      'join: a session in another directory is not that agent',
      (await elsewhere.tools()).join() === 'intercom_join',
    );
    const used = await elsewhere.call('intercom_join', { url: joiner.join.url });
    check('join: a used join URL is refused', used.isError && used.text.includes('410'));
  } finally {
    await elsewhere.client.close();
  }

  // Leaving: the opposite of joining.
  const third = await localSession(stateDir, project);
  try {
    const wrong = await third.call('intercom_leave', { agent: 'somebody-else' });
    check('leave: it needs the name of the agent', wrong.isError);
    const left = await third.call('intercom_leave', { agent: joiner.agent.name });
    const revoked = left.text.includes('The intercom revoked the token');
    check(
      'leave: the session is no longer the agent',
      !left.isError && (await third.tools()).join() === 'intercom_join',
      revoked ? 'token revoked' : 'this intercom cannot take a token back (before 2.2)',
    );
    if (revoked) {
      const view = await viewOf(joiner.agent.id);
      check('leave: the console shows the agent without a token', view.has_token === false);
    }
  } finally {
    await third.client.close();
  }
  const fourth = await localSession(stateDir, project);
  try {
    check(
      'leave: a session started there afterwards is not the agent',
      (await fourth.tools()).join() === 'intercom_join',
    );
  } finally {
    await fourth.client.close();
  }
}

// ---- streams, with tr-ai-intercom-stream --------------------------------------

/** Run the bridge on one end; resolves with its status and what it wrote. */
function bridge(args, input, hear) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STREAM, ...args], {
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const out = [];
    let err = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
      hear?.(chunk.toString());
    });
    if (input) child.stdin.end(input);
    child.on('close', (status) => resolve({ status, out: Buffer.concat(out), err }));
  });
}

async function checkStreams(x, streamer) {
  await admin('PATCH', `${x}/agents/${streamer.agent.id}`, { streams: { enabled: true } });
  const agent = agentAt(INTERCOM, streamer.token);
  await agent.open();
  const made = await agent.tool('stream_open', { label: 'helper live check' });
  check(
    'stream: an agent that is allowed to opens one and gets a URL for each end',
    /\/mcp\/stream\//.test(made.ends?.a ?? '') && made.ends.a !== made.ends.b,
  );
  const sent = randomBytes(200_000);
  // The receiver has no standard input, like a command run in the background.
  const receiving = bridge(['--receive', made.ends.b]);
  await sleep(500);
  const shown = (await admin('GET', `${x}/streams`)).streams.find((s) => s.id === made.stream);
  check(
    'stream: the console shows it with one end connected',
    shown?.state === 'half',
    shown?.state,
  );
  const sender = await bridge(['--send', made.ends.a], sent);
  const receiver = await receiving;
  check('stream: the sender ends with status 0', sender.status === 0, sender.err.trim());
  check('stream: the receiver ends with status 0', receiver.status === 0, receiver.err.trim());
  check(
    'stream: what was sent arrived unchanged',
    receiver.out.equals(sent),
    `${receiver.out.length} of ${sent.length} bytes`,
  );
  check(
    'stream: the bridge never prints the URL',
    !`${sender.err}${receiver.err}`.includes('/mcp/stream/'),
  );
  const again = await bridge(['--receive', made.ends.a]);
  check(
    'stream: a URL of a stream that has ended is refused with status 1',
    again.status === 1,
    again.err.trim(),
  );

  // A port on each end: a program reaches a server through two commands.
  const echo = net.createServer((s) => {
    s.on('error', () => undefined);
    s.pipe(s);
  });
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const ported = await agent.tool('stream_open', { label: 'helper live check, ports' });
  const far = bridge(['--connect', String(echo.address().port), ported.ends.a]);
  let said = '';
  const near = bridge(['--listen', '0', ported.ends.b], undefined, (text) => (said += text));
  const at = () => /listening on 127\.0\.0\.1:(\d+)/.exec(said)?.[1];
  await until('the bridge to listen on a port', () => at(), 10_000).catch(() => undefined);
  check(
    'stream: an end listens on a port of this machine and says which',
    Boolean(at()),
    said.trim(),
  );
  if (at()) {
    const words = randomBytes(100_000);
    const got = [];
    const client = net.connect({ host: '127.0.0.1', port: Number(at()) });
    client.on('error', () => undefined);
    client.on('data', (chunk) => got.push(chunk));
    client.write(words);
    await until(
      'the echo through the stream',
      () => Buffer.concat(got).length >= words.length,
      20_000,
    ).catch(() => undefined);
    check(
      'stream: a program on that port talks to a server on the port of the other end',
      Buffer.concat(got).equals(words),
      `${Buffer.concat(got).length} of ${words.length} bytes`,
    );
    client.end();
    const [nearEnd, farEnd] = await Promise.all([near, far]);
    check(
      'stream: both ends end with status 0 when the program ends its connection',
      nearEnd.status === 0 && farEnd.status === 0,
      `${nearEnd.err.trim()} / ${farEnd.err.trim()}`,
    );
  } else {
    await agent.tool('stream_close', { stream: ported.stream });
    await Promise.all([near, far]);
  }
  echo.close();

  const left = await agent.tool('stream_list');
  check('stream: the agent has no stream left', left.streams.length === 0);
}

// ---- the run ----------------------------------------------------------------

const tag = Math.random().toString(36).slice(2, 8);
const created = { agents: [], channel: undefined };
let x = '';
let failed;
try {
  await admin('POST', '/login', {
    username: opt.value('admin-username'),
    password: opt.value('admin-password'),
  });
  const exchange = await exchangePrefix();
  x = exchange.prefix;
  const sender = await admin('POST', `${x}/agents`, { name: `check-sender-${tag}` });
  const receiver = await admin('POST', `${x}/agents`, { name: `check-receiver-${tag}` });
  created.agents.push(sender.agent.id, receiver.agent.id);
  const channel = `check-${tag}`;
  created.channel = (
    await admin('POST', `${x}/channels`, {
      name: channel,
      kind: 'pair',
      member_ids: [sender.agent.id, receiver.agent.id],
    })
  ).channel.id;
  // Being put on a channel is news to an agent (intercom 1.10.0 and later).
  // The receiver reads it now, so that the helper starts with nothing pending.
  const settling = agentAt(INTERCOM, receiver.token);
  await settling.open();
  await settling.tool('check_inbox');
  const receiverView = async () =>
    (await admin('GET', `${x}/agents`)).agents.find((a) => a.id === receiver.agent.id);

  console.log(`Intercom ${INTERCOM}, console ${ADMIN}${exchange.label}, working in ${dir}\n`);
  await startHelper();
  startNotifier();
  await until(
    'the notify command to connect',
    () => helper.lines().some((l) => l.msg === 'notification listener ready'),
    10_000,
  );
  await sleep(500);

  // The receiver talks through the helper, the sender straight to the intercom.
  const viaHelper = agentAt(helper.base, receiver.token);
  const header = await viaHelper.open();
  check('the helper passes the socket header through', Boolean(header), String(header));
  const me = await viaHelper.tool('whoami');
  check('MCP tools work through the helper', me.name === receiver.agent.name, me.name);

  await until(
    'the wake-up socket',
    () => helper.lines().some((l) => l.msg === 'wake-up socket open'),
    10_000,
  );
  check('the helper opened the wake-up socket', true);
  const shown = await until(
    'the console to show the helper',
    async () => {
      const view = await receiverView();
      return view.helper_connected ? view : undefined;
    },
    10_000,
  );
  check(
    'the console shows the helper as connected',
    shown.helper_connected,
    `since ${shown.helper_since}`,
  );

  const direct = agentAt(INTERCOM, sender.token);
  await direct.open();
  const before = await received();
  check(
    'nothing is delivered while nothing happens',
    Object.values(before).every((list) => list.length === 0),
  );

  const opened = await direct.tool('open_conversation', {
    channel,
    subject: 'Live check',
    body: 'a body that must not travel',
  });
  const first = await until(
    'the first notification on every method',
    async () => {
      const now = await received();
      return Object.values(now).every((list) => list.length >= 1) ? now : undefined;
    },
    10_000,
  );
  for (const [method, list] of Object.entries(first)) {
    const n = list[0];
    check(
      `${method}: the first notification arrives at once`,
      n.message === 'inbox-activity' && Number.isInteger(n.seq) && JSON.stringify(n.data) === '{}',
      `${n.message} seq ${n.seq}`,
    );
  }
  const seq = first.file[0].seq;
  check(
    'dir: the file is named by the sequence number',
    first.dir[0].name === `${seq.toString(16).padStart(8, '0')}.json`,
    first.dir[0].name,
  );
  check('url: the extra header is sent', posted[0].secret === 'yes');
  check(
    'no method received anything of the message',
    !/must not travel|Live check|check-sender/.test(JSON.stringify(first)),
  );

  // Two more, close together: the server may hold them back and send a burst.
  await direct.tool('post_message', {
    conversation_id: opened.conversation.conversation_id,
    kind: 'follow_up',
    body: 'second',
  });
  await direct.tool('post_message', {
    conversation_id: opened.conversation.conversation_id,
    kind: 'follow_up',
    body: 'third',
  });
  console.log(`\n  ...  waiting up to ${WAIT_MS / 1000} s for the two that follow\n`);
  const later = await until(
    'the following notifications on every method',
    async () => {
      const now = await received();
      return Object.values(now).every((list) => numbers(list).includes(seq + 2)) ? now : undefined;
    },
    WAIT_MS,
  );
  for (const [method, list] of Object.entries(later)) {
    const got = numbers(list);
    check(
      `${method}: every notification arrived, in order`,
      JSON.stringify(got) === JSON.stringify([seq, seq + 1, seq + 2]),
      `${list.map((n) => n.message).join(', ')}: ${got.join(' ')}`,
    );
  }
  // The notify command unrolls bursts, so it is compared by what it covers.
  const { listener: viaListener, ...pushed } = later;
  check(
    'every method received the same',
    new Set(
      Object.values(pushed).map((list) => JSON.stringify(list.map(({ name: _name, ...n }) => n))),
    ).size === 1,
  );
  check(
    'the notify command printed each notification on a line of its own',
    viaListener.length === 3 && viaListener.every((n) => n.message !== 'burst'),
    viaListener.map((n) => n.message).join(', '),
  );

  // Stop the helper, let something happen, start it again.
  helper.child.kill('SIGTERM');
  check('the helper stops cleanly', (await helper.exited) === 0);
  const gone = await until(
    'the console to notice',
    async () => {
      const view = await receiverView();
      return view.helper_connected ? undefined : view;
    },
    10_000,
  );
  check('the console shows the helper as gone', !gone.helper_connected);

  await direct.tool('open_conversation', { channel, subject: 'While away', body: 'fourth' });
  const countBefore = (await received()).file.length;
  await startHelper();
  await agentAt(helper.base, receiver.token).open();
  await until(
    'the wake-up socket',
    () => helper.lines().some((l) => l.msg === 'wake-up socket open'),
    10_000,
  );
  const missed = await until(
    'the missed notification',
    async () => {
      const now = await received();
      return now.file.length > countBefore ? now : undefined;
    },
    10_000,
  );
  const last = missed.file.at(-1);
  check(
    'a restarted helper says that something was missed',
    last.message === 'missed' && last.seq === seq + 3,
    `${last.message} seq ${last.seq}`,
  );
  const viaNotify = await until(
    'the notify command to print it too',
    async () => {
      const list = (await received()).listener;
      return list.at(-1)?.message === 'missed' ? list : undefined;
    },
    15_000,
  );
  check(
    'the notify command reconnected to the restarted helper',
    viaNotify.at(-1).seq === seq + 3,
    `missed seq ${viaNotify.at(-1).seq}`,
  );
  check('the helper never logs a token', !helper.log().includes('tai_'));

  const again = agentAt(helper.base, receiver.token);
  await again.open();
  const inbox = await again.tool('check_inbox');
  check(
    'the receiver finds its messages in the inbox',
    inbox.unread.length === 2,
    `${inbox.unread.length} conversations`,
  );

  // Joining from the chat, where the intercom gives join URLs.
  if (sender.join) {
    const joiner = await admin('POST', `${x}/agents`, { name: `check-joiner-${tag}` });
    created.agents.push(joiner.agent.id);
    await checkJoining(joiner, async (id) =>
      (await admin('GET', `${x}/agents`)).agents.find((a) => a.id === id),
    );
  } else {
    console.log('\n  ...  this intercom gives no join URLs (before 2.1): joining is not checked');
  }

  // Streams, where the intercom has them and the owner of the exchange is allowed any.
  const ceiling = (await admin('GET', `${x}/overview`)).stream_ceiling;
  if (!ceiling) {
    console.log('\n  ...  this intercom has no streams (before 2.3): the bridge is not checked');
  } else if (ceiling.max_open === 0) {
    console.log(
      '\n  ...  streams are not allowed in this exchange (the quota of its owner): the bridge is not checked',
    );
  } else {
    const streamer = await admin('POST', `${x}/agents`, { name: `check-streamer-${tag}` });
    created.agents.push(streamer.agent.id);
    await checkStreams(x, streamer);
  }
} catch (err) {
  failed = err;
} finally {
  helper?.child.kill('SIGTERM');
  notifier?.kill('SIGTERM');
  hook.close();
  local.close();
  try {
    if (created.channel) await admin('DELETE', `${x}/channels/${created.channel}`);
    for (const id of created.agents) await admin('DELETE', `${x}/agents/${id}`);
  } catch (err) {
    console.error(`Could not remove what the check created: ${err.message}`);
  }
  await rm(dir, { recursive: true, force: true });
}

if (failed) {
  console.error(`\nThe check stopped: ${failed.message}`);
  if (helper) console.error(helper.log());
  process.exit(1);
}
const bad = results.filter((ok) => !ok).length;
console.log(`\n${results.length - bad} of ${results.length} checks passed.`);
process.exit(bad === 0 ? 0 : 1);
