#!/usr/bin/env node
import Optist from 'optist';

import {
  BridgeError,
  checkEndUrl,
  parseLocalAddress,
  parseLocalTarget,
  readUrlFile,
  runBridge,
  runListener,
  type BridgeMode,
  type PortSide,
} from './stream/bridge.js';
import { STREAM_OPTIONS } from './stream-options.js';

// tr-ai-intercom-stream: one end of a stream of an intercom, or the clients'
// side of a stream service, on standard input and output or on a TCP port
// of this machine.

const HELP_TAIL =
  "The <url> is the URL of one end of a stream, as the agent that opened the stream on its intercom got it from stream_open (wss://…/mcp/stream/…); it works for one connection. Or it is the URL of a stream service for its clients (wss://…/mcp/service/…), which can be used again and again, each time for a connection of its own. What arrives from the other end is written to standard output; without --send and --receive, standard input is sent as well and its end does not close the stream. That makes it a proxy command: ssh -o 'ProxyCommand=tr-ai-intercom-stream <url of a stream service>' user@host. With --listen or --connect a TCP port is at this end instead: one connection per stream, and when the program on the port ends its connection the stream is closed (a stream has no half-close). With the URL of a stream service, --listen keeps the port open and gives every program that connects a connection of its own. The reason of the closing goes to standard error. Status 0: the other end closed the stream, or this end did after --send or when the program on the port ended its connection; 1: this end could not be set up (the URL was refused, the intercom could not be reached, the port could not be listened on or connected to); 2: the stream ended for another reason; 130: interrupted.";

async function main(): Promise<void> {
  const parser = new Optist()
    .opts(STREAM_OPTIONS)
    .describeParam(
      0,
      'url',
      'the URL of one end of a stream, or of a stream service for its clients',
    )
    .additional(0, 1)
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
  const listen = opt.value('listen') as string | undefined;
  const connect = opt.value('connect') as string | undefined;
  const file = opt.value('url-file') as string | undefined;
  const given = opt.rest()[0];
  if (file && given) {
    throw new BridgeError('Give the URL in a file (--url-file) or as a parameter, not both.');
  }
  if (!file && !given) {
    throw new BridgeError(
      'The URL is missing: give it as a parameter, or name a file that holds it with --url-file.',
    );
  }
  const { url, kind } = checkEndUrl(file ? readUrlFile(file) : given!);
  if (kind === 'service' && connect) {
    throw new BridgeError(
      'That is the URL of a stream service for its clients, and a client does not connect it to a port with --connect. To put a port in front of the service, use --listen. The serving side, which connects clients to a server, is tr-ai-intercom-serve with the control URL.',
    );
  }
  const port: PortSide | undefined = listen
    ? { listen: parseLocalAddress(listen, 'listen') }
    : connect
      ? { connect: parseLocalTarget(connect) }
      : undefined;

  const stop = new AbortController();
  // ssh ends its proxy command with SIGHUP.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => stop.abort());
  }
  // Whoever read our output went away: the stream has no use any more.
  if (!port) process.stdout.on('error', () => stop.abort());

  const common = { url, say, signal: stop.signal };
  const status =
    kind === 'service' && port && 'listen' in port
      ? await runListener({ ...common, listen: port.listen })
      : await runBridge(
          port
            ? { ...common, port }
            : { ...common, mode, input: process.stdin, output: process.stdout },
        );
  process.exit(status);
}

main().catch((err: unknown) => {
  process.stderr.write(`tr-ai-intercom-stream: ${(err as Error).message}\n`);
  process.exit(err instanceof BridgeError ? 1 : 2);
});
