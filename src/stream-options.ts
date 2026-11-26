import type { OptDef } from 'optist';

/**
 * The options of tr-ai-intercom-stream.
 *
 * Every option names its environment variable in its own definition,
 * INTERCOM_STREAM_OPT_ followed by the option name in upper case with dashes
 * as underscores.
 */
export const STREAM_OPTIONS: OptDef[] = [
  {
    longName: 'send',
    environment: 'INTERCOM_STREAM_OPT_SEND',
    description:
      'Send standard input and close the stream when it ends, after everything sent was delivered. For a file or the output of a command: tr-ai-intercom-stream --send <url> < FILE',
    conflictsWith: 'receive',
  },
  {
    longName: 'receive',
    environment: 'INTERCOM_STREAM_OPT_RECEIVE',
    description:
      'Do not read standard input at all; write what arrives to standard output until the other end closes the stream. For saving what is sent: tr-ai-intercom-stream --receive <url> > FILE',
    conflictsWith: 'send',
  },
];
