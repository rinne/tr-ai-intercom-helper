# Changelog

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
