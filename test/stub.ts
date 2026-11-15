import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

export const TOKEN = 'tai_good';
export const AUTH = `Bearer ${TOKEN}`;

export interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  body: string;
}

/** One wake-up socket as the stub server sees it. */
export interface ServerSocket {
  ws: WebSocket;
  authorization: string | undefined;
  path: string;
  /** Frames the client sent, parsed. */
  received: unknown[];
  send(frame: Record<string, unknown>): void;
  /** Resolves once the client has said hello. */
  hello(): Promise<unknown>;
  closed: Promise<number>;
}

/**
 * A stand-in for the intercom: an HTTP server that records what it is asked,
 * answers in a few useful ways, and serves a wake-up socket that the test
 * scripts by hand.
 */
export interface Stub {
  url: string;
  port: number;
  requests: SeenRequest[];
  /** Every attempt to open the socket, accepted or not. */
  attempts: { path: string; authorization: string | undefined }[];
  sockets: ServerSocket[];
  /** Authorization values the stub accepts. */
  accepted: Set<string>;
  /** Value of the socket header on successful responses; null leaves it out. */
  header: string | null;
  /** Answer upgrade requests with this status instead of accepting them. */
  refuseWith: number | undefined;
  /** Let a held /sse response finish. */
  release(): void;
  /** Requests the stub saw being aborted by the client. */
  aborted: string[];
  /** Resolves with the next socket that opens. */
  nextSocket(): Promise<ServerSocket>;
  close(): Promise<void>;
}

export async function startStub(): Promise<Stub> {
  const wss = new WebSocketServer({ noServer: true });
  const releases: (() => void)[] = [];
  const socketWaiters: ((s: ServerSocket) => void)[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const seen: SeenRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      stub.requests.push(seen);
      const path = seen.url.split('?')[0]!;
      const authorized = stub.accepted.has(req.headers.authorization ?? '');
      const extra: Record<string, string> =
        authorized && stub.header !== null ? { 'X-TR-AI-Intercom-Status-WS': stub.header } : {};

      if (path.endsWith('/drop')) {
        req.socket.destroy();
        return;
      }
      if (!authorized && !path.endsWith('/open')) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end('{"error":"unauthorized"}');
        return;
      }
      if (path.endsWith('/sse')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...extra });
        res.write('data: first\n\n');
        res.on('close', () => {
          if (!res.writableFinished) stub.aborted.push(seen.url);
        });
        releases.push(() => res.end('data: last\n\n'));
        return;
      }
      if (path.endsWith('/slow')) {
        const ms = Number(new URL(seen.url, 'http://x').searchParams.get('ms') ?? '500');
        const timer = setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json', ...extra });
          res.end('{"slow":true}');
        }, ms);
        res.on('close', () => {
          if (!res.writableFinished) {
            clearTimeout(timer);
            stub.aborted.push(seen.url);
          }
        });
        return;
      }
      const status = /\/status\/(\d+)$/.exec(path);
      if (status) {
        res.writeHead(Number(status[1]), { 'x-stub': 'yes', ...extra });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'session-1',
        'set-cookie': ['a=1', 'b=2'],
        ...extra,
      });
      res.end(JSON.stringify({ method: seen.method, url: seen.url, body: seen.body }));
    });
  });

  server.on('upgrade', (req, socket: Duplex, head) => {
    const path = (req.url ?? '').split('?')[0]!;
    const authorization = req.headers.authorization;
    stub.attempts.push({ path, authorization });
    const status = stub.refuseWith ?? (stub.accepted.has(authorization ?? '') ? undefined : 401);
    if (status !== undefined) {
      socket.write(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const received: unknown[] = [];
      const helloWaiters: ((frame: unknown) => void)[] = [];
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as { message?: string };
        received.push(frame);
        if (frame.message === 'hello') for (const w of helloWaiters.splice(0)) w(frame);
      });
      const side: ServerSocket = {
        ws,
        authorization,
        path,
        received,
        send: (frame) => ws.send(JSON.stringify(frame)),
        hello() {
          const seen = received.find((f) => (f as { message?: string }).message === 'hello');
          if (seen) return Promise.resolve(seen);
          return new Promise((resolve) => helloWaiters.push(resolve));
        },
        closed: new Promise((resolve) => ws.once('close', (code) => resolve(code))),
      };
      stub.sockets.push(side);
      for (const w of socketWaiters.splice(0)) w(side);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const stub: Stub = {
    url: `http://127.0.0.1:${port}`,
    port,
    requests: [],
    attempts: [],
    sockets: [],
    accepted: new Set([AUTH]),
    header: '/mcp/ws',
    refuseWith: undefined,
    aborted: [],
    release() {
      for (const r of releases.splice(0)) r();
    },
    nextSocket() {
      return new Promise((resolve) => socketWaiters.push(resolve));
    },
    async close() {
      for (const s of stub.sockets) s.ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
  return stub;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `check` holds, or fail after a while. */
export async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('the awaited condition never held');
    await sleep(10);
  }
}
