import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { watch } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, silentLogger } from '../src/logger.js';
import {
  Dispatcher,
  commandSink,
  dirSink,
  fileNameOf,
  fileSink,
  localSocketSink,
  urlSink,
  type Sink,
} from '../src/sinks.js';
import type { Notification } from '../src/wakeup.js';
import { sleep, until } from './stub.js';

let dir: string;
const cleanup: (() => Promise<void> | void)[] = [];

const note = (seq: number, message = 'inbox-activity'): Notification => ({
  message,
  seq,
  time: '2026-11-15T12:00:00.000Z',
  data: {},
});
const json = (n: Notification): string => JSON.stringify(n);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'helper-test-'));
});
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
  await rm(dir, { recursive: true, force: true });
});

describe('file', () => {
  it('appends one line of JSON per notification', async () => {
    const file = path.join(dir, 'notifications');
    const sink = fileSink(file);
    await sink.deliver(note(1), json(note(1)));
    await sink.deliver(note(2, 'inbox-reminder'), json(note(2, 'inbox-reminder')));
    const lines = (await readFile(file, 'utf8')).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[0]!)).toEqual(note(1));
    expect(JSON.parse(lines[1]!)).toEqual(note(2, 'inbox-reminder'));
  });

  it('keeps what is already in the file', async () => {
    const file = path.join(dir, 'notifications');
    await writeFile(file, 'earlier\n');
    await fileSink(file).deliver(note(1), json(note(1)));
    expect(await readFile(file, 'utf8')).toBe(`earlier\n${json(note(1))}\n`);
  });

  it('fails when the file cannot be written', async () => {
    await expect(
      fileSink(path.join(dir, 'missing', 'file')).deliver(note(1), json(note(1))),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe('directory', () => {
  it('names files by the sequence number, as at least eight hex digits', () => {
    expect(fileNameOf(1)).toBe('00000001.json');
    expect(fileNameOf(4775)).toBe('000012a7.json');
    expect(fileNameOf(0xffffffff)).toBe('ffffffff.json');
    expect(fileNameOf(0x123456789)).toBe('123456789.json');
  });

  it('writes one complete file per notification', async () => {
    const spool = path.join(dir, 'spool');
    const sink = dirSink(spool);
    await sink.start!();
    await sink.deliver(note(4775), json(note(4775)));
    await sink.deliver(note(4776), json(note(4776)));
    expect((await readdir(spool)).sort()).toEqual(['.tmp', '000012a7.json', '000012a8.json']);
    expect(JSON.parse(await readFile(path.join(spool, '000012a7.json'), 'utf8'))).toEqual(
      note(4775),
    );
    expect(await readdir(path.join(spool, '.tmp'))).toEqual([]);
  });

  it('needs write access to the directory only, not to its parent', async () => {
    const parent = path.join(dir, 'parent');
    const spool = path.join(parent, 'spool');
    await mkdir(spool, { recursive: true });
    await chmod(parent, 0o555);
    cleanup.push(() => chmod(parent, 0o755));
    const sink = dirSink(spool);
    await sink.start!();
    await sink.deliver(note(1), json(note(1)));
    expect((await readdir(spool)).sort()).toEqual(['.tmp', '00000001.json']);
    expect(await readdir(parent)).toEqual(['spool']);
  });

  it('shows a watcher of the directory one event per notification, for a finished file', async () => {
    const spool = path.join(dir, 'spool');
    const sink = dirSink(spool);
    await sink.start!();
    await sleep(100);
    const seen: { name: string; complete: boolean }[] = [];
    const reads: Promise<void>[] = [];
    const watcher = watch(spool, (_event, name) => {
      if (!name) return;
      reads.push(
        readFile(path.join(spool, String(name)), 'utf8').then(
          (text) => {
            seen.push({ name: String(name), complete: text.endsWith('}\n') });
          },
          () => {
            seen.push({ name: String(name), complete: false });
          },
        ),
      );
    });
    cleanup.push(() => watcher.close());
    await sleep(100);
    for (let seq = 1; seq <= 3; seq++) {
      await sink.deliver(note(seq), json(note(seq)));
      await sleep(150);
    }
    await Promise.all(reads);
    expect(seen).toEqual([
      { name: '00000001.json', complete: true },
      { name: '00000002.json', complete: true },
      { name: '00000003.json', complete: true },
    ]);
  });

  it('does not change the directory while the file is being prepared', async () => {
    const spool = path.join(dir, 'spool');
    const sink = dirSink(spool);
    await sink.start!();
    const before = (await stat(spool)).mtimeMs;
    await sleep(30);
    await writeFile(path.join(spool, '.tmp', 'being-written'), 'x');
    expect((await stat(spool)).mtimeMs).toBe(before);
    expect((await readdir(spool)).sort()).toEqual(['.tmp']);
  });

  it('clears what an earlier run left half-written, and nothing else', async () => {
    const spool = path.join(dir, 'spool');
    await mkdir(path.join(spool, '.tmp'), { recursive: true });
    await writeFile(path.join(spool, '.tmp', '0000000a.json.4242.tmp'), 'half');
    await writeFile(path.join(spool, '.tmp', 'somebody-elses-file'), 'keep');
    await writeFile(path.join(spool, '00000009.json'), 'unread');
    await dirSink(spool).start!();
    expect(await readdir(path.join(spool, '.tmp'))).toEqual(['somebody-elses-file']);
    expect((await readdir(spool)).sort()).toEqual(['.tmp', '00000009.json']);
  });

  it('uses another temporary directory when told to', async () => {
    const spool = path.join(dir, 'spool');
    const tmp = path.join(dir, 'elsewhere');
    const sink = dirSink(spool, tmp);
    await sink.start!();
    await sink.deliver(note(1), json(note(1)));
    expect(await readdir(spool)).toEqual(['00000001.json']);
    expect(await readdir(tmp)).toEqual([]);
  });

  it('replaces a file of the same number', async () => {
    const spool = path.join(dir, 'spool');
    const sink = dirSink(spool);
    await sink.start!();
    await sink.deliver(note(1), json(note(1)));
    await sink.deliver(note(1, 'missed'), json(note(1, 'missed')));
    expect(JSON.parse(await readFile(path.join(spool, '00000001.json'), 'utf8')).message).toBe(
      'missed',
    );
  });
});

describe('URL', () => {
  let server: http.Server;
  let url: string;
  let posts: { method: string; headers: http.IncomingHttpHeaders; body: string }[];
  let answer: number;

  beforeEach(async () => {
    posts = [];
    answer = 204;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        posts.push({
          method: req.method ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (answer === 0) return;
        res.writeHead(answer);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
  });

  it('posts the JSON', async () => {
    await urlSink(url).deliver(note(1), json(note(1)));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ method: 'POST', body: json(note(1)) });
    expect(posts[0]!.headers['content-type']).toBe('application/json');
    expect(posts[0]!.headers.authorization).toBeUndefined();
  });

  it('sends the extra header', async () => {
    const sink = urlSink(url, { name: 'Authorization', value: 'Bearer hook-secret' });
    await sink.deliver(note(1), json(note(1)));
    expect(posts[0]!.headers.authorization).toBe('Bearer hook-secret');
  });

  it('fails on an answer that is not a success', async () => {
    answer = 500;
    await expect(urlSink(url).deliver(note(1), json(note(1)))).rejects.toThrow(/500/);
  });

  it('gives up on a URL that does not answer', async () => {
    answer = 0;
    const started = Date.now();
    await expect(urlSink(url, undefined, 200).deliver(note(1), json(note(1)))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('local socket', () => {
  it('writes one notification per connection and closes', async () => {
    const socketPath = path.join(dir, 'sock');
    const received: string[] = [];
    const server = net.createServer((conn) => {
      let text = '';
      conn.on('data', (c) => (text += String(c)));
      conn.on('end', () => {
        received.push(text);
        conn.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const sink = localSocketSink(socketPath);
    await sink.deliver(note(1), json(note(1)));
    await sink.deliver(note(2), json(note(2)));
    await until(() => received.length === 2);
    expect(received).toEqual([`${json(note(1))}\n`, `${json(note(2))}\n`]);
  });

  it('fails when nothing listens', async () => {
    await expect(
      localSocketSink(path.join(dir, 'nobody')).deliver(note(1), json(note(1))),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe('command', () => {
  it('runs the command with the JSON on its input and the kind and number in its environment', async () => {
    const out = path.join(dir, 'out');
    const sink = commandSink(
      `{ cat; echo "$INTERCOM_NOTIFICATION_MESSAGE $INTERCOM_NOTIFICATION_SEQ"; } >> '${out}'`,
      silentLogger,
    );
    await sink.deliver(note(7), json(note(7)));
    expect(await readFile(out, 'utf8')).toBe(`${json(note(7))}\ninbox-activity 7\n`);
  });

  it('does not mind a command that ignores its input', async () => {
    const out = path.join(dir, 'out');
    await commandSink(`echo ran >> '${out}'`, silentLogger).deliver(note(1), json(note(1)));
    expect(await readFile(out, 'utf8')).toBe('ran\n');
  });

  it('fails when the command fails', async () => {
    await expect(
      commandSink('exit 3', silentLogger).deliver(note(1), json(note(1))),
    ).rejects.toThrow(/status 3/);
  });

  it('runs one at a time and keeps only the latest of those that wait', async () => {
    const out = path.join(dir, 'out');
    const sink = commandSink(
      `echo "start $INTERCOM_NOTIFICATION_SEQ" >> '${out}'; sleep 0.3; echo "end $INTERCOM_NOTIFICATION_SEQ" >> '${out}'`,
      silentLogger,
    );
    await Promise.all([1, 2, 3, 4].map((seq) => sink.deliver(note(seq), json(note(seq)))));
    expect((await readFile(out, 'utf8')).trim().split('\n')).toEqual([
      'start 1',
      'end 1',
      'start 4',
      'end 4',
    ]);
  });

  it('kills a command that runs too long', async () => {
    const started = Date.now();
    await expect(
      commandSink('sleep 30', silentLogger, 200).deliver(note(1), json(note(1))),
    ).rejects.toThrow(/killed/);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('the dispatcher', () => {
  it('hands each notification to every method', async () => {
    const file = path.join(dir, 'notifications');
    const spool = path.join(dir, 'spool');
    const dispatcher = new Dispatcher([fileSink(file), dirSink(spool)], silentLogger);
    await dispatcher.start();
    dispatcher.deliver(note(1));
    dispatcher.deliver(note(2));
    await dispatcher.idle();
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(2);
    expect((await readdir(spool)).sort()).toEqual(['.tmp', '00000001.json', '00000002.json']);
  });

  it('keeps the order within a method', async () => {
    const order: number[] = [];
    const slow: Sink = {
      name: 'slow',
      async deliver(n) {
        await sleep(n.seq === 1 ? 80 : 5);
        order.push(n.seq);
      },
    };
    const dispatcher = new Dispatcher([slow], silentLogger);
    for (const seq of [1, 2, 3]) dispatcher.deliver(note(seq));
    await dispatcher.idle();
    expect(order).toEqual([1, 2, 3]);
  });

  it('drops a notification a method cannot deliver, warns, and carries on', async () => {
    const lines: string[] = [];
    const file = path.join(dir, 'notifications');
    const broken: Sink = {
      name: 'broken',
      deliver: (n) => (n.seq === 1 ? Promise.reject(new Error('no luck')) : Promise.resolve()),
    };
    const dispatcher = new Dispatcher(
      [broken, fileSink(file)],
      createLogger('warn', (line) => lines.push(line)),
    );
    dispatcher.deliver(note(1));
    dispatcher.deliver(note(2));
    await dispatcher.idle();
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(2);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'warn',
      method: 'broken',
      seq: 1,
      err: 'no luck',
    });
  });

  it('adds nothing to a notification', async () => {
    const file = path.join(dir, 'notifications');
    const dispatcher = new Dispatcher([fileSink(file)], silentLogger);
    const burst: Notification = {
      message: 'burst',
      seq: 3,
      time: '2026-11-15T12:00:03.000Z',
      data: { burst: [note(2), note(3)] },
    };
    dispatcher.deliver(burst);
    await dispatcher.idle();
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(burst)}\n`);
  });
});
