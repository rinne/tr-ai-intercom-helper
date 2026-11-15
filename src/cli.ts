#!/usr/bin/env node
import { startHelper } from './helper.js';
import { notifyCommand, type ListenerSink } from './listener.js';
import { createLogger } from './logger.js';
import { ConfigError, loadConfig } from './options.js';
import { sinksFor } from './sinks.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  // A mistake on the command line or in the environment prints the usage
  // text and ends the process here.
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const sinks = sinksFor(config, logger);
  logger.info('tr-ai-intercom-helper starting', {
    version: VERSION,
    upstream: config.upstreamUrl,
    methods: sinks.map((s) => s.name),
  });
  if (sinks.length === 0) {
    logger.warn(
      'no delivery method is configured (--notification-file, -dir, -url, -local-socket, -command, -listener): requests are forwarded, notifications go nowhere',
    );
  }

  const helper = await startHelper({ config, logger, sinks });
  logger.info('listening for the agent', { address: config.host, port: helper.port });
  if (config.listener) {
    const listener = sinks.find((s) => s.name === 'listener') as ListenerSink;
    logger.info('notification listener ready', {
      path: listener.path(),
      command: notifyCommand({ port: helper.port, path: config.listenerPath }),
    });
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { signal });
    setTimeout(() => process.exit(1), 5000).unref();
    void helper.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const code = (err as { code?: string }).code;
  if (code === 'EADDRINUSE') {
    console.error(`The local port is already in use: ${(err as Error).message}`);
  } else if (err instanceof ConfigError || err instanceof Error) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
