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
    conflictsWith: ['receive', 'listen', 'connect'],
  },
  {
    longName: 'receive',
    environment: 'INTERCOM_STREAM_OPT_RECEIVE',
    description:
      'Do not read standard input at all; write what arrives to standard output until the other end closes the stream. For saving what is sent: tr-ai-intercom-stream --receive <url> > FILE',
    conflictsWith: ['send', 'listen', 'connect'],
  },
  {
    longName: 'listen',
    environment: 'INTERCOM_STREAM_OPT_LISTEN',
    hasArg: true,
    description:
      'Put a TCP port of this machine on the stream instead of standard input and output: listen on <port> or <address>:<port> (127.0.0.1 without an address; port 0 lets the system choose and says which), and connect the first program that connects there to the stream. For a client such as ssh or rsync: tr-ai-intercom-stream --listen 2222 <url>',
    conflictsWith: ['connect', 'send', 'receive'],
  },
  {
    longName: 'connect',
    environment: 'INTERCOM_STREAM_OPT_CONNECT',
    hasArg: true,
    description:
      'Put a TCP port on the stream instead of standard input and output: connect to <port> or <address>:<port> (127.0.0.1 without an address) once the other end is there, and connect that to the stream. For a server such as sshd: tr-ai-intercom-stream --connect 22 <url>',
    conflictsWith: ['listen', 'send', 'receive'],
  },
];
