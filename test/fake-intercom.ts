import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * A stand-in for an intercom that speaks real MCP: one agent, a join
 * endpoint, a few tools and the inbox resource. It records what a client
 * said about itself.
 */

export const INBOX = 'intercom://inbox';
/** A tiny PNG, to see that an image passes through untouched. */
export const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

interface Session {
  server: Server;
  transport: StreamableHTTPServerTransport;
  subscribed: boolean;
}

export interface FakeIntercom {
  url: string;
  /** The token the agent has now. */
  token: string;
  agent: { name: string; id: string };
  /** A join URL for the agent's token. */
  joinUrl(): string;
  /** Replace the agent's token, as "New token" does; returns a join URL for the new one. */
  rotate(): string;
  /** Forget every MCP session, as a restart does. */
  forgetSessions(): void;
  /** Tell subscribed sessions that the inbox changed. */
  inboxChanged(): Promise<void>;
  /** Tools the agent has besides the usual ones, as when it was allowed something. */
  extraTools: string[];
  /** Tell every session that its list of tools changed. */
  toolsChanged(): Promise<void>;
  /** Client names given in MCP handshakes, in order. */
  clients: string[];
  /** Bodies of the join requests, in order. */
  joins: unknown[];
  /** Every request path, to see what did and did not reach it. */
  requests: string[];
  /** Calls of each tool. */
  calls: Record<string, number>;
  /** What the join endpoint answers with instead of joining, when set. */
  refuseJoin?: { status: number; body: string };
  /** False for an intercom that cannot take a token back (before 2.2). */
  takesBack: boolean;
  /** Bodies of the leave requests that were accepted, in order. */
  leaves: unknown[];
  close(): Promise<void>;
}

const readBody = async (req: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

export async function startFakeIntercom(agentName = 'builder'): Promise<FakeIntercom> {
  const sessions = new Map<string, Session>();
  const codes = new Map<string, string>();
  const used = new Set<string>();
  let n = 0;
  const newToken = (): string => `tai_test_${++n}_${randomUUID().replace(/-/g, '')}`;

  const fake: FakeIntercom = {
    url: '',
    token: newToken(),
    agent: { name: agentName, id: randomUUID() },
    joinUrl() {
      const code = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      codes.clear();
      codes.set(code, fake.token);
      return `${fake.url}/mcp/join/${code}`;
    },
    rotate() {
      fake.token = newToken();
      return fake.joinUrl();
    },
    forgetSessions() {
      for (const s of sessions.values()) void s.server.close().catch(() => undefined);
      sessions.clear();
    },
    async inboxChanged() {
      for (const s of sessions.values()) {
        if (s.subscribed) await s.server.sendResourceUpdated({ uri: INBOX });
      }
    },
    extraTools: [],
    async toolsChanged() {
      for (const s of sessions.values()) await s.server.sendToolListChanged();
    },
    clients: [],
    joins: [],
    takesBack: true,
    leaves: [],
    requests: [],
    calls: {},
    close: () =>
      new Promise((resolve) => {
        fake.forgetSessions();
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };

  function mcpServer(clientName: string, session: Session): Server {
    const server = new Server(
      { name: 'fake-intercom', version: '0.0.0' },
      {
        capabilities: { tools: { listChanged: true }, resources: { subscribe: true } },
        instructions: `RULES OF THE FAKE INTERCOM, worded for the client "${clientName}".`,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ['whoami', 'picture', 'slow', ...fake.extraTools].map((name) => ({
        name,
        description: `The ${name} tool of the fake intercom.`,
        inputSchema: { type: 'object' as const, properties: {} },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name } = request.params;
      fake.calls[name] = (fake.calls[name] ?? 0) + 1;
      if (name === 'whoami') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ name: fake.agent.name, said: request.params.arguments ?? {} }),
            },
          ],
        };
      }
      if (name === 'picture') {
        return {
          content: [
            { type: 'text' as const, text: 'a picture' },
            { type: 'image' as const, data: PNG, mimeType: 'image/png' },
          ],
        };
      }
      if (name === 'slow') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 60_000);
          extra.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            fake.calls.cancelled = (fake.calls.cancelled ?? 0) + 1;
            resolve();
          });
        });
        return { content: [{ type: 'text' as const, text: 'late' }] };
      }
      return { content: [{ type: 'text' as const, text: `No tool ${name}.` }], isError: true };
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{ uri: INBOX, name: 'inbox' }],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
      contents: [{ uri: request.params.uri, mimeType: 'application/json', text: '{"unread":[]}' }],
    }));
    server.setRequestHandler(SubscribeRequestSchema, async () => {
      session.subscribed = true;
      return {};
    });
    server.setRequestHandler(UnsubscribeRequestSchema, async () => {
      session.subscribed = false;
      return {};
    });
    return server;
  }

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      fake.requests.push(`${req.method} ${path}`);

      const join = /^\/mcp\/join\/([\w-]+)$/.exec(path);
      if (join) {
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' }).end('A join URL takes a POST.\n');
          return;
        }
        const body = await readBody(req);
        fake.joins.push(body ? JSON.parse(body) : null);
        if (fake.refuseJoin) {
          res.writeHead(fake.refuseJoin.status).end(fake.refuseJoin.body);
          return;
        }
        const code = join[1]!;
        const token = codes.get(code);
        if (!token) {
          res
            .writeHead(used.has(code) ? 410 : 404)
            .end(used.has(code) ? 'This join URL was used already.\n' : 'No such join URL.\n');
          return;
        }
        codes.delete(code);
        used.add(code);
        const said = fake.joins.at(-1) as { client?: { name?: string } } | null;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            mcp_url: `${fake.url}/mcp`,
            token,
            agent: fake.agent,
            exchange: { name: 'Default' },
            introduction: `You have joined the fake intercom as "${fake.agent.name}", in a ${said?.client?.name ?? 'nameless'} session.`,
            server_version: '0.0.0',
          }),
        );
        return;
      }

      if (path === '/mcp/leave' && fake.takesBack) {
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' }).end();
          return;
        }
        if (req.headers.authorization !== `Bearer ${fake.token}`) {
          res.writeHead(401).end('Missing or invalid bearer token.\n');
          return;
        }
        const body = await readBody(req);
        fake.leaves.push(body ? JSON.parse(body) : null);
        // Revoked: no token works until a new one is issued.
        fake.token = `revoked-${randomUUID()}`;
        fake.forgetSessions();
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ left: true, agent: fake.agent }));
        return;
      }

      if (path !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${fake.token}`) {
        res
          .writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' })
          .end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Missing or invalid bearer token.' },
              id: null,
            }),
          );
        return;
      }
      const id = req.headers['mcp-session-id'];
      let session = typeof id === 'string' ? sessions.get(id) : undefined;
      let parsed: unknown;
      if (req.method === 'POST') parsed = JSON.parse(await readBody(req));
      if (!session) {
        if (id !== undefined || req.method !== 'POST') {
          res.writeHead(404, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Unknown session. Initialize a new one.' },
              id: null,
            }),
          );
          return;
        }
        const clientName =
          (parsed as { params?: { clientInfo?: { name?: string } } })?.params?.clientInfo?.name ??
          '';
        fake.clients.push(clientName);
        const created = { subscribed: false } as Session;
        created.transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => void sessions.set(sid, created),
        });
        created.server = mcpServer(clientName, created);
        await created.server.connect(created.transport);
        session = created;
      }
      await session.transport.handleRequest(req, res, parsed);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  return fake;
}
