import { pino } from 'pino';
import { createApp, type AppDeps } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { Clock } from '../../src/shared/clock.js';
import {
  COUNTRIES_URL,
  createFakeUpstreams,
  FX_URL,
  GEO_URL,
  METEO_URL,
} from './fake-upstreams.js';

export class FakeClock implements Clock {
  constructor(public t = Date.parse('2026-10-23T12:00:00Z')) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    HTTP_RETRY_BASE_DELAY_MS: '0',
    COUNTRIES_DATASET_URL: COUNTRIES_URL,
    OPEN_METEO_URL: METEO_URL,
    GEOCODING_URL: GEO_URL,
    FRANKFURTER_URL: FX_URL,
    ...env,
  });
}

export interface GraphQLResponse<T = any> {
  data?: T;
  errors?: { message: string; path?: (string | number)[]; extensions?: Record<string, any> }[];
}

export function createTestApp({
  env,
  ...opts
}: { env?: Record<string, string> } & Partial<AppDeps> = {}) {
  const upstream = createFakeUpstreams();
  const clock = new FakeClock();
  const config = opts.config ?? testConfig(env);
  const app = createApp({
    config,
    logger: pino({ level: 'silent' }),
    fetch: upstream.fetch,
    clock,
    sleep: () => Promise.resolve(),
    ...opts,
  });

  async function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    const res = await app.yoga.fetch('http://test/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as GraphQLResponse };
  }

  async function query<T = any>(q: string, variables?: Record<string, unknown>) {
    return (await request({ query: q, variables })).body as GraphQLResponse<T>;
  }

  return { app, upstream, clock, config, query, request };
}
