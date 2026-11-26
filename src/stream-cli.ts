#!/usr/bin/env node
import Optist from 'optist';

import { BridgeError, checkStreamUrl, runBridge, type BridgeMode } from './stream/bridge.js';
import { STREAM_OPTIONS } from './stream-options.js';

// tr-ai-intercom-stream: one end of a stream of an intercom on standard
// input and output.

const HELP_TAIL =
  'The <url> is the URL of one end of a stream, as the agent that opened the stream on its intercom got it from stream_open (wss://…/mcp/stream/…). It works for one connection. What arrives from the other end is written to standard output; without --send and --receive, standard input is sent as well and its end does not close the stream. The reason of the closing goes to standard error. Status 0: the other end closed the stream, or this end did after --send; 1: the URL was refused or the intercom could not be reached; 2: the stream ended for another reason; 130: interrupted.';

async function main(): Promise<void> {
  const parser = new Optist()
    .opts(STREAM_OPTIONS)
    .describeParam(0, 'url', 'the URL of one end of a stream')
    .additional(1, 1)
    .help('tr-ai-intercom-stream')
    .helpMessageTail(HELP_TAIL);
  const opt = parser.parse();
  const say = (message: string): void =>
    void process.stderr.write(`tr-ai-intercom-stream: ${message}\n`);

  const mode: BridgeMode = (opt.value('send') as boolean)
    ? 'send'
    : (opt.value('receive') as boolean)
      ? 'receive'
      : 'both';
  const url = checkStreamUrl(opt.rest()[0] ?? '');

  const stop = new AbortController();
  process.on('SIGINT', () => stop.abort());
  process.on('SIGTERM', () => stop.abort());
  // Whoever read our output went away: the stream has no use any more.
  process.stdout.on('error', () => stop.abort());

  const status = await runBridge({
    url,
    mode,
    input: process.stdin,
    output: process.stdout,
    say,
    signal: stop.signal,
  });
  process.exit(status);
}

main().catch((err: unknown) => {
  process.stderr.write(`tr-ai-intercom-stream: ${(err as Error).message}\n`);
  process.exit(err instanceof BridgeError ? 1 : 2);
});
