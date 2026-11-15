#!/usr/bin/env node
import Optist from 'optist';

import { resolveSocketPath, runNotifier } from './notifier.js';
import { NOTIFY_OPTIONS } from './notify-options.js';

// tr-ai-intercom-notify: prints the notifications of a running
// tr-ai-intercom-helper to standard output, one line of JSON each.

const HELP_TAIL =
  'Give exactly one of --monitor and --oneshot, and exactly one of --helper-port and --socket-path. Each line printed is one notification as compact JSON; it says that something happened on the intercom, never what. The helper must run with --notification-listener.';

async function main(): Promise<void> {
  const parser = new Optist()
    .opts(NOTIFY_OPTIONS)
    .additional(0, 0)
    .help('tr-ai-intercom-notify')
    .helpMessageTail(HELP_TAIL);
  const opt = parser.parse();
  const fail = (message: string): never => {
    parser.showErrorMessageHelpAndExitIfHelpEnabled(message, 1);
    throw new Error(message);
  };

  const monitor = opt.value('monitor') as boolean;
  const oneshot = opt.value('oneshot') as boolean;
  if (!monitor && !oneshot) fail('Give --monitor or --oneshot.');
  const port = opt.value('helper-port') as number | undefined;
  const path = opt.value('socket-path') as string | undefined;
  if (port === undefined && !path) fail('Give --helper-port or --socket-path.');

  const idle = opt.value('idle-notification-interval') as number | undefined;

  const stop = new AbortController();
  process.on('SIGINT', () => stop.abort());
  process.on('SIGTERM', () => stop.abort());
  // Whoever read our output went away: nothing left to do.
  process.stdout.on('error', () => process.exit(0));

  const socketPath = await resolveSocketPath({ port, path });
  const status = await runNotifier({
    socketPath,
    mode: monitor ? 'monitor' : 'oneshot',
    reconnect: opt.value('reconnect') as boolean,
    idleIntervalMs: idle === undefined ? undefined : idle * 1000,
    out: (line) => process.stdout.write(line),
    err: (message) => process.stderr.write(`tr-ai-intercom-notify: ${message}\n`),
    signal: stop.signal,
  });
  // Let the last line reach a pipe before the process ends.
  process.stdout.write('', () => process.exit(status));
}

main().catch((err: unknown) => {
  process.stderr.write(`tr-ai-intercom-notify: ${(err as Error).message}\n`);
  process.exit(1);
});
