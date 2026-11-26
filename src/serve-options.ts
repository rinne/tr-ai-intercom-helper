import type { OptDef } from 'optist';

/**
 * The options of tr-ai-intercom-serve.
 *
 * Every option names its environment variable in its own definition,
 * INTERCOM_SERVE_OPT_ followed by the option name in upper case with dashes
 * as underscores.
 */
export const SERVE_OPTIONS: OptDef[] = [
  {
    longName: 'connect',
    environment: 'INTERCOM_SERVE_OPT_CONNECT',
    hasArg: true,
    required: true,
    description:
      'Where the server is: <port> or <address>:<port> (127.0.0.1 without an address), or the path of a local domain socket (anything with a "/" in it). Every client of the stream service is connected there. For sshd on this machine: --connect 22',
  },
  {
    longName: 'url-file',
    environment: 'INTERCOM_SERVE_OPT_URL_FILE',
    hasArg: true,
    description:
      'A file that holds the control URL of the stream service and nothing else. The file must be readable by its owner alone (chmod 600). Use this rather than the URL as a parameter for anything that runs for long: a parameter shows in the list of processes.',
  },
  {
    longName: 'quiet',
    environment: 'INTERCOM_SERVE_OPT_QUIET',
    description:
      'Do not write a line for every connection that came and went as it should; only for what went wrong, and for the control socket.',
  },
];
