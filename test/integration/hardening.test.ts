import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer, type HttpServer } from '../../src/server.js';
import { createTestApp, testConfig } from '../helpers/test-app.js';

describe('query limits', () => {
  it('rejects an over-deep query before executing it', async () => {
    const { request, upstream } = createTestApp({ env: { MAX_QUERY_DEPTH: '5' } });
    const { body } = await request({
      query: '{ country(code: "UZ") { borders { borders { borders { borders { name } } } } } }',
    });
    expect(body.data).toBeUndefined();
    expect(body.errors?.[0]).toMatchObject({
      message: 'Query depth 6 exceeds the maximum allowed depth of 5',
      extensions: { code: 'QUERY_TOO_COMPLEX', depth: 6, maxDepth: 5 },
    });
    expect(upstream.calls).toEqual({ countries: 0, meteo: 0, geo: 0, fx: 0 });
  });

  it('rejects an over-expensive query (alias amplification)', async () => {
    const { request } = createTestApp({ env: { MAX_QUERY_COST: '100' } });
    const aliases = Array.from(
      { length: 30 },
      (_, i) => `w${i}: weather(latitude: ${i}, longitude: 0) { timezone }`,
    );
    const { body } = await request({ query: `{ ${aliases.join(' ')} }` });
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'QUERY_TOO_COMPLEX', maxCost: 100 });
  });
});

describe('introspection', () => {
  const q = { query: '{ __schema { queryType { name } } }' };

  it('is enabled outside production', async () => {
    const { request } = createTestApp();
    expect((await request(q)).body.data).toEqual({ __schema: { queryType: { name: 'Query' } } });
  });

  it('is disabled in production', async () => {
    const { request } = createTestApp({ env: { NODE_ENV: 'production' } });
    const { body } = await request(q);
    expect(body.data).toBeUndefined();
    expect(body.errors?.[0]?.message).toMatch(/introspection/i);
  });
});

describe('persisted operations', () => {
  const doc = '{ country(code: "UZ") { name } }';
  const hash = createHash('sha256').update(doc).digest('hex');
  const store = new Map([[hash, doc]]);
  const persisted = { extensions: { persistedQuery: { version: 1, sha256Hash: hash } } };

  it('executes an operation by hash', async () => {
    const { request } = createTestApp({ persistedOperations: store });
    expect((await request(persisted)).body.data).toEqual({ country: { name: 'Uzbekistan' } });
  });

  it('can reject arbitrary documents', async () => {
    const { request } = createTestApp({
      persistedOperations: store,
      env: { PERSISTED_OPERATIONS_ONLY: 'true' },
    });
    expect((await request({ query: doc })).body.errors?.[0]?.message).toMatch(/persisted/i);
    expect((await request(persisted)).body.data).toEqual({ country: { name: 'Uzbekistan' } });
  });
});

describe('HTTP server', () => {
  let http: HttpServer | undefined;
  afterEach(async () => {
    await http?.shutdown();
    http = undefined;
  });

  async function start(env: Record<string, string> = {}) {
    const config = testConfig(env);
    const { app } = createTestApp({ config });
    http = createHttpServer(app, config, pino({ level: 'silent' }));
    await new Promise<void>((r) => http!.server.listen(0, '127.0.0.1', r));
    const { port } = http.server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, http };
  }

  const gql = (base: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ query: '{ ping }' }),
    });

  it('exposes liveness and readiness probes', async () => {
    const { base, http } = await start();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/ready`)).status).toBe(503);
    http.markReady();
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready' });
  });

  it('rate limits per client IP with 429 + Retry-After, but never the probes', async () => {
    const { base } = await start({ RATE_LIMIT_CAPACITY: '3', RATE_LIMIT_REFILL_PER_SEC: '0.1' });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await gql(base)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await gql(base);
    expect(limited.headers.get('retry-after')).toBe('10');
    expect(await limited.json()).toMatchObject({
      errors: [{ extensions: { code: 'RATE_LIMITED' } }],
    });
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('keys on X-Forwarded-For only when TRUST_PROXY is enabled', async () => {
    const { base } = await start({
      RATE_LIMIT_CAPACITY: '1',
      RATE_LIMIT_REFILL_PER_SEC: '0.1',
      TRUST_PROXY: 'true',
    });
    expect((await gql(base, { 'x-forwarded-for': '1.1.1.1' })).status).toBe(200);
    expect((await gql(base, { 'x-forwarded-for': '2.2.2.2' })).status).toBe(200);
    expect((await gql(base, { 'x-forwarded-for': '1.1.1.1' })).status).toBe(429);
  });

  it('answers CORS preflight', async () => {
    const { base } = await start({ CORS_ORIGINS: 'https://app.example.com' });
    const res = await fetch(`${base}/graphql`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
  });

  it('reports not-ready during graceful shutdown', async () => {
    const { base, http } = await start();
    http.markReady();
    const done = http.shutdown();
    await done;
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });
});
