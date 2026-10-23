import { randomUUID } from 'node:crypto';
import { createYoga, maskError, Logger as YogaLogger, type YogaServerInstance } from 'graphql-yoga';
import type { Config } from './config.js';
import {
  createLoaders,
  type DataSources,
  type GraphQLContext,
  type ServerContext,
} from './context.js';
import { buildPlugins } from './graphql/plugins.js';
import { buildSchema } from './graphql/schema.js';
import { CountryDataSource } from './modules/country/datasource.js';
import { FxDataSource } from './modules/currency/datasource.js';
import { GeocodingDataSource, WeatherDataSource } from './modules/weather/datasource.js';
import { InMemoryLruStore, SwrCache, type CacheStore } from './shared/cache.js';
import { systemClock, type Clock } from './shared/clock.js';
import { isAppError } from './shared/errors.js';
import { HttpClient, type FetchFn } from './shared/http-client.js';
import type { Logger } from './shared/logger.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  /** Injected so tests (and e.g. an undici Agent with keep-alive tuning) can replace it. */
  fetch?: FetchFn;
  clock?: Clock;
  cacheStore?: CacheStore;
  sleep?: (ms: number) => Promise<void>;
  persistedOperations?: Map<string, string>;
}

export interface App {
  yoga: YogaServerInstance<ServerContext, GraphQLContext>;
  dataSources: DataSources;
  cache: SwrCache;
  /** Pre-load slow-changing data so the first user request is fast. */
  warmup(): Promise<void>;
}

const REQUEST_ID_RE = /^[\w-]{1,64}$/;

/** Bridges Yoga's internal logger to pino so all logs share one structured format. */
function yogaLogger(logger: Logger): YogaLogger {
  return new YogaLogger({
    level: 'warn',
    writers: [
      {
        write(level, attrs, msg) {
          logger[level]({ yoga: true, ...(Array.isArray(attrs) ? { attrs } : attrs) }, msg ?? '');
        },
      },
    ],
  });
}

export function createApp(deps: AppDeps): App {
  const { config, logger } = deps;
  const clock = deps.clock ?? systemClock;
  const fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const cache = new SwrCache(
    deps.cacheStore ?? new InMemoryLruStore(config.cache.maxEntries, clock),
    {
      clock,
      logger,
    },
  );

  const http = (name: string) =>
    new HttpClient({
      name,
      fetch: fetchFn,
      logger,
      timeoutMs: config.http.timeoutMs,
      retries: config.http.retries,
      retryBaseDelayMs: config.http.retryBaseDelayMs,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });

  // Stale-while-revalidate windows: serve up to one extra TTL of stale data while refreshing.
  const ttl = config.cache.ttl;
  const swr = (ms: number) => ({ ttlMs: ms, staleWhileRevalidateMs: ms });

  const dataSources: DataSources = {
    countries: new CountryDataSource(
      http('countries'),
      cache,
      config.upstreams.countries,
      swr(ttl.countries),
    ),
    weather: new WeatherDataSource(
      http('open-meteo'),
      cache,
      config.upstreams.openMeteo,
      swr(ttl.weather),
      logger,
    ),
    geocoding: new GeocodingDataSource(
      http('open-meteo-geocoding'),
      cache,
      config.upstreams.geocoding,
      swr(ttl.geocoding),
    ),
    fx: new FxDataSource(http('frankfurter'), cache, config.upstreams.frankfurter, swr(ttl.fx)),
  };

  const isProd = config.env === 'production';

  const yoga = createYoga<ServerContext, GraphQLContext>({
    schema: buildSchema(),
    graphqlEndpoint: '/graphql',
    landingPage: false,
    graphiql: !isProd && { title: 'Travel Insights GraphQL' },
    logging: yogaLogger(logger),
    cors: {
      origin: config.cors.origins.includes('*') ? '*' : config.cors.origins,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['content-type', 'x-request-id'],
      maxAge: 600,
    },
    maskedErrors: {
      maskError(error, message, isDev) {
        const original = (error as { originalError?: unknown }).originalError;
        if (!isAppError(error) && !isAppError(original)) {
          logger.error({ err: original ?? error }, 'unexpected resolver error');
        }
        return maskError(error, message, isDev);
      },
    },
    plugins: buildPlugins(config, logger, deps.persistedOperations),
    context: ({ request }): GraphQLContext => {
      const incoming = request.headers.get('x-request-id');
      const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
      return {
        requestId,
        config,
        clock,
        logger: logger.child({ requestId }),
        dataSources,
        loaders: createLoaders(dataSources),
      };
    },
  });

  return {
    yoga,
    dataSources,
    cache,
    async warmup() {
      await dataSources.countries.getIndex();
    },
  };
}
