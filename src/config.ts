import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const minutes = (n: number) => n * 60_000;

/**
 * Environment contract. Every variable has a safe default so the service boots with zero
 * configuration and zero external infrastructure.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  CORS_ORIGINS: csv.default(['*']),
  TRUST_PROXY: bool.default(false),
  RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_REFILL_PER_SEC: z.coerce.number().positive().default(1),

  GRAPHQL_INTROSPECTION: bool.optional(),
  MAX_QUERY_DEPTH: z.coerce.number().int().positive().default(8),
  MAX_QUERY_COST: z.coerce.number().int().positive().default(1_500),
  PERSISTED_OPERATIONS_FILE: z.string().optional(),
  PERSISTED_OPERATIONS_ONLY: bool.default(false),

  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  HTTP_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  HTTP_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(150),

  CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(5_000),
  CACHE_TTL_COUNTRIES_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(minutes(24 * 60)),
  CACHE_TTL_GEOCODING_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(minutes(7 * 24 * 60)),
  CACHE_TTL_WEATHER_MS: z.coerce.number().int().positive().default(minutes(10)),
  CACHE_TTL_FX_MS: z.coerce.number().int().positive().default(minutes(60)),

  COUNTRIES_DATASET_URL: z
    .url()
    .default('https://cdn.jsdelivr.net/gh/mledoze/countries@5.1.0/countries.json'),
  OPEN_METEO_URL: z.url().default('https://api.open-meteo.com/v1'),
  GEOCODING_URL: z.url().default('https://geocoding-api.open-meteo.com/v1'),
  FRANKFURTER_URL: z.url().default('https://api.frankfurter.dev/v2'),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  env: Env['NODE_ENV'];
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  cors: { origins: string[] };
  trustProxy: boolean;
  rateLimit: { capacity: number; refillPerSec: number };
  graphql: {
    introspection: boolean;
    maxDepth: number;
    maxCost: number;
    persistedOperationsFile: string | undefined;
    persistedOperationsOnly: boolean;
  };
  http: { timeoutMs: number; retries: number; retryBaseDelayMs: number };
  cache: {
    maxEntries: number;
    ttl: { countries: number; geocoding: number; weather: number; fx: number };
  };
  upstreams: { countries: string; openMeteo: string; geocoding: string; frankfurter: string };
  shutdownTimeoutMs: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${details}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    cors: { origins: e.CORS_ORIGINS },
    trustProxy: e.TRUST_PROXY,
    rateLimit: { capacity: e.RATE_LIMIT_CAPACITY, refillPerSec: e.RATE_LIMIT_REFILL_PER_SEC },
    graphql: {
      introspection: e.GRAPHQL_INTROSPECTION ?? e.NODE_ENV !== 'production',
      maxDepth: e.MAX_QUERY_DEPTH,
      maxCost: e.MAX_QUERY_COST,
      persistedOperationsFile: e.PERSISTED_OPERATIONS_FILE,
      persistedOperationsOnly: e.PERSISTED_OPERATIONS_ONLY,
    },
    http: {
      timeoutMs: e.HTTP_TIMEOUT_MS,
      retries: e.HTTP_RETRIES,
      retryBaseDelayMs: e.HTTP_RETRY_BASE_DELAY_MS,
    },
    cache: {
      maxEntries: e.CACHE_MAX_ENTRIES,
      ttl: {
        countries: e.CACHE_TTL_COUNTRIES_MS,
        geocoding: e.CACHE_TTL_GEOCODING_MS,
        weather: e.CACHE_TTL_WEATHER_MS,
        fx: e.CACHE_TTL_FX_MS,
      },
    },
    upstreams: {
      countries: e.COUNTRIES_DATASET_URL,
      openMeteo: e.OPEN_METEO_URL.replace(/\/$/, ''),
      geocoding: e.GEOCODING_URL.replace(/\/$/, ''),
      frankfurter: e.FRANKFURTER_URL.replace(/\/$/, ''),
    },
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
  };
}
