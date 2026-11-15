import type { AddressInfo } from 'node:net';

import type { Logger } from './logger.js';
import type { Config } from './options.js';
import { createProxy } from './proxy.js';
import { Dispatcher, sinksFor, type Sink } from './sinks.js';
import { socketUrl } from './urls.js';
import { WakeupClient, type Timings } from './wakeup.js';

export interface RunningHelper {
  /** The local port the agent connects to. */
  port: number;
  wakeup: WakeupClient;
  dispatcher: Dispatcher;
  stop(): Promise<void>;
}

/**
 * Start the helper: a local proxy to the intercom that also opens the
 * intercom's wake-up socket, once a response has named it, and hands the
 * notifications to the configured delivery methods.
 */
export async function startHelper(opts: {
  config: Config;
  logger: Logger;
  /** Delivery methods; default: those the configuration asks for. */
  sinks?: Sink[];
  /** Reconnection timing; only tests change it. */
  timings?: Partial<Timings>;
}): Promise<RunningHelper> {
  const { config, logger } = opts;
  const sinks = opts.sinks ?? sinksFor(config, logger);
  const dispatcher = new Dispatcher(sinks, logger);
  // Until the delivery methods are ready, requests are forwarded and nothing more.
  let ready = false;

  const wakeup = new WakeupClient({
    deliver: (notification) => dispatcher.deliver(notification),
    logger,
    idleTimeoutMs: config.socketTimeout === undefined ? undefined : config.socketTimeout * 1000,
    ...(opts.timings ? { timings: opts.timings } : {}),
  });

  let warnedBadHeader = false;
  const server = createProxy({
    upstream: config.upstreamUrl,
    logger,
    hooks: {
      activity: (started) => wakeup.activity(started),
      announced: ({ socket, requestUrl, authorization }) => {
        if (!ready) return;
        const url = socketUrl(socket, requestUrl);
        if (url) {
          wakeup.announce(url, authorization);
        } else if (!warnedBadHeader) {
          warnedBadHeader = true;
          logger.warn('the intercom named a wake-up socket that is not a usable URL', {
            value: socket,
          });
        }
      },
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  try {
    // Started after listening: a delivery method may need the port.
    await dispatcher.start({ port });
  } catch (err) {
    dispatcher.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw err;
  }
  ready = true;

  return {
    port,
    wakeup,
    dispatcher,
    async stop() {
      wakeup.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Open event streams would otherwise keep the server alive.
        server.closeAllConnections();
      });
      await dispatcher.idle();
      dispatcher.stop();
    },
  };
}
