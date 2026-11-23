#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import Optist from 'optist';

import { IdentityStore, canonical, defaultStateDir, sessionDirectory } from './local/identity.js';
import { InstallError, install, uninstall } from './local/install.js';
import { startLocalServer } from './local/server.js';
import { createLogger } from './logger.js';
import { MCP_OPTIONS, type McpClient } from './mcp-options.js';
import { VERSION } from './version.js';

// tr-ai-intercom-mcp: the intercom as a local MCP server that a client
// starts for each session. Registered once (--install), it lets any session
// join an intercom from its own chat and be the same agent from then on.

const HELP_TAIL =
  'Without --install, --uninstall, --list or --forget this is an MCP server on standard input and output, to be started by an MCP client, not by hand. Register it once with --install claude or --install codex; sessions started afterwards have the tool "intercom_join", which takes the join URL that the console of an intercom gives with a new token.';

async function main(): Promise<void> {
  const opt = new Optist()
    .opts(MCP_OPTIONS)
    .additional(0, 0)
    .help('tr-ai-intercom-mcp')
    .helpMessageTail(HELP_TAIL)
    .parse();
  const value = <T>(name: string): T => opt.value(name) as T;
  const intercoms = [...new Set(value<string[]>('intercom'))];
  const store = new IdentityStore(value<string | undefined>('state-dir') ?? defaultStateDir());
  const name = value<string>('server-name');
  const say = (line: string): void => void process.stdout.write(`${line}\n`);

  const installing = value<McpClient | undefined>('install');
  if (installing) return say(await install(installing, { name, intercoms }));
  const uninstalling = value<McpClient | undefined>('uninstall');
  if (uninstalling) return say(await uninstall(uninstalling, { name }));

  if (value<boolean>('list')) {
    const all = store.list();
    if (all.length === 0) return say('No session has joined an intercom yet.');
    for (const i of all) {
      say(
        `${i.directory}\n  agent "${i.agent.name}"${i.exchange.name ? ` in exchange "${i.exchange.name}"` : ''} at ${new URL(i.mcpUrl).origin}, since ${i.joinedAt}`,
      );
    }
    return;
  }
  const forgetting = value<string | undefined>('forget');
  if (forgetting) {
    const directory = canonical(forgetting);
    return say(
      store.remove(directory)
        ? `Forgot the identity of ${directory}. Its token still works until it is replaced or revoked on the intercom.`
        : `${directory} has no identity.`,
    );
  }

  // The server. Standard output belongs to the protocol from here on.
  const logger = createLogger(value<string>('log-level'));
  const directory = sessionDirectory();
  logger.info('tr-ai-intercom-mcp starting', { version: VERSION, directory, intercoms });
  const server = await startLocalServer({
    store,
    directory,
    allowed: intercoms,
    logger,
    transport: new StdioServerTransport(),
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 2000).unref();
    void server.close().finally(() => process.exit(0));
  };
  // The client closing our input is how a session ends.
  process.stdin.on('close', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => {
  process.stderr.write(`tr-ai-intercom-mcp: ${(err as Error).message}\n`);
  process.exit(err instanceof InstallError ? 2 : 1);
});
