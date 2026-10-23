import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { App } from './app.js';
import type { Config } from './config.js';
import type { Logger } from './shared/logger.js';
import { TokenBucketRateLimiter } from './shared/rate-limiter.js';

export interface HttpServer {
  server: Server;
  limiter: TokenBucketRateLimiter;
  markReady(): void;
  /** Stop accepting traffic, let in-flight requests finish, then close. */
  shutdown(): Promise<void>;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export function createHttpServer(app: App, config: Config, logger: Logger): HttpServer {
  const limiter = new TokenBucketRateLimiter(
    config.rateLimit.capacity,
    config.rateLimit.refillPerSec,
  );
  const pruneTimer = setInterval(() => {
    limiter.prune();
  }, 60_000).unref();
  let ready = false;
  let shuttingDown = false;
  const startedAt = Date.now();

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    // Probes are cheap and must never be rate limited.
    if (path === '/health') {
      sendJson(res, 200, { status: 'ok', uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
      return;
    }
    if (path === '/ready') {
      const ok = ready && !shuttingDown;
      sendJson(res, ok ? 200 : 503, {
        status: ok ? 'ready' : shuttingDown ? 'shutting_down' : 'starting',
        cache: app.cache.stats,
      });
      return;
    }

    if (shuttingDown) res.setHeader('connection', 'close');

    if (req.method !== 'OPTIONS') {
      const rl = limiter.take(clientIp(req, config.trustProxy));
      res.setHeader('x-ratelimit-limit', String(config.rateLimit.capacity));
      res.setHeader('x-ratelimit-remaining', String(rl.remaining));
      if (!rl.allowed) {
        sendJson(
          res,
          429,
          { errors: [{ message: 'Too many requests', extensions: { code: 'RATE_LIMITED' } }] },
          { 'retry-after': String(rl.retryAfterSec) },
        );
        return;
      }
    }

    void app.yoga(req, res);
  });

  server.keepAliveTimeout = 65_000; // > typical LB idle timeout (60s)
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  return {
    server,
    limiter,
    markReady() {
      ready = true;
    },
    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(pruneTimer);
      logger.info('shutting down: draining connections');
      const closed = new Promise<void>((resolve, reject) =>
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        }),
      );
      server.closeIdleConnections();
      const timeout = new Promise<'timeout'>((resolve) =>
        setTimeout(() => {
          resolve('timeout');
        }, config.shutdownTimeoutMs).unref(),
      );
      if ((await Promise.race([closed, timeout])) === 'timeout') {
        logger.warn('shutdown timeout reached; closing remaining connections');
        server.closeAllConnections();
      }
      await app.yoga.dispose();
    },
  };
}
