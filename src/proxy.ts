import http, {
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import https from 'node:https';

import type { Logger } from './logger.js';
import { upstreamUrl } from './urls.js';

/** Response header of the intercom's /mcp that tells where its wake-up socket is. */
export const SOCKET_HEADER = 'x-tr-ai-intercom-status-ws';

/**
 * Headers that belong to one connection and are not passed on (RFC 9110,
 * section 7.6.1), in either direction.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function passOn(headers: http.IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set(
    [headers.connection]
      .flat()
      .join(',')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ''),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name)) continue;
    out[name] = value;
  }
  return out;
}

export interface Announcement {
  /** The value of the socket header. */
  socket: string;
  /** The upstream URL the request went to. */
  requestUrl: URL;
  /** The Authorization header the agent sent with the request. */
  authorization: string;
}

export interface ProxyHooks {
  /** A request is being forwarded (`true`) or has ended (`false`). */
  activity?(started: boolean): void;
  /** A successful response named the wake-up socket. */
  announced?(announcement: Announcement): void;
}

/**
 * A transparent HTTP proxy to the intercom.
 *
 * Method, path, headers, body and status pass through unchanged in both
 * directions; only the Host header is rewritten and the hop-by-hop headers
 * are dropped. Bodies are streamed as they come, so event streams and
 * long-polls work, and the proxy has no timeout of its own. It never looks
 * into what it forwards, and adds no X-Forwarded-For, so the server's count
 * of proxies in front of it stays right.
 */
export function createProxy(opts: {
  /** Root URL of the intercom. */
  upstream: string;
  logger: Logger;
  hooks?: ProxyHooks;
}): http.Server {
  const { logger, hooks = {} } = opts;
  const secure = new URL(opts.upstream).protocol === 'https:';
  const agent = secure ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });
  const send = secure ? https.request : http.request;

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const target = upstreamUrl(opts.upstream, req.url ?? '/');
    const headers = passOn(req.headers);
    headers.host = target.host;
    hooks.activity?.(true);
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      hooks.activity?.(false);
    };

    const forward = send(target, { method: req.method, headers, agent }, (answer) => {
      const status = answer.statusCode ?? 502;
      const socket = answer.headers[SOCKET_HEADER];
      const authorization = req.headers.authorization;
      if (status >= 200 && status < 300 && typeof socket === 'string' && authorization) {
        hooks.announced?.({ socket, requestUrl: target, authorization });
      }
      res.writeHead(status, answer.statusMessage, passOn(answer.headers));
      // Send the headers now: an event stream may stay silent for a long time.
      res.flushHeaders();
      answer.pipe(res);
      answer.on('error', () => res.destroy());
    });

    forward.on('error', (err) => {
      end();
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      logger.warn('could not reach the intercom', { err, path: target.pathname });
      const body = JSON.stringify({
        error: 'upstream_unreachable',
        message: `tr-ai-intercom-helper could not reach ${target.origin}.`,
      });
      res.writeHead(502, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    });

    req.pipe(forward);
    req.on('error', () => forward.destroy());
    // The agent went away, or the response is complete.
    res.on('close', () => {
      end();
      if (!res.writableFinished) forward.destroy();
    });
  };

  const server = http.createServer(handle);
  // Long-polls and event streams must not be cut off by the proxy.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.on('close', () => agent.destroy());
  return server;
}
