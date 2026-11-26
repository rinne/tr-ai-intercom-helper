import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * A stand-in for the stream service endpoints of an intercom, with one
 * service. It behaves as the real one does towards the two programs: a
 * control socket that wants a hello and announces clients, a client's
 * request that is answered only when the serving side has taken it, an
 * accept URL that a WebSocket takes and a DELETE refuses.
 */
export interface FakeService {
  /** The control URL, for the serving side. */
  controlUrl: string;
  /** The URL for clients. */
  endpointUrl: string;
  /** What the control URL answers: let in, 403, or 404. */
  mode: 'ok' | 'dark' | 'gone';
  /** How long the serving side has to answer for a client. */
  acceptMs: number;
  /** How often a serving side said hello. */
  served: number;
  /** Whether a serving side is connected now. */
  serving(): boolean;
  /** The frames of kind "connection" that were sent. */
  announced: { connection: string; url: string }[];
  /** What clients were turned away with, by the reason the serving side gave. */
  refusals: string[];
  /** The headers of the last hello's request, to see what a program sends. */
  /** Close the control socket as the intercom would. */
  closeControl(code: number, reason: string): void;
  /** Cut every connection that runs. */
  cut(code: number, reason: string): void;
  close(): Promise<void>;
}

const token = (): string => randomBytes(24).toString('base64url');

export async function startFakeService(): Promise<FakeService> {
  const wss = new WebSocketServer({ noServer: true });
  const tokens = { control: token(), endpoint: token() };
  let control: WebSocket | null = null;
  let seq = 0;
  let count = 0;
  const pending = new Map<
    string,
    { id: string; req: IncomingMessage; socket: Duplex; head: Buffer; timer: NodeJS.Timeout }
  >();
  const pairs = new Set<WebSocket>();

  const refuse = (socket: Duplex, status: string, body: string): void => {
    socket.write(
      `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    socket.destroy();
  };

  const server = http.createServer((req, res) => {
    const match = /^\/mcp\/accept\/(.+)$/.exec(req.url ?? '');
    if (!match || req.method !== 'DELETE') {
      res.writeHead(426, { 'Content-Type': 'text/plain' }).end('Opened as a WebSocket.\n');
      return;
    }
    const waiting = pending.get(match[1]!);
    if (!waiting) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('No such connection.\n');
      return;
    }
    let reason = '';
    req.on('data', (chunk: Buffer) => (reason += chunk.toString()));
    req.on('end', () => {
      pending.delete(match[1]!);
      clearTimeout(waiting.timer);
      fake.refusals.push(reason);
      refuse(
        waiting.socket,
        '502 Bad Gateway',
        `The server of this stream service refused the connection${reason ? `: ${reason}` : '.'}\n`,
      );
      res.writeHead(204).end();
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const path = req.url ?? '';
    if (path === `/mcp/control/${tokens.control}`) {
      if (fake.mode === 'gone') return refuse(socket, '404 Not Found', 'No such control URL.\n');
      if (fake.mode === 'dark') return refuse(socket, '403 Forbidden', 'Closed for now.\n');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (raw) => {
          const frame = JSON.parse(String(raw)) as { message?: string };
          if (frame.message !== 'hello' || control === ws) return;
          if (control) {
            control.send(
              JSON.stringify({ message: 'connection-closed', data: { reason: 'replaced' } }),
            );
            control.close(4001, 'replaced');
          }
          control = ws;
          seq = 0;
          fake.served += 1;
          ws.send(
            JSON.stringify({
              message: 'hello',
              seq: 0,
              time: new Date().toISOString(),
              data: { service: 'sv_Test0001', accept_timeout_seconds: fake.acceptMs / 1000 },
            }),
          );
        });
        ws.on('close', () => {
          if (control === ws) control = null;
        });
      });
      return;
    }
    if (path === `/mcp/service/${tokens.endpoint}`) {
      if (!control) return refuse(socket, '503 Service Unavailable', 'No server is connected.\n');
      const accept = token();
      const id = `cn_${String(++count).padStart(8, '0')}`;
      const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/accept/${accept}`;
      pending.set(accept, {
        id,
        req,
        socket,
        head,
        timer: setTimeout(() => {
          pending.delete(accept);
          refuse(socket, '504 Gateway Timeout', 'The server did not answer in time.\n');
        }, fake.acceptMs),
      });
      fake.announced.push({ connection: id, url });
      control.send(
        JSON.stringify({
          message: 'connection',
          seq: ++seq,
          time: new Date().toISOString(),
          data: {
            connection: id,
            url,
            expires_in_seconds: fake.acceptMs / 1000,
            client: { address: '203.0.113.7' },
          },
        }),
      );
      return;
    }
    const taken = /^\/mcp\/accept\/(.+)$/.exec(path);
    const waiting = taken && pending.get(taken[1]!);
    if (!taken || !waiting) return refuse(socket, '404 Not Found', 'No such connection.\n');
    pending.delete(taken[1]!);
    clearTimeout(waiting.timer);
    wss.handleUpgrade(req, socket, head, (serving) => {
      wss.handleUpgrade(waiting.req, waiting.socket, waiting.head, (client) => {
        pairs.add(serving).add(client);
        const join = (from: WebSocket, to: WebSocket): void => {
          from.on('message', (data, isBinary) => to.send(data, { binary: isBinary }));
          from.on('close', () => {
            pairs.delete(from);
            if (to.readyState === to.OPEN) to.close(1000, 'peer-closed');
          });
        };
        join(serving, client);
        join(client, serving);
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake: FakeService = {
    controlUrl: `${base}/mcp/control/${tokens.control}`,
    endpointUrl: `${base}/mcp/service/${tokens.endpoint}`,
    mode: 'ok',
    acceptMs: 2000,
    served: 0,
    serving: () => control !== null,
    announced: [],
    refusals: [],
    closeControl(code, reason) {
      control?.send(JSON.stringify({ message: 'connection-closed', data: { reason } }));
      control?.close(code, reason);
    },
    cut(code, reason) {
      for (const ws of pairs) ws.close(code, reason);
    },
    close: () =>
      new Promise((resolve) => {
        for (const p of pending.values()) {
          clearTimeout(p.timer);
          p.socket.destroy();
        }
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return fake;
}
