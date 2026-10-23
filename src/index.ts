import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createHttpServer } from './server.js';
import { createLogger } from './shared/logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel, config.env === 'development' && process.stdout.isTTY);
const app = createApp({ config, logger });
const http = createHttpServer(app, config, logger);

http.server.listen(config.port, config.host, () => {
  logger.info(
    {
      host: config.host,
      port: config.port,
      env: config.env,
      introspection: config.graphql.introspection,
    },
    `listening on http://${config.host}:${config.port}/graphql`,
  );
});

// Warm the country dataset in the background; the service reports ready either way, because
// every upstream is fetched lazily on demand and a cold cache only costs latency.
app
  .warmup()
  .then(() => {
    logger.info('warmup complete');
  })
  .catch((err: unknown) => {
    logger.warn({ err }, 'warmup failed; continuing with cold cache');
  })
  .finally(() => {
    http.markReady();
  });

let exiting = false;
const stop = (signal: string) => {
  if (exiting) return;
  exiting = true;
  logger.info({ signal }, 'received shutdown signal');
  http
    .shutdown()
    .then(() => {
      logger.info('shutdown complete');
      process.exit(0);
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    });
};

process.on('SIGTERM', () => {
  stop('SIGTERM');
});
process.on('SIGINT', () => {
  stop('SIGINT');
});
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandled rejection');
});
