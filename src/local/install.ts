import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { McpClient } from '../mcp-options.js';

/**
 * Registering tr-ai-intercom-mcp with a client, once for all its sessions.
 *
 * Claude Code is told through its own command (`claude mcp add --scope
 * user`). Codex keeps its servers in ~/.codex/config.toml, where a table is
 * added by hand, since `codex mcp add` rewrites the other entries.
 *
 * A registration under the same name that is not this program is never
 * replaced: it may hold somebody's token.
 */

const run = promisify(execFile);

export const PROGRAM = 'tr-ai-intercom-mcp';
/** How a client starts the program: through npx, like any published MCP server. */
export const launch = (intercoms: string[]): { command: string; args: string[] } => ({
  command: 'npx',
  args: [
    '-y',
    '-p',
    'tr-ai-intercom-helper',
    PROGRAM,
    ...intercoms.flatMap((i) => ['--intercom', i]),
  ],
});

export class InstallError extends Error {}

export interface InstallOptions {
  name: string;
  intercoms: string[];
  /** How Claude Code is started here: a command and its arguments. Default: claude. */
  claudeCommand?: string[];
  /** How Codex is started here. It is not run, only named in what is printed. */
  codexCommand?: string[];
  env?: NodeJS.ProcessEnv;
}

/** The command of Claude Code where it is installed as a program. */
export const CLAUDE_COMMAND = ['claude'];
/** The command of Codex where it is installed as a program. */
export const CODEX_COMMAND = ['codex'];
/** Claude Code where it is run through npx and never installed. */
const CLAUDE_BY_NPX = 'npx -y @anthropic-ai/claude-code';

// ---- Codex --------------------------------------------------------------------

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CODEX_HOME?.trim() || path.join(homedir(), '.codex'), 'config.toml');
}

const tomlString = (value: string): string => JSON.stringify(value);

/** The table for config.toml. */
export function codexTable(name: string, intercoms: string[]): string {
  const { command, args } = launch(intercoms);
  return `[mcp_servers.${name}]\ncommand = ${tomlString(command)}\nargs = [${args.map(tomlString).join(', ')}]\n`;
}

/**
 * The lines of a server's table in a config.toml, sub-tables included, as
 * [start, end) line numbers; undefined when there is none.
 */
function codexBlock(lines: string[], name: string): [number, number] | undefined {
  const header = (line: string): string | undefined => /^\s*\[+\s*([^\]]+?)\s*\]+/.exec(line)?.[1];
  const own = (key: string): boolean =>
    key === `mcp_servers.${name}` || key.startsWith(`mcp_servers.${name}.`);
  const start = lines.findIndex((line) => {
    const key = header(line);
    return key !== undefined && own(key);
  });
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length) {
    const key = header(lines[end]!);
    if (key !== undefined && !own(key)) break;
    end++;
  }
  return [start, end];
}

/** config.toml with the table added, replaced or removed (`table` undefined). */
export function editCodexConfig(
  content: string,
  name: string,
  table: string | undefined,
): { content: string; was: 'absent' | 'ours' } {
  const lines = content.split('\n');
  const block = codexBlock(lines, name);
  if (block) {
    const existing = lines.slice(block[0], block[1]).join('\n');
    if (!existing.includes(PROGRAM)) {
      throw new InstallError(
        `Codex already has an MCP server named "${name}" that is not ${PROGRAM}; it was left as it is. Remove it yourself, or choose another name with --server-name.`,
      );
    }
    // Blank lines and comments after the table's last key belong to what follows.
    let end = block[1];
    while (end > block[0] + 1 && /^\s*(#.*)?$/.test(lines[end - 1]!)) end--;
    if (table) {
      lines.splice(block[0], end - block[0], ...table.trimEnd().split('\n'));
    } else {
      // With it goes the blank line that set it apart from what is above.
      const start = block[0] > 0 && lines[block[0] - 1]!.trim() === '' ? block[0] - 1 : block[0];
      lines.splice(start, end - start);
    }
    return { content: lines.join('\n'), was: 'ours' };
  }
  if (!table) return { content, was: 'absent' };
  const base = content.length === 0 || content.endsWith('\n') ? content : `${content}\n`;
  return { content: `${base}${base.trim() ? '\n' : ''}${table}`, was: 'absent' };
}

function writeCodex(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

function readCodex(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

// ---- Claude Code ----------------------------------------------------------------

/** The user-level server of that name in Claude Code's own state, if any. Read only. */
function claudeUserServer(name: string, env: NodeJS.ProcessEnv): unknown {
  const file = path.join(env.CLAUDE_CONFIG_DIR?.trim() || homedir(), '.claude.json');
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    return state.mcpServers?.[name];
  } catch {
    return undefined;
  }
}

/** An argument as it is typed in a shell. */
const quoted = (arg: string): string =>
  /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
const typed = (words: string[]): string => words.map(quoted).join(' ');

/**
 * Tells Claude Code something, one call of its command after the other.
 * When the command is not there, the error says exactly what was to be run,
 * so that it can be done by hand.
 */
async function claude(
  calls: string[][],
  env: NodeJS.ProcessEnv,
  command: string[] = CLAUDE_COMMAND,
): Promise<void> {
  const [program, ...leading] = command as [string, ...string[]];
  for (const args of calls) {
    try {
      await run(program, [...leading, ...args], { env, timeout: 180_000 });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      if (e.code === 'ENOENT') {
        throw new InstallError(
          `The command "${program}" was not found, and nothing was changed.\n` +
            'If Claude Code is started in another way on this machine, say how and run this again, for example:\n' +
            `  --claude-command "${CLAUDE_BY_NPX}"\n` +
            `Or do it by hand, with whatever starts Claude Code in place of "${typed(command)}":\n` +
            calls.map((c) => `  ${typed([...command, ...c])}`).join('\n'),
        );
      }
      throw new InstallError(
        `"${typed([...command, ...args])}" failed: ${(e.stderr || e.stdout || e.message).trim()}`,
      );
    }
  }
}

// ---- both -------------------------------------------------------------------------

const SESSIONS =
  'Sessions started from now on have the tool "intercom_join". A session joins when you paste the join text from the intercom\'s console into its chat, and is the same agent whenever it is started in the same directory again.';

export async function install(client: McpClient, options: InstallOptions): Promise<string> {
  const env = options.env ?? process.env;
  const { name, intercoms } = options;
  const allowed =
    intercoms.length > 0
      ? `It may join: ${intercoms.join(', ')}.`
      : 'It may join any intercom; name the ones to allow with --intercom.';
  if (client === 'codex') {
    const file = codexConfigPath(env);
    const edited = editCodexConfig(readCodex(file), name, codexTable(name, intercoms));
    writeCodex(file, edited.content);
    return `${edited.was === 'ours' ? 'Updated' : 'Added'} the MCP server "${name}" in ${file}.\n${allowed}\n${SESSIONS}\nIn Codex the tools of the intercom appear when a session is next started: after joining, leave the session and resume it (/quit, then "${typed(options.codexCommand ?? CODEX_COMMAND)} resume").`;
  }
  const existing = claudeUserServer(name, env);
  if (existing !== undefined) {
    if (!JSON.stringify(existing).includes(PROGRAM)) {
      throw new InstallError(
        `Claude Code already has a user-level MCP server named "${name}" that is not ${PROGRAM}; it was left as it is. Remove it yourself (claude mcp remove ${name} -s user), or choose another name with --server-name.`,
      );
    }
  }
  const { command, args } = launch(intercoms);
  await claude(
    [
      ...(existing === undefined ? [] : [['mcp', 'remove', name, '-s', 'user']]),
      ['mcp', 'add', '--scope', 'user', name, '--', command, ...args],
    ],
    env,
    options.claudeCommand,
  );
  return `${existing === undefined ? 'Added' : 'Updated'} the MCP server "${name}" for all your Claude Code sessions.\n${allowed}\n${SESSIONS}`;
}

export async function uninstall(
  client: McpClient,
  options: Pick<InstallOptions, 'name' | 'env' | 'claudeCommand'>,
): Promise<string> {
  const env = options.env ?? process.env;
  const { name } = options;
  if (client === 'codex') {
    const file = codexConfigPath(env);
    const edited = editCodexConfig(readCodex(file), name, undefined);
    if (edited.was === 'absent') return `Codex has no MCP server named "${name}" in ${file}.`;
    writeCodex(file, edited.content);
    return `Removed the MCP server "${name}" from ${file}. The identities of sessions are kept; see --list and --forget.`;
  }
  const existing = claudeUserServer(name, env);
  if (existing === undefined) return `Claude Code has no user-level MCP server named "${name}".`;
  if (!JSON.stringify(existing).includes(PROGRAM)) {
    throw new InstallError(
      `The user-level MCP server "${name}" of Claude Code is not ${PROGRAM}; it was left as it is.`,
    );
  }
  await claude([['mcp', 'remove', name, '-s', 'user']], env, options.claudeCommand);
  return `Removed the MCP server "${name}" from Claude Code. The identities of sessions are kept; see --list and --forget.`;
}
