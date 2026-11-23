import type { OptDef } from 'optist';
import ou from 'optist/util.js';

import { normalizeIntercom } from './local/joining.js';

/**
 * The options of tr-ai-intercom-mcp.
 *
 * Every option names its environment variable in its own definition,
 * INTERCOM_MCP_OPT_ followed by the option name in upper case with dashes as
 * underscores.
 */
export const MCP_CLIENTS = ['claude', 'codex'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

const clientCb = (s: string): string | undefined =>
  (MCP_CLIENTS as readonly string[]).includes(s) ? s : undefined;

export const MCP_OPTIONS: OptDef[] = [
  {
    longName: 'intercom',
    environment: 'INTERCOM_MCP_OPT_INTERCOM',
    description:
      'An intercom that sessions may join, as its URL (https://intercom.example.com). May be given several times. Without it any intercom may be joined. With --install it is written into the registration.',
    hasArg: true,
    multi: true,
    optArgCb: normalizeIntercom,
  },
  {
    longName: 'state-dir',
    environment: 'INTERCOM_MCP_OPT_STATE_DIR',
    description:
      'Where the identities of sessions are kept. Default: $XDG_CONFIG_HOME/tr-ai-intercom, or ~/.config/tr-ai-intercom.',
    hasArg: true,
    optArgCb: ou.nonEmptyCb,
  },
  {
    longName: 'install',
    environment: 'INTERCOM_MCP_OPT_INSTALL',
    description:
      'Register this program with a client, once for all its sessions, and end: claude (Claude Code) or codex (Codex).',
    hasArg: true,
    conflictsWith: ['uninstall', 'list', 'forget'],
    optArgCb: clientCb,
  },
  {
    longName: 'uninstall',
    environment: 'INTERCOM_MCP_OPT_UNINSTALL',
    description: 'Remove the registration from a client (claude or codex) and end.',
    hasArg: true,
    conflictsWith: ['install', 'list', 'forget'],
    optArgCb: clientCb,
  },
  {
    longName: 'server-name',
    environment: 'INTERCOM_MCP_OPT_SERVER_NAME',
    description: 'The name the MCP server is registered under with --install and --uninstall.',
    hasArg: true,
    defaultValue: 'intercom',
    optArgCb: (s: string) => (/^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : undefined),
  },
  {
    longName: 'list',
    environment: 'INTERCOM_MCP_OPT_LIST',
    description: 'Print which directories are which intercom agents, and end.',
    conflictsWith: ['install', 'uninstall', 'forget'],
  },
  {
    longName: 'forget',
    environment: 'INTERCOM_MCP_OPT_FORGET',
    description:
      "Forget the identity of a directory, and end. Sessions started there afterwards are not an agent until they join again. The agent's token is not revoked by this; that is done on the intercom.",
    hasArg: true,
    conflictsWith: ['install', 'uninstall', 'list'],
    optArgCb: ou.nonEmptyCb,
  },
  {
    longName: 'log-level',
    environment: 'INTERCOM_MCP_OPT_LOG_LEVEL',
    description: 'debug, info, warn, error or silent. The log goes to standard error.',
    hasArg: true,
    defaultValue: 'info',
    optArgCb: (s: string) =>
      ['debug', 'info', 'warn', 'error', 'silent'].includes(s) ? s : undefined,
  },
];
