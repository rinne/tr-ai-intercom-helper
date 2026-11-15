import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { silentLogger } from '../src/logger.js';
import { createProxy, type Announcement } from '../src/proxy.js';
import { socketUrl, upstreamUrl } from '../src/urls.js';
import { AUTH, sleep, startStub, until, type Stub } from './stub.js';

let stub: Stub;
let proxy: http.Server;
let base: string;
let announcements: Announcement[];
let activity: boolean[];

async function listen(upstream: string): Promise<void> {
  announcements = [];
  activity = [];
  proxy = createProxy({
    upstream,
    logger: silentLogger,
    hooks: {
      announced: (a) => announcements.push(a),
      activity: (started) => activity.push(started),
    },
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  stub = await startStub();
  await listen(stub.url);
});
afterEach(async () => {
  stub.release();
  await new Promise<void>((resolve) => {
    proxy.close(() => resolve());
    proxy.closeAllConnections();
  });
  await stub.close();
});

describe('where a request goes', () => {
  it('joins the root URL and the request path with exactly one slash', () => {
    const to = (root: string, path: string): string => upstreamUrl(root, path).toString();
    expect(to('https://intercom.example.com', '/mcp')).toBe('https://intercom.example.com/mcp');
    expect(to('https://intercom.example.com/', '/mcp')).toBe('https://intercom.example.com/mcp');
    expect(to('https://intercom.example.com//', '//mcp')).toBe('https://intercom.example.com/mcp');
    expect(to('https://intercom.example.com/', 'mcp')).toBe('https://intercom.example.com/mcp');
    expect(to('http://localhost:8080', '/mcp?x=1&y=2')).toBe('http://localhost:8080/mcp?x=1&y=2');
    expect(to('https://example.com/intercom', '/mcp')).toBe('https://example.com/intercom/mcp');
    expect(to('https://example.com/intercom/', '/mcp/')).toBe('https://example.com/intercom/mcp/');
    expect(to('https://example.com', '/')).toBe('https://example.com/');
  });

  it('forwards to the path it was asked for, query included', async () => {
    await fetch(`${base}/mcp?a=1&b=two`, { headers: { Authorization: AUTH } });
    expect(stub.requests[0]).toMatchObject({ method: 'GET', url: '/mcp?a=1&b=two' });
  });

  it('keeps a path prefix of the root URL, with or without a trailing slash', async () => {
    for (const root of [`${stub.url}/prefix`, `${stub.url}/prefix/`]) {
      await new Promise<void>((resolve) => {
        proxy.close(() => resolve());
        proxy.closeAllConnections();
      });
      await listen(root);
      await fetch(`${base}/mcp`, { headers: { Authorization: AUTH } });
      expect(stub.requests.at(-1)!.url).toBe('/prefix/mcp');
    }
  });
});

describe('what passes through', () => {
  it('forwards method, headers and body, and returns status, headers and body', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: AUTH,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': 'abc',
        'X-Custom': 'kept',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('mcp-session-id')).toBe('session-1');
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(await res.json()).toEqual({
      method: 'POST',
      url: '/mcp',
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    const seen = stub.requests[0]!;
    expect(seen.headers).toMatchObject({
      authorization: AUTH,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': 'abc',
      'x-custom': 'kept',
    });
  });

  it('rewrites Host and adds nothing about the client', async () => {
    await fetch(`${base}/mcp`, { headers: { Authorization: AUTH } });
    const seen = stub.requests[0]!;
    expect(seen.headers.host).toBe(`127.0.0.1:${stub.port}`);
    for (const name of [
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'forwarded',
      'via',
    ]) {
      expect(seen.headers[name]).toBeUndefined();
    }
  });

  it('drops hop-by-hop headers, and those named in Connection', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        `${base}/mcp`,
        {
          method: 'POST',
          headers: {
            Authorization: AUTH,
            Connection: 'keep-alive, X-Private',
            'Keep-Alive': 'timeout=5',
            'X-Private': 'not for the server',
            'Proxy-Authorization': 'Basic abc',
            TE: 'trailers',
            'X-Kept': 'yes',
          },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end('body');
    });
    const seen = stub.requests[0]!;
    expect(seen.headers['x-private']).toBeUndefined();
    expect(seen.headers['keep-alive']).toBeUndefined();
    expect(seen.headers['proxy-authorization']).toBeUndefined();
    expect(seen.headers.te).toBeUndefined();
    expect(seen.headers['x-kept']).toBe('yes');
    expect(seen.body).toBe('body');
  });

  it('passes every method and every status through', async () => {
    const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { Authorization: AUTH } });
    expect(del.status).toBe(200);
    expect(stub.requests[0]!.method).toBe('DELETE');
    await del.text();

    const none = await fetch(`${base}/mcp`);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer');
    await none.text();

    for (const status of [202, 204, 404, 418, 500]) {
      const res = await fetch(`${base}/status/${status}`, { headers: { Authorization: AUTH } });
      expect(res.status).toBe(status);
      expect(res.headers.get('x-stub')).toBe('yes');
      await res.text();
    }
  });

  it('carries a large body both ways', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: AUTH },
      body: big,
    });
    const answer = (await res.json()) as { body: string };
    expect(answer.body.length).toBe(big.length);
    expect(stub.requests[0]!.body.length).toBe(big.length);
  });
});

describe('streams and long requests', () => {
  it('passes an event stream on as it comes, not when it ends', async () => {
    const res = await fetch(`${base}/sse`, { headers: { Authorization: AUTH } });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n');
    // The upstream response is still open here.
    stub.release();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe('data: last\n\n');
  });

  it('waits for a long-poll as long as it takes', async () => {
    const started = Date.now();
    const res = await fetch(`${base}/slow?ms=2500`, { headers: { Authorization: AUTH } });
    expect(await res.json()).toEqual({ slow: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2400);
  });

  it('gives up upstream when the agent gives up', async () => {
    const abort = new AbortController();
    const pending = fetch(`${base}/slow?ms=10000`, {
      headers: { Authorization: AUTH },
      signal: abort.signal,
    }).catch((err: unknown) => err);
    await until(() => stub.requests.length === 1);
    abort.abort();
    await pending;
    await until(() => stub.aborted.length === 1);
    expect(stub.aborted).toEqual(['/slow?ms=10000']);
  });

  it('closes an event stream upstream when the agent closes it', async () => {
    const res = await fetch(`${base}/sse`, { headers: { Authorization: AUTH } });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await until(() => stub.aborted.length === 1);
  });
});

describe('when the intercom cannot be reached', () => {
  it('answers 502 and says why', async () => {
    await stub.close();
    const res = await fetch(`${base}/mcp`, { headers: { Authorization: AUTH } });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'upstream_unreachable' });
    stub = await startStub();
  });

  it('answers 502 when the intercom drops the connection', async () => {
    const res = await fetch(`${base}/drop`, { headers: { Authorization: AUTH } });
    expect(res.status).toBe(502);
    await res.text();
  });
});

describe('what the proxy tells the helper', () => {
  it('reports the socket named by a successful response, with the request it came from', async () => {
    await (await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: AUTH } })).text();
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toMatchObject({ socket: '/mcp/ws', authorization: AUTH });
    expect(announcements[0]!.requestUrl.toString()).toBe(`${stub.url}/mcp`);
  });

  it('reports it for every successful response, of any kind', async () => {
    await (await fetch(`${base}/mcp`, { headers: { Authorization: AUTH } })).text();
    await (await fetch(`${base}/status/202`, { headers: { Authorization: AUTH } })).text();
    const stream = await fetch(`${base}/sse`, { headers: { Authorization: AUTH } });
    expect(announcements).toHaveLength(3);
    await stream.body!.cancel();
  });

  it('reports nothing without the header, without a token, or for a failure', async () => {
    await (await fetch(`${base}/mcp`)).text();
    await (await fetch(`${base}/status/404`, { headers: { Authorization: AUTH } })).text();
    await (await fetch(`${base}/open`)).text();
    stub.header = null;
    await (await fetch(`${base}/mcp`, { headers: { Authorization: AUTH } })).text();
    expect(announcements).toEqual([]);
  });

  it('reports when a request starts and when it ends', async () => {
    const pending = fetch(`${base}/slow?ms=300`, { headers: { Authorization: AUTH } });
    await until(() => activity.length === 1);
    expect(activity).toEqual([true]);
    await (await pending).text();
    await until(() => activity.length === 2);
    expect(activity).toEqual([true, false]);
    await sleep(50);
    expect(activity).toEqual([true, false]);
  });
});

describe('the socket URL from the header', () => {
  const request = new URL('https://intercom.example.com/mcp');

  it('uses a full URL as it is, with the scheme mapped', () => {
    expect(socketUrl('wss://other.example.com/mcp/ws', request)).toBe(
      'wss://other.example.com/mcp/ws',
    );
    expect(socketUrl('https://other.example.com/mcp/ws', request)).toBe(
      'wss://other.example.com/mcp/ws',
    );
    expect(socketUrl('http://localhost:8080/mcp/ws', request)).toBe('ws://localhost:8080/mcp/ws');
    expect(socketUrl('ws://localhost:8080/mcp/ws', request)).toBe('ws://localhost:8080/mcp/ws');
  });

  it('resolves a relative one against the request and maps http to ws, https to wss', () => {
    expect(socketUrl('/mcp/ws', request)).toBe('wss://intercom.example.com/mcp/ws');
    expect(socketUrl('/mcp/ws', new URL('http://localhost:8080/mcp'))).toBe(
      'ws://localhost:8080/mcp/ws',
    );
    expect(socketUrl('mcp/ws', new URL('https://example.com/intercom/mcp'))).toBe(
      'wss://example.com/intercom/mcp/ws',
    );
    expect(socketUrl(' /mcp/ws ', request)).toBe('wss://intercom.example.com/mcp/ws');
  });

  it('refuses what is not a web address', () => {
    expect(socketUrl('ftp://example.com/x', request)).toBeUndefined();
    expect(socketUrl('http://', request)).toBeUndefined();
  });
});
