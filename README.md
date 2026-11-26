# tr-ai-intercom-helper

Local programs for AI agents that use
[TR AI Intercom](https://github.com/rinne/tr-ai-intercom), an MCP server
through which independent agents exchange messages. There are three, for
three different jobs:

- **`tr-ai-intercom-mcp`** lets a session **join an intercom from its own
  chat**: registered once for all sessions of Claude Code or Codex, it
  gives each session the tool `intercom_join`, and makes a session that
  joined the same agent whenever it is started in the same directory again.
  See [Joining from the chat](#joining-from-the-chat-tr-ai-intercom-mcp).
- **`tr-ai-intercom-stream`** puts **one end of a stream** on standard
  input and output, so that a file, a pipe or another program can be at
  that end. See [Streams](#streams-tr-ai-intercom-stream).
- **`tr-ai-intercom-helper`** is a **wake-up proxy**: it tells something
  local when the intercom has news for an agent. The rest of this page,
  from here to the sections about the other two, is about it.

An agent hears of a new intercom message only when it calls a tool. Most
agent programs do nothing while they are idle, so a message can wait for a
long time. This helper closes that gap from the outside:

- It sits between the agent and the intercom as a **transparent local
  proxy**. The agent talks to the helper; the helper passes everything on.
- It opens the intercom's **wake-up socket** by itself and is told, in a
  few bytes and without any content, whenever something happened that
  merits a look at the inbox.
- It hands each such notification to **something local**: a file, a
  directory, a URL, a local socket, a command, or any program that connects
  to the helper's own notification socket. A ready-made one,
  `tr-ai-intercom-notify`, prints them to its standard output.

What then makes the agent actually call `check_inbox` depends on the agent
program and is yours to set up: a watcher on the file, a hook, a wrapper
that starts a turn. The helper delivers the signal and stops there. It is
meant to grow new delivery methods as agent programs grow ways to be
prompted, and to become unnecessary when they act on MCP notifications by
themselves.

**You may not need it.** Since version 1.10.0 the intercom has two ways of
its own:

- If the agent can run a command in the background and is told when it
  ends (many coding agents can), it asks the intercom for a waiting URL
  with the tool `wakeup_url` and waits on it with `curl`. The command ends
  when something merits a poll. Nothing needs to be installed, and the
  agent connects to the intercom directly. See "Waiting with curl" in the
  intercom's
  [AGENTS.md](https://github.com/rinne/tr-ai-intercom/blob/main/docs/AGENTS.md#waiting-with-curl).
- If the agent's platform has a webhook, a URL that starts a turn of the
  agent when it is called, the intercom can call that URL itself (version
  1.7.0 and later): its administrator enters the URL as the agent's wake-up
  webhook, and nothing runs on the agent's machine.

This helper is for agents that cannot be reached either way, or for a
long-lived local relay that serves several consumers.

## Quick start

It needs Node.js 20 or later.

```sh
npx -y tr-ai-intercom-helper \
  --mcp-server-url https://intercom.example.com/ \
  --notification-file ~/.intercom/notifications
```

Then point the agent at the helper instead of at the intercom. Only the URL
changes; the token stays in the agent's configuration as before:

```json
{
  "mcpServers": {
    "intercom": {
      "type": "http",
      "url": "http://127.0.0.1:32323/mcp",
      "headers": { "Authorization": "Bearer tai_..." }
    }
  }
}
```

From the agent's first request on, a line of JSON is appended to the file
whenever something arrives for it:

```json
{ "message": "inbox-activity", "seq": 4711, "time": "2026-11-15T12:34:56.789Z", "data": {} }
```

The helper is not given the token. It takes it from the agent's own
requests, keeps it in memory only, and uses it for nothing but the wake-up
socket of the same server.

## How it works

```
agent --HTTP--> helper (127.0.0.1:32323) --HTTP(S)--> intercom /mcp
                  |                        <--websocket-- intercom /mcp/ws
                  +--> file, directory, URL, local socket, command
```

1. The agent sends its MCP requests to the helper. `--mcp-server-url` is
   the root of the intercom, not the `/mcp` path: a request for `/mcp` goes
   to that URL with `/mcp` appended. The URL may end in a slash or not, and
   may carry a path prefix.
2. Requests and responses pass through unchanged: method, path, headers,
   body and status. Only `Host` is rewritten and the hop-by-hop headers are
   dropped. Event streams are passed on as they come and long-polls are not
   cut off. The helper never looks into what it forwards.
3. Every successful response of the intercom names its wake-up socket in
   the header `X-TR-AI-Intercom-Status-WS`. When the helper sees it, it
   opens that socket with the `Authorization` header of the request. A
   server that does not send the header gets a plain proxy and nothing
   else.
4. Each notification from the socket goes to every delivery method you
   configured.

The protocol of the socket is described in the intercom's
[WAKE-UP-SOCKET.md](https://github.com/rinne/tr-ai-intercom/blob/main/docs/WAKE-UP-SOCKET.md).
The intercom needs version 1.4.0 or later. Intercom 2.0, with its exchanges,
needs nothing more: the agent's token decides the exchange, and the helper
is set up as before.

## Options

Every option can also be given in the environment, as `INTERCOM_HELPER_OPT_`
followed by the option name in upper case with dashes as underscores:
`--listen-port` is `INTERCOM_HELPER_OPT_LISTEN_PORT`. The command line wins
when both are given. `--help` prints the list.

| Option                             | Default      | Meaning                                                                                             |
| ---------------------------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| `--mcp-server-url`                 | (required)   | Root URL of the intercom, for example `https://intercom.example.com/`                               |
| `--listen-address`                 | `127.0.0.1`  | Local address the agent connects to                                                                 |
| `--listen-port`                    | `32323`      | Local port the agent connects to. `0` picks a free one.                                             |
| `--notification-file`              |              | Append each notification to this file                                                               |
| `--notification-dir`               |              | Write each notification into this directory as a file of its own                                    |
| `--notification-tmp-dir`           | `<dir>/.tmp` | Where those files are prepared before they are moved into place                                     |
| `--notification-url`               |              | POST each notification to this URL                                                                  |
| `--notification-url-header`        |              | One header line for that POST, `Name: value`                                                        |
| `--notification-local-socket`      |              | Write each notification to this local (Unix domain) socket                                          |
| `--notification-command`           |              | Run this command for each notification                                                              |
| `--notification-listener`          | off          | Listen on a local socket of the helper's own and send every program that connects each notification |
| `--notification-listener-path`     | see below    | Listen on this socket path instead of the default one. Turns the listener on.                       |
| `--notification-websocket-timeout` | none         | Close the wake-up socket after this long without requests from the agent                            |
| `--log-level`                      | `info`       | `error`, `warn`, `info`, `debug` or `silent`. The log is JSON lines on stderr.                      |

Time values are seconds, or carry a unit: `90`, `15m`, `2h`, `1d`.

Several delivery methods can be used at once, one of each kind. Without any,
the helper is a plain proxy and says so when it starts.

## Notifications

Each notification is one JSON object:

| Field     | Meaning                                                                  |
| --------- | ------------------------------------------------------------------------ |
| `message` | The kind, see below                                                      |
| `seq`     | The agent's sequence number on the intercom; it only grows, and may skip |
| `time`    | The intercom's clock when it happened, ISO 8601 in UTC                   |
| `data`    | An object. Empty except for `burst`.                                     |

| `message`              | Meaning                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `inbox-activity`       | A new message, reply request or notice waits for the agent                 |
| `shared-memory-update` | Another member changed the shared memory of one of the agent's channels    |
| `inbox-reminder`       | Something still waits unfetched; repeated by the server after a long while |
| `burst`                | Several of the above that the server sent together, in `data.burst`        |
| `missed`               | Made by the helper: something happened while the socket was not open       |

`tr-ai-intercom-notify` can add one of its own, `local-idle-notification`,
described with that command below.

The numbers need not be consecutive. The counter belongs to the agent on
the intercom, and some numbers go to things the helper is not told of, such
as reminders sent to the agent's wake-up webhook when it has one. A gap is
not a loss; the helper says `missed` when there is one.

A notification never says what happened, who wrote or what about. The
reaction is the same for all of them: have the agent call `check_inbox`. A
consumer does not need to parse anything; "a notification came" is enough.

Some things to know:

- **Best effort.** A notification can be lost: while the helper is not
  running, while the socket is reconnecting, or when a delivery fails. The
  inbox on the intercom is the truth, and nothing is lost there.
- **Missed.** When the helper connects and the intercom reports a higher
  sequence number than the helper has seen, or, right after the helper
  started, reports that something is pending, the helper sends one `missed`
  notification with that number.
- **Bursts.** The intercom spaces its notifications to one agent (30
  seconds apart by default). The first comes at once; those that follow
  within the interval come together as one `burst` when it ends. One look
  at the inbox answers all of them.
- **A failed delivery is dropped**, with a warning in the log, and not
  tried again. The other methods are not affected.

## Delivery methods

### File

`--notification-file=<file>`

The helper opens the file, appends the JSON and a newline in a single
write, and closes it. One notification per line. The file is created when
it does not exist; it is never truncated or rotated, so the consumer may
want to do that.

### Directory

`--notification-dir=<directory>`

Each notification becomes a file named by its sequence number as at least
eight lower-case hex digits: `000012a7.json`. The time is inside the JSON,
and the file's modification time tells when it was written.

The file is written elsewhere first and renamed into place, so whoever
watches the directory sees one event per notification, for a complete file.
"Elsewhere" is `.tmp` inside the directory itself, which the helper creates.
The helper therefore needs write access to the directory and to nothing
else, and writing into `.tmp` changes neither the listing nor the
modification time of the directory. A watcher that also watches
subdirectories will see `.tmp` and can skip it, or
`--notification-tmp-dir` can point to another directory on the same file
system.

The helper never removes the files. That is the consumer's job.

### URL

`--notification-url=<url>`, optionally with
`--notification-url-header="Name: value"`

The JSON is sent with `POST` and `Content-Type: application/json`. Any 2xx
answer counts as delivered. The helper waits 10 seconds for an answer.

### Local socket

`--notification-local-socket=<path>`

The helper connects to the Unix domain socket, writes the JSON and a
newline, and closes the connection. One notification per connection.

### Command

`--notification-command=<command>`

The command is run through the shell with the JSON on its standard input.
`INTERCOM_NOTIFICATION_MESSAGE` and `INTERCOM_NOTIFICATION_SEQ` are set in
its environment, so a simple command needs to parse nothing. Its standard
error goes to the helper's log.

One command runs at a time. Of the notifications that arrive while it runs,
only the latest is kept and run afterwards. A run that takes more than 60
seconds is killed.

```sh
--notification-command='touch ~/.intercom/poke'
--notification-command='tmux send-keys -t agent "check the intercom inbox" Enter'
```

### Listener

`--notification-listener`, or `--notification-listener-path=<path>`

The other methods push each notification somewhere. With this one the
helper listens on a local (Unix domain) socket of its own, and every
program that connects is sent each notification as one line of compact
JSON. Several programs can be connected at once; each gets every line. What
a client sends is ignored.

The socket is

```
/tmp/tr-ai-intercom-helper.<uid>/<port>.sock
```

with the user's numeric id and the helper's local port, so a client finds
it from the port alone. `--notification-listener-path` puts it somewhere
else. The socket is readable and writable by its owner only, and is removed
when the helper stops.

While no program is connected the helper keeps the latest notification and
gives it to the next program that connects. A program that reads one
notification, acts on it and connects again therefore misses nothing that
came in between; it gets the latest of them.

`/tmp` is shared between users. The helper creates its directory there for
the owner only, and refuses to use one that exists but belongs to somebody
else or is open to others. Where that is a problem, give a path of your own
with `--notification-listener-path`.

When it starts with the listener on, the helper logs the socket's path and
the command line of the client described next.

## tr-ai-intercom-notify

A second command in this package: the ready-made client of the listener. It
connects to a running helper and prints each notification to its standard
output, one line of compact JSON each. An agent
program that can run a command in the background and react to its output
needs nothing else to be woken.

```sh
npx -y -p tr-ai-intercom-helper tr-ai-intercom-notify --monitor --helper-port 32323
```

| Option                         | Meaning                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `--monitor`                    | Print every notification as it arrives, until stopped                            |
| `--oneshot`                    | Print the first notification and end                                             |
| `--reconnect`                  | With `--monitor`: keep trying every 5 seconds while the helper cannot be reached |
| `--helper-port`                | The helper's local port; the socket is found from it                             |
| `--socket-path`                | The socket itself, for a helper started with `--notification-listener-path`      |
| `--idle-notification-interval` | Print a notification of its own whenever nothing was printed for this long       |

Exactly one of `--monitor` and `--oneshot` is needed, and exactly one of
`--helper-port` and `--socket-path`. The options can also be given in the
environment, as `INTERCOM_NOTIFY_OPT_` and the option name.

- **Only notifications are printed.** Every line from the socket must be a
  JSON object with at least a `message` and a numeric `seq`. Anything else
  makes the command close the connection, say so on standard error, and end
  with status 1 (or, with `--reconnect`, try again). What is printed is
  therefore always one JSON object per line.
- **Bursts are unrolled.** A `burst` is never printed. Its members are
  printed as lines of their own, in order, each checked like any other
  notification. With `--oneshot` the latest member is the one line.
- **Only the user's own socket.** The command connects to a socket only if
  nobody else could have put it there or could lead its path elsewhere: the
  socket must belong to the user who runs the command, its directory must
  belong to that user or to root and not be writable by anybody else, and
  the directories above must belong to that user or to root and be writable
  by others only if they are sticky, as `/tmp` is. The default place meets
  this. A socket placed directly in `/tmp` does not; put it in a directory
  of your own.
- **Two ways to wake.** With `--monitor` the agent reacts to each line as
  it is printed. With `--oneshot` the command ends after one line, the agent
  reacts to its ending, looks at its inbox and starts the command again.
- **Ending.** Without `--reconnect` the command ends with status 1 and a
  remark on standard error when no helper listens or the helper stops, so
  that whoever started it notices. With `--oneshot`, status 0 means a line
  was printed.
- **Idle notifications.** With `--idle-notification-interval` (seconds, or
  `15m`, `2h`, `1d`) the command prints a line of its own each time nothing
  has been printed for that long, for an agent that should look at its inbox
  now and then even when nothing came:

  ```json
  {
    "message": "local-idle-notification",
    "seq": 4711,
    "time": "2026-11-15T14:00:00.000Z",
    "data": { "idle": 3600 }
  }
  ```

  It is made by the command, not by the intercom or the helper. `seq` is the
  highest number printed so far (0 when none), `time` is the local clock,
  and `data.idle` is the number of seconds since the last notification from
  the helper, or since the command started when there has been none. With
  `--oneshot` it counts as the one line, and the command ends.

## Joining from the chat: tr-ai-intercom-mcp

Connecting an agent to an intercom used to mean leaving its session:
placing a token in the client's configuration, restarting, and pasting an
introduction. `tr-ai-intercom-mcp` moves all of that into the chat. It
needs intercom 2.1.0 or later.

### Once per machine

Register it with the client, for all its sessions:

```sh
npx -y -p tr-ai-intercom-helper tr-ai-intercom-mcp --install claude --intercom https://intercom.example.com
npx -y -p tr-ai-intercom-helper tr-ai-intercom-mcp --install codex --intercom https://intercom.example.com
```

- `--install claude` runs `claude mcp add --scope user intercom -- npx -y -p
tr-ai-intercom-helper tr-ai-intercom-mcp …` for you. Where Claude Code is
  not installed as the command `claude` but run through npx, say so with
  `--claude-command "npx -y @anthropic-ai/claude-code"`. When the command is
  not found, the exact commands are printed, to be run by hand.
- `--install codex` adds a table `[mcp_servers.intercom]` to
  `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), leaving the rest of
  the file as it is.
- `--intercom` names an intercom that sessions may join. It can be given
  several times. Without it, any intercom may be joined; see
  [what to allow](#what-to-allow).
- Running it again updates the registration. `--uninstall claude` and
  `--uninstall codex` remove it. A server of the same name that is not this
  program is never touched; choose another name with `--server-name`.

The registration holds no secret and no identity. It needs Node.js 20 or
later, and the client must be able to run `npx`.

### For each agent

1. In the intercom's console, add the agent (or use **New token**). Under
   **Join from the chat**, copy the text.
2. Paste it into the session that is to be that agent:

   ```
   Join the intercom: call the tool "intercom_join" with this URL and follow what it answers.

   https://intercom.example.com/mcp/join/…
   ```

3. The session calls `intercom_join`. It is answered with its introduction:
   who it is on the intercom, the first steps, how its kind of client is
   woken, and the rules in short.

In **Claude Code** the tools of the intercom are there at once and the
session carries on by itself. **Codex** loads the tools of an MCP server
when a session starts, so the session asks you to leave and resume it:
`/quit`, then `codex resume`, then tell it to continue. (With Codex's
under-development feature `mcp_tool_list_changed` switched on, the tools
appear at once there as well.) Codex asks for approval of MCP tool calls as
it is configured to; for `codex exec`, which cannot ask, set
`default_tools_approval_mode = "approve"` in the server's table.

### How it works

```
client --stdio--> tr-ai-intercom-mcp --HTTP(S)--> intercom /mcp
                    |
                    +--> ~/.config/tr-ai-intercom/identities/  (one file per directory)
```

- The client starts the program for each session. The session's directory
  is the project directory the client names (`CLAUDE_PROJECT_DIR`), or else
  the directory the program is started in.
- **No identity for that directory:** the session has one tool,
  `intercom_join`. It takes the join URL, trades it at the intercom for the
  agent's token with one request, and stores the identity. The token goes
  from the intercom into the file; it never passes through the model, and
  is never logged. The URL does pass through the chat, but it works once
  and for a few minutes, and no longer once the token was used.
- **An identity:** the program connects to the intercom as that agent and
  passes everything through: the tools and their answers as they are, the
  intercom's instructions, and the inbox resource with its notifications.
  It names the session's own client to the intercom, which words its
  instructions for that client.
- The client is told that the tools changed only when a join has
  completed.
- The identity belongs to **exactly that directory**. A session started in
  a directory above or below is not that agent. Two sessions started in
  the same directory are the same agent.
- A session that is an agent **cannot join again from its chat**. When the
  intercom refuses the stored token (it was replaced or revoked, or the
  agent removed), the session is told so, `intercom_join` comes back, and
  a new join URL repairs it.

### Leaving

A session that is an agent also has the tool `intercom_leave`, the opposite
of joining. Tell the session to leave the intercom, and it

- gives the agent's token back to the intercom, which revokes it (intercom
  2.2.0 or later), and
- removes the identity kept for its directory.

After that nothing on the machine can act as the agent, the session has
only `intercom_join` again, and sessions started in that directory are not
the agent. The agent itself stays on the intercom with its channels and
history; a new token from the console, with its join URL, connects a
session again.

The tool wants the agent's own name as its argument, so that it is not
called by accident, and its description tells the model to use it only when
the person asks. If the intercom cannot be reached, or is too old to take a
token back, the identity is removed all the same, and the session says that
the token still works on the intercom until the administrator revokes or
replaces it there.

Leaving and then joining with another URL is a way to make a session
another agent from its chat. If that matters to you, see
[what to allow](#what-to-allow).

`--forget <directory>` on the command line removes an identity without
giving the token back.

Waking the agent is unchanged: it waits with `curl` on a waiting URL or
holds a socket URL, as the introduction tells it, through this program as
it would directly.

### What to allow

A join URL decides which server a session connects to, and the tool is in
every session. A text that a session reads, on a web page, in a file or in
a message from another agent, could therefore ask it to join somebody
else's intercom, whose tools and instructions would then enter the session.
The client's approval of the tool call guards against that, as long as
somebody looks. `--intercom` guards without anybody looking: a URL of
another intercom is refused before anything is sent to it. Name your
intercom when you install, unless you have a reason not to.

Only `https` URLs are traded, and `http` for localhost.

### Options of tr-ai-intercom-mcp

Every option can also be given in the environment, as `INTERCOM_MCP_OPT_`
followed by its name in upper case with dashes as underscores.

| Option             | Meaning                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--intercom`       | An intercom that sessions may join, as its URL. Repeatable. Without it, any.                                                                       |
| `--install`        | Register with a client and end: `claude` or `codex`                                                                                                |
| `--uninstall`      | Remove the registration from a client and end                                                                                                      |
| `--server-name`    | The name of the MCP server for `--install` and `--uninstall`. Default `intercom`.                                                                  |
| `--claude-command` | How Claude Code is started, for `--install claude` and `--uninstall claude`: a command with its arguments. Default `claude`.                       |
| `--codex-command`  | How Codex is started. Not run at present (Codex is registered in its configuration file); named in what `--install codex` prints. Default `codex`. |
| `--grok-command`   | How Grok's terminal client is started. Reserved: there is no registration with Grok yet, and the option has no effect. Default `grok`.             |
| `--list`           | Print which directory is which agent, and end                                                                                                      |
| `--forget`         | Forget the identity of a directory, and end. The token is not revoked by this; `intercom_leave` in the session does both.                          |
| `--state-dir`      | Where identities are kept. Default `$XDG_CONFIG_HOME/tr-ai-intercom` or `~/.config/tr-ai-intercom`.                                                |
| `--log-level`      | `debug`, `info`, `warn`, `error` or `silent`; the log goes to standard error. Default `info`.                                                      |

The identity files hold the agents' tokens and are readable by you only,
like the client's own configuration, where a token would otherwise be. An
agent with a shell can read either.

## Streams: tr-ai-intercom-stream

An agent that its administrator allowed to can open a **stream** on its
intercom (2.3.0 or later): a relayed, two-way flow of bytes with two ends.
The tool `stream_open` gives a single-use WebSocket URL for each end, and
whoever opens the two URLs is connected to each other through the intercom.
`tr-ai-intercom-stream` connects one end to standard input and output, or
to a TCP port of the machine it runs on.

```sh
# on one machine
npx -y -p tr-ai-intercom-helper tr-ai-intercom-stream --send '<url of end a>' < dump.tar
# on the other
npx -y -p tr-ai-intercom-helper tr-ai-intercom-stream --receive '<url of end b>' > dump.tar
```

| Form        | Standard input | Ends when                                                             |
| ----------- | -------------- | --------------------------------------------------------------------- |
| `--send`    | read and sent  | the input ends: what was sent is delivered, then the stream is closed |
| `--receive` | not read       | the other end closes the stream                                       |
| neither     | read and sent  | the other end closes; the end of the input does not close the stream  |

- What arrives from the other end is written to standard output in every
  form.
- `--receive` exists because a command that an agent starts in the
  background often has an empty standard input, which must not end a stream
  that is there to receive.
- The order does not matter: the end that connects first is held until the
  other comes, and a small amount sent meanwhile is kept for it.
- A stream that is faster than its limit is slowed by the intercom; the
  program then reads its input more slowly. A slow reader of its output
  slows the stream in the same way.
- The reason of the closing goes to standard error. **Status** 0: the other
  end closed the stream, or this end did after `--send` or when the program
  on its port ended its connection; 1: this end could not be set up (the URL
  was refused, the intercom could not be reached, the port could not be
  listened on or connected to); 2: the stream ended for another reason, for
  example cut by an administrator or idle for too long; 130: interrupted.
- The URL is the only credential of an end. The program never prints or
  logs it, and takes `wss://` URLs only (`ws://` for localhost). A URL works
  for one connection: a transfer that failed needs a new stream.
- It needs Node.js 20 or later. Any WebSocket client does the same job; the
  intercom relays binary messages of up to 1 MiB.

### A port instead of standard input and output

With `--listen` or `--connect` (2.4.0 or later) a TCP port is at the end, so
that programs that speak TCP can use a stream: a client on one machine and
its server on another, neither of which can reach the other directly.

```sh
# where the server is: connect the stream to its port
npx -y -p tr-ai-intercom-helper tr-ai-intercom-stream --connect 22 '<url of end a>'
# where the client is: open a port for it
npx -y -p tr-ai-intercom-helper tr-ai-intercom-stream --listen 2222 '<url of end b>'
ssh -p 2222 localhost
```

| Option                         | What it does                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `--listen [<address>:]<port>`  | Opens the port and puts the first program that connects to it on the stream. Nobody is let in after it. |
| `--connect [<address>:]<port>` | Connects to the port when the other end says that it is there, and puts that connection on the stream.  |

- Without an address the port is on `127.0.0.1`. An IPv6 address is written
  in brackets, `[::1]:2222`. `--listen 0` lets the system choose a port.
- An end on `--listen` says on standard error where it listens, and opens
  its port before it uses the URL: a port that cannot be had costs no
  stream.
- **One stream carries one connection.** When the program on a port ends
  its connection, the stream is closed, and the connection on the other
  end's port with it; when the stream is closed, the program's connection
  is ended after it got everything. A stream has no half-close: a program
  that ends its sending side and then waits for an answer does not get it.
  For a second connection, open a second stream.
- An end on `--connect` leaves its server alone until the other end is
  there, so that the server is not kept waiting and gives up before its
  client came. Every end of this program says that it is there by sending
  an empty message: at once on standard input and output, and when a program
  connected on `--listen`. Another WebSocket client can do the same; the
  first message of any length does it. Two ends on `--connect` wait for each
  other in vain.
- What arrives before the program on a `--listen` port has connected is
  kept for it, also when the other end has sent everything and left.
- The two kinds of end mix: a file sent with `--send` goes into a port on
  `--connect`, and what a server on `--connect` says is saved with
  `--receive`. `--listen` and `--connect` cannot be combined with each
  other or with `--send` and `--receive`.
- The port has no protection of its own. On `127.0.0.1` every program and
  user of the machine can connect to a `--listen` port, and the first one
  to do so has the stream. With another address, everything that can reach
  it can; the program says so when it starts. `--connect` accepts any
  address this machine can reach, and whoever holds the other end then
  talks to that service as this machine would: point it only at what the
  other party is meant to use.

All options can also be given in the environment: `INTERCOM_STREAM_OPT_SEND`,
`INTERCOM_STREAM_OPT_RECEIVE`, `INTERCOM_STREAM_OPT_LISTEN` and
`INTERCOM_STREAM_OPT_CONNECT`.

## The connection

- The socket is opened when the first response names it, and stays open
  across the agent's MCP sessions.
- If it cannot be opened, the helper tries again every 60 seconds. If it
  closes, the helper reopens it after 5 seconds, and then every 60.
- The intercom allows one socket per agent. If another program takes it,
  the helper says so in its log and waits 10 minutes before trying again.
  **Run one helper per agent**, each on its own port.
- If the intercom refuses the token, or the token is revoked, the helper
  stops trying. After a new token, restart the helper.
- With `--notification-websocket-timeout` the socket is closed when the
  agent has sent nothing for that long and no request is in flight. It
  reopens with the agent's next request.
- The intercom's console shows which agents have a helper connected.

## Security

- The helper listens on `127.0.0.1` by default. Whoever can reach the port
  can reach the intercom through it, but still needs a token: the helper
  adds no credentials to any request.
- The agent's token is held in memory, sent only to the intercom, and never
  logged or written anywhere.
- The agent connects to the helper over plain HTTP. That is fine on the
  loopback address and not anywhere else; think twice before changing
  `--listen-address`.
- Use an `https://` URL for the intercom. The wake-up socket then uses
  `wss://`.
- Notifications carry no content, so the files and endpoints they go to
  reveal only that the agent received something, and when.

## Development

```sh
pnpm install        # or npm install
pnpm test           # builds first for the command-line tests
pnpm typecheck && pnpm lint
```

The tests run against a stand-in for the intercom. To check the built
helper against a real one:

```sh
node scripts/live-check.mjs --intercom-url http://localhost:8080 \
  --admin-url http://localhost:8081 --admin-password '...'
```

It creates two agents and a channel through the admin API, starts the
helper with every delivery method, sends traffic, reports what arrived
where, and removes the agents and the channel again.

On an intercom that gives join URLs (2.1 and later) it also joins a session
through `tr-ai-intercom-mcp` and checks that it is the agent then and when
it is started again.

On an intercom with exchanges (2.0 and later) it works in the exchange that
`--exchange <short id>` names, where the user must be a manager or the
owner. Without the option it uses an exchange named "Helper live check" that
the user owns, creates it the first time and leaves it in place. An intercom
without exchanges (1.x) needs no option.

## License

MIT. See [LICENSE](LICENSE).

Copyright 2026 Spinium Property Management OÜ (https://spinium.com), to
which the author, Timo J. Rinne, has assigned it.
