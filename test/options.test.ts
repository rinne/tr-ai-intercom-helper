import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../src/logger.js';
import {
  ConfigError,
  OPTIONS,
  loadConfig,
  parseHeaderLine,
  parseTimespec,
} from '../src/options.js';
import { sinksFor } from '../src/sinks.js';
import { silentLogger } from '../src/logger.js';

const URL_ARGS = ['--mcp-server-url', 'https://intercom.example.com/'];
const load = (args: string[] = []): ReturnType<typeof loadConfig> =>
  loadConfig([...URL_ARGS, ...args], { exitOnError: false });

const touched: string[] = [];
function setEnv(name: string, value: string): void {
  touched.push(name);
  process.env[name] = value;
}
afterEach(() => {
  for (const name of touched.splice(0)) delete process.env[name];
});

describe('options', () => {
  it('gives every option an environment variable named after it', () => {
    for (const def of OPTIONS) {
      const name = def.longName as string;
      expect(def.environment).toBe(`INTERCOM_HELPER_OPT_${name.toUpperCase().replace(/-/g, '_')}`);
      expect(def.description).toBeTruthy();
    }
  });

  it('has sensible defaults', () => {
    expect(load()).toEqual({
      upstreamUrl: 'https://intercom.example.com/',
      host: '127.0.0.1',
      port: 32323,
      logLevel: 'info',
      socketTimeout: undefined,
      file: undefined,
      dir: undefined,
      tmpDir: undefined,
      url: undefined,
      urlHeader: undefined,
      localSocket: undefined,
      command: undefined,
    });
  });

  it('needs the URL of the intercom', () => {
    expect(() => loadConfig([], { exitOnError: false })).toThrow(ConfigError);
    expect(() =>
      loadConfig(['--mcp-server-url', 'intercom.example.com'], { exitOnError: false }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(['--mcp-server-url', 'ftp://intercom.example.com'], { exitOnError: false }),
    ).toThrow(ConfigError);
  });

  it('takes every delivery method, one of each', () => {
    const config = load([
      '--notification-file=/tmp/n',
      '--notification-dir=/tmp/d',
      '--notification-tmp-dir=/tmp/t',
      '--notification-url=https://hook.example.com/x',
      '--notification-url-header=Authorization: Bearer abc',
      '--notification-local-socket=/tmp/s',
      '--notification-command=touch /tmp/c',
      '--notification-websocket-timeout=15m',
      '--listen-port=4000',
      '--listen-address=0.0.0.0',
      '--log-level=debug',
    ]);
    expect(config).toMatchObject({
      file: '/tmp/n',
      dir: '/tmp/d',
      tmpDir: '/tmp/t',
      url: 'https://hook.example.com/x',
      urlHeader: { name: 'Authorization', value: 'Bearer abc' },
      localSocket: '/tmp/s',
      command: 'touch /tmp/c',
      socketTimeout: 900,
      port: 4000,
      host: '0.0.0.0',
      logLevel: 'debug',
    });
    expect(sinksFor(config, silentLogger).map((s) => s.name)).toEqual([
      'file',
      'dir',
      'url',
      'local-socket',
      'command',
    ]);
    expect(sinksFor(load(), silentLogger)).toEqual([]);
  });

  it('refuses two of the same delivery method', () => {
    expect(() => load(['--notification-file=/a', '--notification-file=/b'])).toThrow(ConfigError);
  });

  it('refuses options that make no sense alone', () => {
    expect(() => load(['--notification-tmp-dir=/t'])).toThrow(ConfigError);
    expect(() => load(['--notification-url-header=X: y'])).toThrow(ConfigError);
  });

  it('refuses values that are not valid', () => {
    expect(() => load(['--listen-port=70000'])).toThrow(ConfigError);
    expect(() => load(['--notification-websocket-timeout=soon'])).toThrow(ConfigError);
    expect(() => load(['--notification-url=not a url'])).toThrow(ConfigError);
    expect(() =>
      load(['--notification-url=https://x.example', '--notification-url-header=no colon']),
    ).toThrow(ConfigError);
    expect(() => load(['--log-level=chatty'])).toThrow(ConfigError);
    expect(() => load(['extra'])).toThrow(ConfigError);
  });

  it('takes options from the environment, and the command line wins', () => {
    setEnv('INTERCOM_HELPER_OPT_MCP_SERVER_URL', 'http://from-env.example:8080');
    setEnv('INTERCOM_HELPER_OPT_LISTEN_PORT', '4001');
    setEnv('INTERCOM_HELPER_OPT_NOTIFICATION_FILE', '/env/file');
    const fromEnv = loadConfig([], { exitOnError: false });
    expect(fromEnv).toMatchObject({
      upstreamUrl: 'http://from-env.example:8080',
      port: 4001,
      file: '/env/file',
    });
    const mixed = loadConfig(['--listen-port', '4002'], { exitOnError: false });
    expect(mixed).toMatchObject({ upstreamUrl: 'http://from-env.example:8080', port: 4002 });
  });

  it('refuses an invalid value in the environment too', () => {
    setEnv('INTERCOM_HELPER_OPT_LISTEN_PORT', 'many');
    expect(() => load()).toThrow(ConfigError);
  });
});

describe('time spans', () => {
  it('are seconds unless a unit says otherwise', () => {
    expect(parseTimespec('90')).toBe(90);
    expect(parseTimespec('90s')).toBe(90);
    expect(parseTimespec('15m')).toBe(900);
    expect(parseTimespec('2h')).toBe(7200);
    expect(parseTimespec('1d')).toBe(86400);
    expect(parseTimespec('1.5')).toBe(1.5);
    expect(parseTimespec(' 2 H ')).toBe(7200);
    expect(parseTimespec('0')).toBe(0);
  });

  it('are nothing else', () => {
    for (const bad of ['', 'soon', '-5', '5w', '1h30m', 'm', '1e3']) {
      expect(parseTimespec(bad)).toBeUndefined();
    }
  });
});

describe('header lines', () => {
  it('are a name, a colon and a value', () => {
    expect(parseHeaderLine('Authorization: Bearer abc')).toEqual({
      name: 'Authorization',
      value: 'Bearer abc',
    });
    expect(parseHeaderLine('X-Key:v:with:colons')).toEqual({
      name: 'X-Key',
      value: 'v:with:colons',
    });
  });

  it('are nothing else', () => {
    for (const bad of ['no colon', ': value', 'Name:', 'Bad Name: v', 'X: a\r\nY: b']) {
      expect(parseHeaderLine(bad)).toBeUndefined();
    }
  });
});

describe('the log', () => {
  it('is JSON lines, at or above the chosen level', () => {
    const lines: string[] = [];
    const logger = createLogger('info', (line) => lines.push(line));
    logger.debug('hidden');
    logger.info('shown', { port: 1 });
    logger.error('failed', { err: Object.assign(new Error('boom'), { code: 'EBOOM' }) });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', msg: 'shown', port: 1 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ level: 'error', err: 'boom (EBOOM)' });
    expect(lines[0]!.endsWith('\n')).toBe(true);
  });

  it('is silent when told to be', () => {
    const lines: string[] = [];
    const logger = createLogger('silent', (line) => lines.push(line));
    logger.error('nothing');
    expect(lines).toEqual([]);
  });
});
