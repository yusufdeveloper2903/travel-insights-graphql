import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    base: { service: 'travel-insights-graphql' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}
