#!/usr/bin/env node
import { startHelper } from './helper.js';
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
      'no delivery method is configured (--notification-file, -dir, -url, -local-socket, -command): requests are forwarded, notifications go nowhere',
    );
  }

  const helper = await startHelper({ config, logger, sinks });
  logger.info('listening for the agent', { address: config.host, port: helper.port });

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
  if (err instanceof ConfigError) console.error(err.message);
  else if ((err as { code?: string }).code === 'EADDRINUSE') {
    console.error(`The local port is already in use: ${(err as Error).message}`);
  } else console.error(err);
  process.exit(1);
});
