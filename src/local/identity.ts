import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Which intercom agent a session is, by the directory the session was
 * started for. One file per directory, readable by the user only, since it
 * holds the agent's token.
 */
export interface Identity {
  /** The session's directory, resolved. */
  directory: string;
  /** The intercom's MCP endpoint. */
  mcpUrl: string;
  token: string;
  agent: { name: string; id: string };
  exchange: { name: string };
  joinedAt: string;
}

/** Where identities are kept unless told otherwise. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), '.config');
  return path.join(base, 'tr-ai-intercom');
}

/**
 * The directory a session belongs to: the project directory when the client
 * names one, else where the client started this program. Resolved, so that
 * two spellings of one place are one identity.
 */
export function sessionDirectory(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const named = env.CLAUDE_PROJECT_DIR?.trim();
  return canonical(named ? path.resolve(cwd, named) : cwd);
}

export function canonical(directory: string): string {
  const absolute = path.resolve(directory);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export class IdentityStore {
  private readonly dir: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'identities');
  }

  private fileOf(directory: string): string {
    return path.join(this.dir, `${createHash('sha256').update(directory).digest('hex')}.json`);
  }

  /** The identity of exactly this directory. Parents are not searched. */
  get(directory: string): Identity | undefined {
    try {
      const found = JSON.parse(readFileSync(this.fileOf(directory), 'utf8')) as Identity;
      return found.directory === directory && found.token && found.mcpUrl ? found : undefined;
    } catch {
      return undefined;
    }
  }

  put(identity: Identity): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.fileOf(identity.directory);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }

  /** True when there was one. */
  remove(directory: string): boolean {
    if (!this.get(directory)) return false;
    rmSync(this.fileOf(directory), { force: true });
    return true;
  }

  list(): Identity[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const found: Identity[] = [];
    for (const name of names) {
      try {
        const identity = JSON.parse(readFileSync(path.join(this.dir, name), 'utf8')) as Identity;
        if (identity.directory && identity.agent?.name) found.push(identity);
      } catch {
        // Not one of ours.
      }
    }
    return found.sort((a, b) => a.directory.localeCompare(b.directory));
  }
}
