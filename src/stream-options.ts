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
      'Put a TCP port of this machine on the stream instead of standard input and output: listen on <port> or <address>:<port> (127.0.0.1 without an address; port 0 lets the system choose and says which). With the URL of a stream: the first program that connects there is on the stream, and nobody after it. With the URL of a stream service: every program that connects gets a connection of its own, until the program is stopped.',
    conflictsWith: ['connect', 'send', 'receive'],
  },
  {
    longName: 'connect',
    environment: 'INTERCOM_STREAM_OPT_CONNECT',
    hasArg: true,
    description:
      'Put a TCP port on the stream instead of standard input and output: connect to <port> or <address>:<port> (127.0.0.1 without an address), or to the local domain socket at a path, and connect that to the stream. Not for the URL of a stream service: its serving side is tr-ai-intercom-serve.',
    conflictsWith: ['listen', 'send', 'receive'],
  },
  {
    longName: 'url-file',
    environment: 'INTERCOM_STREAM_OPT_URL_FILE',
    hasArg: true,
    description:
      'A file that holds the URL and nothing else, instead of the <url> parameter. The file must be readable by its owner alone (chmod 600). For the URL of a stream service, which lives long: a parameter shows in the list of processes.',
  },
];
