# Changelog

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
