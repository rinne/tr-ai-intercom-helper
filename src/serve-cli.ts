#!/usr/bin/env node
import Optist from 'optist';

import { BridgeError, checkControlUrl, parseLocalTarget, readUrlFile } from './stream/bridge.js';
import { runServe } from './serve/serve.js';
import { SERVE_OPTIONS } from './serve-options.js';

// tr-ai-intercom-serve: the serving side of a stream service of an intercom.

const HELP_TAIL =
  'Serves a stream service: holds its control socket, and connects every client that the intercom announces to the server named with --connect. It connects to the server first and takes the client only when that worked; otherwise the client is refused with the reason. The control URL (wss://…/mcp/control/…) comes from the agent that registered the service with stream_service_register; give it in a file with --url-file, or as the <url> parameter. It runs until it is stopped, and opens the control socket again when it is lost. One line per connection goes to standard error, with the address the client came from; never a URL. Status 1: the control URL is not known to the intercom, was renewed, or its service was removed; 130: interrupted.';

async function main(): Promise<void> {
  const parser = new Optist()
    .opts(SERVE_OPTIONS)
    .describeParam(0, 'url', 'the control URL of the stream service, unless --url-file names it')
    .additional(0, 1)
    .help('tr-ai-intercom-serve')
    .helpMessageTail(HELP_TAIL);
  const opt = parser.parse();
  const say = (message: string): void =>
    void process.stderr.write(`tr-ai-intercom-serve: ${message}\n`);

  const file = opt.value('url-file') as string | undefined;
  const given = opt.rest()[0];
  if (file && given) {
    throw new BridgeError(
      'Give the control URL in a file (--url-file) or as a parameter, not both.',
    );
  }
  if (!file && !given) {
    throw new BridgeError(
      'The control URL of the stream service is missing: name a file that holds it with --url-file, or give it as a parameter.',
    );
  }
  const url = checkControlUrl(file ? readUrlFile(file) : given!);
  const target = parseLocalTarget(opt.value('connect') as string);

  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => stop.abort());
  }
  const status = await runServe({
    url,
    target,
    say,
    quiet: Boolean(opt.value('quiet')),
    signal: stop.signal,
  });
  process.exit(status);
}

main().catch((err: unknown) => {
  process.stderr.write(`tr-ai-intercom-serve: ${(err as Error).message}\n`);
  process.exit(err instanceof BridgeError ? 1 : 2);
});
