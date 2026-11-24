import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstallError, codexTable, editCodexConfig } from '../src/local/install.js';
import { checkJoinUrl, normalizeIntercom } from '../src/local/joining.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const program = path.join(root, 'dist', 'mcp-cli.js');

const OURS = `[mcp_servers.intercom]
command = "npx"
args = ["-y", "-p", "tr-ai-intercom-helper", "tr-ai-intercom-mcp"]
`;

describe('the table in the Codex configuration', () => {
  it('names the program and the allowed intercoms', () => {
    expect(codexTable('intercom', [])).toBe(OURS);
    expect(codexTable('ic', ['https://intercom.example.com'])).toBe(
      `[mcp_servers.ic]
command = "npx"
args = ["-y", "-p", "tr-ai-intercom-helper", "tr-ai-intercom-mcp", "--intercom", "https://intercom.example.com"]
`,
    );
  });

  it('is added to an empty file and after what is there', () => {
    expect(editCodexConfig('', 'intercom', OURS)).toEqual({ content: OURS, was: 'absent' });
    const before = `model = "x"\n\n[projects."/a"]\ntrust_level = "trusted"\n`;
    expect(editCodexConfig(before, 'intercom', OURS).content).toBe(`${before}\n${OURS}`);
    // A file that does not end in a line break is completed first.
    expect(editCodexConfig('model = "x"', 'intercom', OURS).content).toBe(`model = "x"\n\n${OURS}`);
  });

  it('replaces its own table in place, sub-tables included, and nothing else', () => {
    const before = `[tui]
theme = "dark"

[mcp_servers.intercom]
command = "npx"
args = ["-y", "-p", "tr-ai-intercom-helper", "tr-ai-intercom-mcp", "--intercom", "https://old.example.com"]

[mcp_servers.intercom.env]
A = "b"

# kept
[mcp_servers.other]
url = "https://other.example.com/mcp"
`;
    const edited = editCodexConfig(before, 'intercom', OURS);
    expect(edited.was).toBe('ours');
    expect(edited.content).toBe(`[tui]
theme = "dark"

${OURS}
# kept
[mcp_servers.other]
url = "https://other.example.com/mcp"
`);
  });

  it('never touches a server of that name that is something else', () => {
    const before = `[mcp_servers.intercom]
url = "https://intercom.example.com/mcp"
bearer_token_env_var = "INTERCOM_X_MCP_BEARER_TOKEN"
`;
    expect(() => editCodexConfig(before, 'intercom', OURS)).toThrow(InstallError);
    expect(() => editCodexConfig(before, 'intercom', undefined)).toThrow(/left as it is/);
    // Under another name it is simply added.
    expect(editCodexConfig(before, 'intercom-join', codexTable('intercom-join', [])).was).toBe(
      'absent',
    );
  });

  it('removes its own table and leaves the rest as it was', () => {
    const rest = `[tui]\ntheme = "dark"\n`;
    // Exactly what was there before it was added.
    expect(
      editCodexConfig(editCodexConfig(rest, 'intercom', OURS).content, 'intercom', undefined),
    ).toEqual({
      content: rest,
      was: 'ours',
    });
    expect(editCodexConfig(rest, 'intercom', undefined)).toEqual({ content: rest, was: 'absent' });
    const between = `${rest}\n${OURS}\n[mcp_servers.other]\nurl = "x"\n`;
    expect(editCodexConfig(between, 'intercom', undefined).content).toBe(
      `${rest}\n[mcp_servers.other]\nurl = "x"\n`,
    );
  });
});

describe('what may be joined', () => {
  it('normalises an allowed intercom to the start of its join URLs', () => {
    expect(normalizeIntercom('https://intercom.example.com/')).toBe('https://intercom.example.com');
    expect(normalizeIntercom('https://example.com/intercom/')).toBe('https://example.com/intercom');
    expect(normalizeIntercom('http://localhost:8080')).toBe('http://localhost:8080');
    expect(normalizeIntercom('http://intercom.example.com')).toBeUndefined();
    expect(normalizeIntercom('https://user@intercom.example.com')).toBeUndefined();
    expect(normalizeIntercom('nonsense')).toBeUndefined();
  });

  it('accepts a join URL of an allowed intercom, also below a path', () => {
    const code = 'a'.repeat(43);
    expect(checkJoinUrl(` https://intercom.example.com/mcp/join/${code}\n`, []).pathname).toBe(
      `/mcp/join/${code}`,
    );
    const allowed = ['https://example.com/intercom'];
    expect(() =>
      checkJoinUrl(`https://example.com/intercom/mcp/join/${code}`, allowed),
    ).not.toThrow();
    expect(() => checkJoinUrl(`https://example.com/mcp/join/${code}`, allowed)).toThrow(
      /may join these intercoms only/,
    );
    expect(() =>
      checkJoinUrl(`https://example.com.evil.test/intercom/mcp/join/${code}`, allowed),
    ).toThrow();
  });
});

describe('--install and --uninstall', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = realpathSync(await mkdtemp(path.join(tmpdir(), 'helper-install-')));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const run = (
    args: string[],
    env: Record<string, string> = {},
  ): { status: number | null; stdout: string; stderr: string } => {
    const res = spawnSync(process.execPath, [program, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: tmp, ...env },
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  };

  it('registers with Codex in its config.toml, updates it, and removes it again', () => {
    const home = path.join(tmp, 'codex');
    const file = path.join(home, 'config.toml');
    const env = { CODEX_HOME: home };

    const added = run(['--install', 'codex', '--intercom', 'https://intercom.example.com/'], env);
    expect(added.status).toBe(0);
    expect(added.stdout).toContain(`Added the MCP server "intercom" in ${file}`);
    expect(added.stdout).toContain('It may join: https://intercom.example.com.');
    expect(added.stdout).toContain('/quit, then "codex resume"');
    expect(readFileSync(file, 'utf8')).toBe(
      codexTable('intercom', ['https://intercom.example.com']),
    );

    // The way Codex is started here is named in the advice, and changes nothing else.
    const updated = run(['--install', 'codex', '--codex-command', ' npx -y some-codex '], env);
    expect(updated.stdout).toContain('Updated the MCP server "intercom"');
    expect(updated.stdout).toContain('/quit, then "npx -y some-codex resume"');
    expect(updated.stdout).toContain('It may join any intercom');
    expect(readFileSync(file, 'utf8')).toBe(OURS);

    const removed = run(['--uninstall', 'codex'], env);
    expect(removed.stdout).toContain('Removed the MCP server "intercom"');
    expect(readFileSync(file, 'utf8')).toBe('');
    expect(run(['--uninstall', 'codex'], env).stdout).toContain('has no MCP server named');
  });

  it('leaves a foreign Codex server of the same name alone', () => {
    const home = path.join(tmp, 'codex');
    mkdirSync(home);
    const before = '[mcp_servers.intercom]\nurl = "https://intercom.example.com/mcp"\n';
    writeFileSync(path.join(home, 'config.toml'), before);
    const res = run(['--install', 'codex'], { CODEX_HOME: home });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('not tr-ai-intercom-mcp; it was left as it is');
    expect(readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe(before);
    expect(
      run(['--install', 'codex', '--server-name', 'intercom-join'], { CODEX_HOME: home }).status,
    ).toBe(0);
  });

  /** A stand-in for the claude command that writes down how it was called. */
  function fakeClaude(): { env: Record<string, string>; calls(): string[][] } {
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    const record = path.join(tmp, 'claude-calls');
    const script = path.join(bin, 'claude');
    writeFileSync(
      script,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    );
    chmodSync(script, 0o755);
    return {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, CLAUDE_CONFIG_DIR: tmp },
      calls: () =>
        existsSync(record)
          ? readFileSync(record, 'utf8')
              .trim()
              .split('\n')
              .map((l) => JSON.parse(l) as string[])
          : [],
    };
  }

  it('registers with Claude Code through its own command, for all sessions', () => {
    const claude = fakeClaude();
    const res = run(
      ['--install', 'claude', '--intercom', 'https://intercom.example.com'],
      claude.env,
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(
      'Added the MCP server "intercom" for all your Claude Code sessions',
    );
    expect(claude.calls()).toEqual([
      [
        'mcp',
        'add',
        '--scope',
        'user',
        'intercom',
        '--',
        'npx',
        '-y',
        '-p',
        'tr-ai-intercom-helper',
        'tr-ai-intercom-mcp',
        '--intercom',
        'https://intercom.example.com',
      ],
    ]);
  });

  it('replaces its own Claude Code registration and leaves a foreign one alone', () => {
    const claude = fakeClaude();
    const stateFile = path.join(tmp, '.claude.json');
    writeFileSync(
      stateFile,
      JSON.stringify({
        mcpServers: {
          intercom: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '-p', 'tr-ai-intercom-helper', 'tr-ai-intercom-mcp'],
          },
          other: { type: 'http', url: 'https://intercom.example.com/mcp' },
        },
      }),
    );
    const updated = run(['--install', 'claude'], claude.env);
    expect(updated.stdout).toContain('Updated the MCP server "intercom"');
    expect(claude.calls().map((c) => c.slice(0, 3).join(' '))).toEqual([
      'mcp remove intercom',
      'mcp add --scope',
    ]);

    const foreign = run(['--install', 'claude', '--server-name', 'other'], claude.env);
    expect(foreign.status).toBe(2);
    expect(foreign.stderr).toContain('left as it is');
    expect(run(['--uninstall', 'claude', '--server-name', 'other'], claude.env).status).toBe(2);
    expect(claude.calls()).toHaveLength(2);

    const removed = run(['--uninstall', 'claude'], claude.env);
    expect(removed.stdout).toContain('Removed the MCP server "intercom" from Claude Code');
    expect(claude.calls().at(-1)).toEqual(['mcp', 'remove', 'intercom', '-s', 'user']);
    expect(run(['--uninstall', 'claude', '--server-name', 'absent'], claude.env).stdout).toContain(
      'has no user-level MCP server',
    );
  });

  /** An environment in which no claude command is found. */
  const withoutClaude = (): Record<string, string> => {
    const bin = path.join(tmp, 'only-node');
    mkdirSync(bin, { recursive: true });
    if (!existsSync(path.join(bin, 'node'))) symlinkSync(process.execPath, path.join(bin, 'node'));
    return { PATH: bin, CLAUDE_CONFIG_DIR: tmp };
  };

  it('says exactly what to run by hand when the claude command is not found', () => {
    const res = run(
      ['--install', 'claude', '--intercom', 'https://intercom.example.com'],
      withoutClaude(),
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('The command "claude" was not found, and nothing was changed.');
    expect(res.stderr).toContain('--claude-command "npx -y @anthropic-ai/claude-code"');
    expect(res.stderr).toContain(
      '\n  claude mcp add --scope user intercom -- npx -y -p tr-ai-intercom-helper tr-ai-intercom-mcp --intercom https://intercom.example.com\n',
    );
    expect(res.stderr).not.toContain('<name>');

    // An update is two commands, and a chosen name is the one shown.
    writeFileSync(
      path.join(tmp, '.claude.json'),
      JSON.stringify({ mcpServers: { relay: { command: 'npx', args: ['tr-ai-intercom-mcp'] } } }),
    );
    const update = run(['--install', 'claude', '--server-name', 'relay'], withoutClaude());
    expect(update.stderr).toContain(
      '\n  claude mcp remove relay -s user\n  claude mcp add --scope user relay -- npx -y -p tr-ai-intercom-helper tr-ai-intercom-mcp\n',
    );
    const removal = run(['--uninstall', 'claude', '--server-name', 'relay'], withoutClaude());
    expect(removal.status).toBe(2);
    expect(removal.stderr).toContain('\n  claude mcp remove relay -s user\n');
  });

  it('starts Claude Code the way --claude-command says', () => {
    const claude = fakeClaude();
    const runner = path.join(tmp, 'bin', 'runner');
    renameSync(path.join(tmp, 'bin', 'claude'), runner);
    const env = {
      ...withoutClaude(),
      INTERCOM_MCP_OPT_CLAUDE_COMMAND: `${runner}  -y  some-package`,
    };
    const res = run(['--install', 'claude'], env);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Added the MCP server "intercom"');
    expect(claude.calls()).toEqual([
      [
        '-y',
        'some-package',
        'mcp',
        'add',
        '--scope',
        'user',
        'intercom',
        '--',
        'npx',
        '-y',
        '-p',
        'tr-ai-intercom-helper',
        'tr-ai-intercom-mcp',
      ],
    ]);

    const missing = run(['--install', 'claude', '--claude-command', 'no-such-runner -y pkg'], env);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('The command "no-such-runner" was not found');
    expect(missing.stderr).toContain(
      '\n  no-such-runner -y pkg mcp add --scope user intercom -- npx',
    );
  });

  it('accepts claude and codex only', () => {
    expect(run(['--install', 'cursor']).status).not.toBe(0);
    // A command for Grok is taken already, but there is nothing to install there yet.
    expect(run(['--install', 'grok', '--grok-command', 'npx -y some-grok']).status).not.toBe(0);
    expect(run(['--list', '--grok-command', 'npx -y some-grok']).status).toBe(0);
    expect(run(['--list', '--grok-command', ' ']).status).not.toBe(0);
  });
});
