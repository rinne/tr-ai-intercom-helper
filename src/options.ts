import Optist from 'optist';
import type { OptDef } from 'optist';
import ou from 'optist/util.js';

/**
 * Command line options.
 *
 * Every option names its environment variable in its own definition:
 * `--listen-port` has `environment: 'INTERCOM_HELPER_OPT_LISTEN_PORT'`. The
 * value is taken from that variable when the option is not on the command
 * line; an option given on the command line wins.
 *
 * The name is always INTERCOM_HELPER_OPT_ followed by the option name in
 * upper case with dashes as underscores.
 */

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * A time span in seconds: a number, optionally followed by s, m, h or d.
 * "90", "90s", "15m", "2h" and "1d" are all fine. Fractions are allowed.
 */
export function parseTimespec(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(text.trim());
  if (!match) return undefined;
  const seconds = Number(match[1]) * UNITS[(match[2] || 's').toLowerCase()]!;
  return Number.isFinite(seconds) ? seconds : undefined;
}

const urlCb = (s: string): string | undefined => {
  try {
    const url = new URL(s);
    return url.protocol === 'http:' || url.protocol === 'https:' ? s : undefined;
  } catch {
    return undefined;
  }
};

/** One header line, "Name: value". */
export function parseHeaderLine(line: string): { name: string; value: string } | undefined {
  const at = line.indexOf(':');
  if (at <= 0) return undefined;
  const name = line.slice(0, at).trim();
  const value = line.slice(at + 1).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || value === '') return undefined;
  if (/[\r\n]/.test(value)) return undefined;
  return { name, value };
}

export const OPTIONS: OptDef[] = [
  {
    longName: 'mcp-server-url',
    environment: 'INTERCOM_HELPER_OPT_MCP_SERVER_URL',
    description:
      'The intercom to forward to: its root URL, not the /mcp path, for example https://intercom.example.com/. A request for /mcp is sent to that URL with /mcp appended.',
    hasArg: true,
    required: true,
    optArgCb: urlCb,
  },
  {
    longName: 'listen-address',
    environment: 'INTERCOM_HELPER_OPT_LISTEN_ADDRESS',
    description: 'Local address the agent connects to.',
    hasArg: true,
    defaultValue: '127.0.0.1',
    optArgCb: ou.nonEmptyCb,
  },
  {
    longName: 'listen-port',
    environment: 'INTERCOM_HELPER_OPT_LISTEN_PORT',
    description: 'Local TCP port the agent connects to. 0 picks a free port.',
    hasArg: true,
    defaultValue: '32323',
    optArgCb: ou.integerWithLimitsCbFactory(0, 65535),
  },
  {
    longName: 'notification-websocket-timeout',
    environment: 'INTERCOM_HELPER_OPT_NOTIFICATION_WEBSOCKET_TIMEOUT',
    description:
      'Close the wake-up socket when no request has been forwarded for this long; it reopens with the next request. In seconds, or with a unit: 90, 15m, 2h, 1d. Without it the socket stays open.',
    hasArg: true,
    optArgCb: parseTimespec,
  },
  {
    longName: 'notification-file',
    environment: 'INTERCOM_HELPER_OPT_NOTIFICATION_FILE',
    description: 'Append each notification to this file, one JSON object per line.',
    hasArg: true,
    optArgCb: ou.nonEmptyCb,
  },
  {
    longName: 'notification-dir',
    environment: 'INTERCOM_HELPER_OPT_NOTIFICATION_DIR',
    description:
      'Write each notification into this directory as a file of its own, named by its sequence number: 000012a7.json.',
    hasArg: true,
    optArgCb: ou.nonEmptyCb,
  },
  {
    longName: 'notification-tmp-dir',
    environment: 'INTERCOM_HELPER_OPT_NOTIFICATION_TMP_DIR',
    description:
      'Where the files for --notification-dir are written before they are moved into place. It must be on the same file system. Default: .tmp inside that directory.',
    hasArg: true,
    requiresAlso: 'notification-dir',
    optArgCb: ou.nonEmptyCb,
  },
  {
    longName: 'notification-url',
    environment: 'INTERCOM_HELPER_OPT_NOTIFICATION_URL',
    description: 'POST each notification to this URL as JSON.',
    hasArg: true,
    optArgCb: urlCb,
  },
  {
    longName: 'notification-url-header',
    environment: 'INTERCOM_HELPER_OPT_NOTIFICATION_URL_HEADER',
    description:
      'A header line to send with that POST, for example "Authorization: Bearer something".',
    hasArg: true,
    requiresAlso: 'notification-url',
    optArgCb: (s: string) => (parseHeaderLine(s) ? s : undefined),
  },
  {
    longName: 'notification-local-socket',
    environment: 'INTERCOM_HELPER_OPT_NOTIFICATION_LOCAL_SOCKET',
    description:
      'Connect to this local (Unix domain) socket for each notification, write it as JSON and close.',
    hasArg: true,
    optArgCb: ou.nonEmptyCb,
  },
  {
    longName: 'notification-command',
    environment: 'INTERCOM_HELPER_OPT_NOTIFICATION_COMMAND',
    description:
      'Run this command through the shell for each notification, with the JSON on its standard input.',
    hasArg: true,
    optArgCb: ou.nonEmptyCb,
  },
  {
    longName: 'log-level',
    environment: 'INTERCOM_HELPER_OPT_LOG_LEVEL',
    description: 'Log level: error, warn, info, debug or silent. The log goes to standard error.',
    hasArg: true,
    defaultValue: 'info',
    optArgCb: ou.allowListCbFactory(['error', 'warn', 'info', 'debug', 'silent']),
  },
];

export interface Config {
  /** Root URL of the intercom. */
  upstreamUrl: string;
  host: string;
  port: number;
  logLevel: string;
  /** Close the idle wake-up socket after this many seconds; undefined = never. */
  socketTimeout: number | undefined;
  file: string | undefined;
  dir: string | undefined;
  tmpDir: string | undefined;
  url: string | undefined;
  urlHeader: { name: string; value: string } | undefined;
  localSocket: string | undefined;
  command: string | undefined;
}

export class ConfigError extends Error {}

const HELP_TAIL =
  'Each option is taken from the environment when it is not on the command line: --listen-port from INTERCOM_HELPER_OPT_LISTEN_PORT, --mcp-server-url from INTERCOM_HELPER_OPT_MCP_SERVER_URL, and so on. Several delivery methods (--notification-file, -dir, -url, -local-socket, -command) can be used together, one of each.';

/**
 * The configuration, from the command line and the environment.
 *
 * `argv` holds the arguments only (default: those of the process). With
 * `exitOnError` (the default) a mistake prints the error and the usage text
 * and ends the process; without it a ConfigError is thrown instead.
 */
export function loadConfig(argv?: string[], opts: { exitOnError?: boolean } = {}): Config {
  const exitOnError = opts.exitOnError ?? true;
  const parser = new Optist().opts(OPTIONS).additional(0, 0);
  if (exitOnError) parser.help('tr-ai-intercom-helper').helpMessageTail(HELP_TAIL);

  let opt: Optist;
  try {
    opt = parser.parse(argv === undefined ? undefined : [...argv]);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  const value = <T>(name: string): T => opt.value(name) as T;
  const header = value<string | undefined>('notification-url-header');
  return {
    upstreamUrl: value<string>('mcp-server-url'),
    host: value<string>('listen-address'),
    port: value<number>('listen-port'),
    logLevel: value<string>('log-level'),
    socketTimeout: value<number | undefined>('notification-websocket-timeout'),
    file: value<string | undefined>('notification-file'),
    dir: value<string | undefined>('notification-dir'),
    tmpDir: value<string | undefined>('notification-tmp-dir'),
    url: value<string | undefined>('notification-url'),
    urlHeader: header ? parseHeaderLine(header) : undefined,
    localSocket: value<string | undefined>('notification-local-socket'),
    command: value<string | undefined>('notification-command'),
  };
}
