/**
 * Trading a join URL of an intercom for an agent's credentials.
 *
 * The URL is what a person pastes into a session's chat. It works once and
 * for a short time, and it is the only thing of the exchange that passes
 * through the model: the token it is traded for goes from the intercom
 * straight into this program's store.
 */

export interface Joined {
  mcpUrl: string;
  token: string;
  agent: { name: string; id: string };
  exchange: { name: string };
  /** What the session is to read: written by the intercom for its kind of client. */
  introduction: string;
}

export class JoinError extends Error {}

const JOIN_PATH = /\/mcp\/join\/[A-Za-z0-9_-]{16,}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An allowed intercom as given on the command line, as the start every join URL of it has. */
export function normalizeIntercom(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (!secure(url) || url.search || url.hash || url.username || url.password) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const secure = (url: URL): boolean =>
  url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));

/**
 * Check a join URL before anything is sent to it. `allowed` are the
 * intercoms named when this program was registered; with none, any intercom
 * may be joined.
 */
export function checkJoinUrl(text: string, allowed: string[]): URL {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new JoinError(
      'That is not a URL. A join URL looks like https://intercom.example.com/mcp/join/… and comes from the administrator of the intercom.',
    );
  }
  if (!secure(url)) {
    throw new JoinError('A join URL must be an https URL (http is accepted for localhost only).');
  }
  if (url.username || url.password || url.search || url.hash || !JOIN_PATH.test(url.pathname)) {
    throw new JoinError(
      'That is not a join URL of an intercom: it should end in /mcp/join/ and a long code, with nothing after it.',
    );
  }
  if (allowed.length > 0) {
    const base = `${url.origin}${url.pathname.replace(JOIN_PATH, '')}`;
    if (!allowed.includes(base)) {
      throw new JoinError(
        `This session may join these intercoms only: ${allowed.join(', ')}. The URL given is of another one (${base}), so nothing was sent to it. If the person really wants this, the intercom is added where the join tool was installed (--intercom).`,
      );
    }
  }
  return url;
}

/** Trade the URL. Nothing of the answer is logged or shown but the introduction. */
export async function trade(
  url: URL,
  who: { program: string; client?: { name: string; version?: string } | undefined },
  fetchFn: typeof fetch = fetch,
): Promise<Joined> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(who),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new JoinError(
      `The intercom at ${url.origin} could not be reached (${(err as Error).message}). The join URL was not used up; try again, or tell the person.`,
    );
  }
  if (!res.ok) {
    const said = (await res.text().catch(() => '')).trim().slice(0, 600);
    throw new JoinError(
      `The intercom refused the join URL (HTTP ${res.status})${said ? `: ${said}` : '.'}`,
    );
  }
  const data = (await res.json().catch(() => undefined)) as
    | {
        mcp_url?: unknown;
        token?: unknown;
        agent?: { name?: unknown; id?: unknown };
        exchange?: { name?: unknown };
        introduction?: unknown;
      }
    | undefined;
  if (
    !data ||
    typeof data.mcp_url !== 'string' ||
    typeof data.token !== 'string' ||
    typeof data.agent?.name !== 'string' ||
    typeof data.agent?.id !== 'string'
  ) {
    throw new JoinError(
      'The answer to the join URL was not what an intercom sends. The URL is used up now; ask the administrator for a new token.',
    );
  }
  // The credentials go where the intercom is, and nowhere else.
  let mcp: URL;
  try {
    mcp = new URL(data.mcp_url);
  } catch {
    throw new JoinError('The intercom named an MCP address that is not a URL.');
  }
  if (!secure(mcp) || mcp.origin !== url.origin) {
    throw new JoinError(
      'The intercom named an MCP address that is not its own. The URL is used up now; ask the administrator for a new token.',
    );
  }
  return {
    mcpUrl: mcp.toString(),
    token: data.token,
    agent: { name: data.agent.name, id: data.agent.id },
    exchange: { name: typeof data.exchange?.name === 'string' ? data.exchange.name : '' },
    introduction: typeof data.introduction === 'string' ? data.introduction : '',
  };
}

/** What became of the agent's token when a session left. */
export type Returned =
  /** The intercom revoked it. */
  | 'revoked'
  /** The intercom did not accept it any more. */
  | 'invalid'
  /** The intercom has no way of taking a token back (before 2.2). */
  | 'unsupported'
  /** The intercom could not be reached, or answered something else. */
  | 'unreachable';

/**
 * Give an agent's token back to the intercom it belongs to, which revokes
 * it. The opposite of trading a join URL.
 */
export async function giveBack(
  mcpUrl: string,
  token: string,
  who: { program: string; client?: { name: string; version?: string } | undefined },
  fetchFn: typeof fetch = fetch,
): Promise<Returned> {
  let res: Response;
  try {
    res = await fetchFn(new URL(mcpUrl.replace(/\/mcp\/?$/, '/mcp/leave')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(who),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return 'unreachable';
  }
  await res.arrayBuffer().catch(() => undefined);
  if (res.ok) return 'revoked';
  if (res.status === 401) return 'invalid';
  if (res.status === 404 || res.status === 405) return 'unsupported';
  return 'unreachable';
}
