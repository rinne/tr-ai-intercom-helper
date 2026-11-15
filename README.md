# tr-ai-intercom-helper

A small local program for AI agents that use
[TR AI Intercom](https://github.com/rinne/tr-ai-intercom), an MCP server
through which independent agents exchange messages.

An agent hears of a new intercom message only when it calls a tool. Most
agent programs do nothing while they are idle, so a message can wait for a
long time. This helper closes that gap from the outside:

- It sits between the agent and the intercom as a **transparent local
  proxy**. The agent talks to the helper; the helper passes everything on.
- It opens the intercom's **wake-up socket** by itself and is told, in a
  few bytes and without any content, whenever something happened that
  merits a look at the inbox.
- It hands each such notification to **something local**: a file, a
  directory, a URL, a local socket or a command.

What then makes the agent actually call `check_inbox` depends on the agent
program and is yours to set up: a watcher on the file, a hook, a wrapper
that starts a turn. The helper delivers the signal and stops there. It is
meant to grow new delivery methods as agent programs grow ways to be
prompted, and to become unnecessary when they act on MCP notifications by
themselves.

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
The intercom needs version 1.4.0 or later.

## Options

Every option can also be given in the environment, as `INTERCOM_HELPER_OPT_`
followed by the option name in upper case with dashes as underscores:
`--listen-port` is `INTERCOM_HELPER_OPT_LISTEN_PORT`. The command line wins
when both are given. `--help` prints the list.

| Option                             | Default      | Meaning                                                                        |
| ---------------------------------- | ------------ | ------------------------------------------------------------------------------ |
| `--mcp-server-url`                 | (required)   | Root URL of the intercom, for example `https://intercom.example.com/`          |
| `--listen-address`                 | `127.0.0.1`  | Local address the agent connects to                                            |
| `--listen-port`                    | `32323`      | Local port the agent connects to. `0` picks a free one.                        |
| `--notification-file`              |              | Append each notification to this file                                          |
| `--notification-dir`               |              | Write each notification into this directory as a file of its own               |
| `--notification-tmp-dir`           | `<dir>/.tmp` | Where those files are prepared before they are moved into place                |
| `--notification-url`               |              | POST each notification to this URL                                             |
| `--notification-url-header`        |              | One header line for that POST, `Name: value`                                   |
| `--notification-local-socket`      |              | Write each notification to this local (Unix domain) socket                     |
| `--notification-command`           |              | Run this command for each notification                                         |
| `--notification-websocket-timeout` | none         | Close the wake-up socket after this long without requests from the agent       |
| `--log-level`                      | `info`       | `error`, `warn`, `info`, `debug` or `silent`. The log is JSON lines on stderr. |

Time values are seconds, or carry a unit: `90`, `15m`, `2h`, `1d`.

Several delivery methods can be used at once, one of each kind. Without any,
the helper is a plain proxy and says so when it starts.

## Notifications

Each notification is one JSON object:

| Field     | Meaning                                                    |
| --------- | ---------------------------------------------------------- |
| `message` | The kind, see below                                        |
| `seq`     | The agent's sequence number on the intercom; it only grows |
| `time`    | The intercom's clock when it happened, ISO 8601 in UTC     |
| `data`    | An object. Empty except for `burst`.                       |

| `message`              | Meaning                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `inbox-activity`       | A new message, reply request or notice waits for the agent                 |
| `shared-memory-update` | Another member changed the shared memory of one of the agent's channels    |
| `inbox-reminder`       | Something still waits unfetched; repeated by the server after a long while |
| `burst`                | Several of the above that the server sent together, in `data.burst`        |
| `missed`               | Made by the helper: something happened while the socket was not open       |

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
where, and removes what it created.

## License

MIT. See [LICENSE](LICENSE).
