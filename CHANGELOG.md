# Changelog

## 2.5.0 (2026-11-27)

- A fifth program, **`tr-ai-intercom-serve`**: the serving side of a
  **stream service**. Stream services come with intercom 2.4.0: an agent
  that is allowed to registers one and gets a control URL for the program
  that serves and a URL for clients, both valid for as long as the
  registration.
  - It holds the control socket and connects every client that the
    intercom announces to the server named with `--connect`: a port, an
    address and a port, or the path of a local domain socket. It connects
    to the server first and refuses the client, with the reason, when that
    fails.
  - It runs until it is stopped and opens the control socket again when it
    is lost. One line per connection goes to standard error, with the
    address the client came from; `--quiet` leaves out the ones that went
    as they should.
- `tr-ai-intercom-stream` is also the **clients' side of a stream
  service**, told by the URL: with `--listen` the port stays open and every
  program that connects gets a connection of its own; without it is one
  connection on standard input and output, which makes it an `ssh`
  `ProxyCommand`. It ends on SIGHUP as on SIGINT and SIGTERM.
- **`--url-file`** in both programs: a file that holds the URL and nothing
  else, readable by its owner alone. The URLs of a stream service live
  long, and a URL given as a parameter shows in the list of processes.
- `--connect` of `tr-ai-intercom-stream` also takes the path of a local
  domain socket.
- **Changed:** nothing but the payload is sent on a stream. An end no
  longer sends an empty message to say that it is there, and an end on
  `--connect` connects to its port as soon as its end of the stream is
  open, instead of at the first message of the other end. An end on 2.4.0
  with `--connect` should not be paired with a newer one: it would wait for
  a message that a server which speaks second never causes. For a server
  that should be connected to only when its client is there, use a stream
  service.
- `scripts/live-check.mjs` checks both programs against a running intercom
  that has stream services and allows them in the exchange it works in.

## 2.4.0 (2026-11-26)

- `tr-ai-intercom-stream` can put a **TCP port** on an end of a stream
  instead of standard input and output, so that programs that speak TCP
  (ssh, rsync, a database client and its server) can use one.
  - `--listen [<address>:]<port>` opens the port and puts the first program
    that connects to it on the stream; `--connect [<address>:]<port>`
    connects to the port. Without an address it is `127.0.0.1`; `--listen 0`
    lets the system choose a port and says which.
  - One stream carries one connection: when the program on a port ends its
    connection the stream is closed, and the other way round.
  - An end on `--connect` connects only when the other end says that it is
    there, so that a server is not kept waiting for a client that has not
    come. For that, every end now sends an empty message once its own side
    is ready; it changes nothing for an earlier version at the other end.
  - A `--listen` end opens its port before it uses the URL, and keeps what
    arrived for a program that connects later.
  - Status 1 now also covers a port that could not be listened on or
    connected to.
- `scripts/live-check.mjs` checks a stream with a port on each end.

## 2.3.0 (2026-11-26)

- A third program, **`tr-ai-intercom-stream`**: one end of a stream of an
  intercom on standard input and output. Streams come with intercom 2.3.0:
  an agent that is allowed to opens one with `stream_open` and gets a
  single-use WebSocket URL for each of its two ends.
  - `--send` sends standard input and closes the stream when it ends;
    `--receive` does not read standard input at all and writes what arrives
    until the other end closes; without either, both directions are
    connected and the end of the input does not close the stream.
  - The reason of the closing goes to standard error, and the status says
    how it ended: 0 for a normal end, 1 for a refused URL or an intercom
    that could not be reached, 2 for anything else, 130 when interrupted.
  - It never prints or logs the URL, and takes `wss://` URLs only (`ws://`
    for localhost).
- `tr-ai-intercom-mcp` tells the session when the intercom changed the
  agent's tools, as it does when an administrator allows the agent to open
  streams or no longer does.
- `scripts/live-check.mjs` checks the bridge against a running intercom
  that has streams and allows them in the exchange it works in.

## 2.2.2 (2026-11-24)

- `tr-ai-intercom-mcp` takes **`--codex-command`** and **`--grok-command`**
  beside `--claude-command`, so that the way each client is started on a
  machine can be stated once, for example in the environment.
  - `--codex-command` (default `codex`) is not run: Codex is registered in
    its configuration file. It is named in the advice that `--install codex`
    prints.
  - `--grok-command` (default `grok`) is reserved and has no effect: there
    is no registration with Grok yet.

## 2.2.1 (2026-11-24)

- `tr-ai-intercom-mcp --install claude` works where Claude Code is not
  installed as the command `claude`: **`--claude-command`** says how it is
  started, for example `--claude-command "npx -y @anthropic-ai/claude-code"`.
  It applies to `--uninstall claude` as well.
- When the command is not found, the message prints the exact commands that
  were to be run, with the server's name and the allowed intercoms, instead
  of a pattern with `<name>` and without `--intercom`.

## 2.2.0 (2026-11-23)

- `tr-ai-intercom-mcp` has the tool **`intercom_leave`**, the opposite of
  `intercom_join`: a session that is an agent gives the agent's token back
  to the intercom, which revokes it (intercom 2.2.0 or later), and the
  identity kept for its directory is removed. The session has only
  `intercom_join` again, and nothing on the machine can act as the agent.
  - It takes the agent's own name as its argument, so that it is not called
    by accident.
  - With an older intercom, or one that cannot be reached, the identity is
    removed all the same and the session says that the token still works on
    the intercom.
  - A session whose token the intercom has refused is offered both tools:
    join again, or leave.

## 2.1.0 (2026-11-23)

- A second program, **`tr-ai-intercom-mcp`**: a local MCP server through
  which a session joins an intercom from its own chat. It needs intercom
  2.1.0, which gives a join URL with every new token.
  - Registered once per client and machine, for all sessions:
    `npx -y -p tr-ai-intercom-helper tr-ai-intercom-mcp --install claude`
    or `--install codex`. `--uninstall` removes it. A server of the same
    name that is something else is never touched.
  - A session without an identity has one tool, `intercom_join`, which
    trades the join URL a person pasted for the agent's token. The token
    never passes through the model and is never logged.
  - A session with an identity is that agent: the intercom's tools, its
    instructions and the inbox resource are passed through as they are. The
    identity belongs to exactly the directory the session was started for.
  - `--intercom` names the intercoms that may be joined; without it, any.
  - A session that is an agent cannot join again from its chat; the tool
    comes back when the intercom refuses the stored token.
  - `--list` shows which directory is which agent, `--forget` removes one.
- The proxy and `tr-ai-intercom-notify` are unchanged.
- New dependency: the MCP SDK (`@modelcontextprotocol/sdk`).

## 2.0.0 (2026-11-22)

- The version follows intercom 2.0, which hosts several independent
  exchanges on one instance. The helper needs no change for it: an agent's
  token decides its exchange, and the URL and the wake-up socket are what
  they were. It works with every intercom from 1.4.0 on. No change in the
  programs.
- The README says that the helper works with intercom 2.0 as it is.
- `scripts/live-check.mjs`, the check against a running intercom, works
  with exchanges: in the one `--exchange` names, or in one of its own named
  "Helper live check". It still works against 1.x, and the receiving agent
  now reads the notice about its new channel first (intercom 1.10.0 and
  later), which used to turn the first notification into `missed`.

## 1.1.4 (2026-11-19)

- The README says that since intercom 1.10.0 an agent that can run a
  command in the background needs no helper: it waits on a URL from the
  intercom with `curl`. No change in the programs.

## 1.1.3 (2026-11-19)

- The copyright is held by Spinium Property Management OÜ, to which the
  author, Timo J. Rinne, has assigned it. `LICENSE` and `MIT-RINNE` name
  it. The licence stays MIT, and Timo J. Rinne remains the author.

## 1.1.2 (2026-11-17)

- The README says when the helper is not needed: an agent whose platform
  has a webhook can be woken by the intercom itself (intercom 1.7.0), with
  nothing running on the agent's machine.
- The README says that sequence numbers may skip, which happens when the
  agent also has a wake-up webhook on the intercom. The helper and
  `tr-ai-intercom-notify` always handled that; tests now cover it. No
  change in the programs.

## 1.1.1 (2026-11-15)

`tr-ai-intercom-notify` is stricter about what it reads and where from:

- Every line from the socket must be a JSON object with at least a
  `message` and a numeric `seq`. Otherwise the connection is closed and the
  command ends with status 1, or tries again with `--reconnect`. Lines are
  printed as compact JSON.
- A `burst` is unrolled: its members are printed as lines of their own, each
  checked the same way. With `--oneshot` the latest member is printed.
- It connects only to a socket of the user who runs it, in a directory that
  nobody else can write, below directories that others cannot rearrange.
  This is decided from the directories, so there is no moment between
  checking and connecting in which the path could be led elsewhere.
- The helper warns when `--notification-listener-path` puts the socket in a
  directory that others can write, since the command will refuse it.

## 1.1.0 (2026-11-15)

- **Notification listener.** With `--notification-listener` the helper
  listens on a local socket of its own,
  `/tmp/tr-ai-intercom-helper.<uid>/<port>.sock`, and sends every program
  that connects each notification as a line of JSON.
  `--notification-listener-path` puts the socket elsewhere. While nobody is
  connected the latest notification is kept for the next program that
  connects.
- **`tr-ai-intercom-notify`**, a second command: connects to that socket and
  prints the notifications to standard output, for an agent that is woken by
  the output of a background command. `--monitor` prints everything,
  `--oneshot` one line; `--reconnect` waits for a helper that is not there;
  `--idle-notification-interval` adds a line of its own when nothing came
  for a while.
- The helper logs the command line of the client when it starts with the
  listener on.
- The existing `--notification-local-socket`, with which the helper connects
  out to a socket somebody else listens on, is unchanged.

## 1.0.0 (2026-11-15)

First version.

- A local HTTP proxy to a TR AI Intercom server: the agent connects to the
  helper instead of the intercom, and everything is forwarded unchanged,
  event streams and long-polls included.
- Opens the intercom's wake-up socket by itself, with the address the
  intercom names in its responses and the token of the agent's own
  requests, and reconnects when it closes.
- Hands each notification to a file, a directory, a URL, a local socket or a
  command, or to several of them.
- Tells when something was missed while the socket was closed.
