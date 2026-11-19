# Changelog

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
