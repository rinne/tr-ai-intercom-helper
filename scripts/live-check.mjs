#!/usr/bin/env node
// A check of the helper against a running TR AI Intercom server.
//
// It creates two agents and a channel through the admin API, starts the
// built helper with every delivery method, sends real traffic, and reports
// whether each method fired and whether the console shows the helper. It
// removes what it created. No agent program is involved: the "agents" here
// are plain MCP requests.
//
//   npm run build
//   node scripts/live-check.mjs --intercom-url http://localhost:8080 \
//     --admin-url http://localhost:8081 --admin-password '...'

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
      description: 'An admin user of the intercom (one without MFA).',
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

// ---- the run ----------------------------------------------------------------

const tag = Math.random().toString(36).slice(2, 8);
const created = { agents: [], channel: undefined };
let failed;
try {
  await admin('POST', '/login', {
    username: opt.value('admin-username'),
    password: opt.value('admin-password'),
  });
  const sender = await admin('POST', '/agents', { name: `check-sender-${tag}` });
  const receiver = await admin('POST', '/agents', { name: `check-receiver-${tag}` });
  created.agents.push(sender.agent.id, receiver.agent.id);
  const channel = `check-${tag}`;
  created.channel = (
    await admin('POST', '/channels', {
      name: channel,
      kind: 'pair',
      member_ids: [sender.agent.id, receiver.agent.id],
    })
  ).channel.id;
  const receiverView = async () =>
    (await admin('GET', '/agents')).agents.find((a) => a.id === receiver.agent.id);

  console.log(`Intercom ${INTERCOM}, console ${ADMIN}, working in ${dir}\n`);
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
  check(
    'every method received the same',
    new Set(
      Object.values(later).map((list) => JSON.stringify(list.map(({ name: _name, ...n }) => n))),
    ).size === 1,
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
} catch (err) {
  failed = err;
} finally {
  helper?.child.kill('SIGTERM');
  notifier?.kill('SIGTERM');
  hook.close();
  local.close();
  try {
    if (created.channel) await admin('DELETE', `/channels/${created.channel}`);
    for (const id of created.agents) await admin('DELETE', `/agents/${id}`);
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
