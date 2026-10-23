import { describe, expect, it } from 'vitest';
import { USD_RATES } from '../helpers/fake-upstreams.js';
import { createTestApp } from '../helpers/test-app.js';

describe('Query.country', () => {
  it('resolves static data, capital weather, currencies with FX and borders', async () => {
    const { query } = createTestApp();
    const res = await query(`{
      country(code: "uz") {
        code code3 name capital region subregion flag landlocked
        coordinates { latitude longitude }
        languages { code name }
        capitalWeather { location { name } current { temperature condition } daily(days: 3) { date condition } }
        currencies { code name rate(base: "USD") }
        borders { code }
      }
    }`);
    expect(res.errors).toBeUndefined();
    const c = res.data.country;
    expect(c).toMatchObject({
      code: 'UZ',
      code3: 'UZB',
      name: 'Uzbekistan',
      capital: 'Tashkent',
      region: 'Asia',
      subregion: 'Central Asia',
      landlocked: true,
      currencies: [{ code: 'UZS', rate: USD_RATES.UZS }],
    });
    expect(c.capitalWeather.location.name).toBe('Tashkent');
    expect(c.capitalWeather.daily).toHaveLength(3);
    expect(c.capitalWeather.current.condition).toBe('Mainly clear');
    expect(c.borders.map((b: { code: string }) => b.code).sort()).toEqual([
      'AF',
      'KG',
      'KZ',
      'TJ',
      'TM',
    ]);
  });

  it('accepts alpha-3 codes', async () => {
    const { query } = createTestApp();
    const res = await query('{ country(code: "JPN") { code } }');
    expect(res.data.country.code).toBe('JP');
  });

  it('returns NOT_FOUND for unknown codes', async () => {
    const { query } = createTestApp();
    const res = await query('{ country(code: "XX") { name } }');
    expect(res.data.country).toBeNull();
    expect(res.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
  });

  it('returns BAD_USER_INPUT for malformed codes', async () => {
    const { query } = createTestApp();
    const res = await query('{ country(code: "U1") { name } }');
    expect(res.errors?.[0]?.extensions).toMatchObject({
      code: 'BAD_USER_INPUT',
      argumentName: 'code',
    });
  });
});

describe('Query.countries', () => {
  it('filters and paginates with Relay cursors', async () => {
    const { query } = createTestApp();
    const page = `query($after: String) {
      countries(filter: { subregion: "central asia" }, first: 2, after: $after) {
        totalCount
        edges { cursor node { code } }
        pageInfo { hasNextPage hasPreviousPage endCursor }
      }
    }`;
    const p1 = (await query(page)).data.countries;
    expect(p1.totalCount).toBe(5);
    expect(p1.edges.map((e: any) => e.node.code)).toEqual(['KZ', 'KG']);
    expect(p1.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: false });

    const p2 = (await query(page, { after: p1.pageInfo.endCursor })).data.countries;
    expect(p2.edges.map((e: any) => e.node.code)).toEqual(['TJ', 'TM']);
    const p3 = (await query(page, { after: p2.pageInfo.endCursor })).data.countries;
    expect(p3.edges.map((e: any) => e.node.code)).toEqual(['UZ']);
    expect(p3.pageInfo).toMatchObject({ hasNextPage: false, hasPreviousPage: true });
  });

  it('rejects oversized pages', async () => {
    const { query } = createTestApp();
    const res = await query('{ countries(first: 500) { totalCount } }');
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });
});

describe('Query.convert', () => {
  it('converts using the latest rate for the source currency', async () => {
    const { query } = createTestApp();
    const res = await query(
      '{ convert(amount: 100, from: "usd", to: "UZS") { from to rate result date } }',
    );
    expect(res.data.convert).toEqual({
      from: 'USD',
      to: 'UZS',
      rate: 12_000,
      result: 1_200_000,
      date: '2026-10-23',
    });
  });

  it('maps an upstream 422 to BAD_USER_INPUT', async () => {
    const { query } = createTestApp();
    const res = await query('{ convert(amount: 1, from: "XYZ", to: "USD") { result } }');
    expect(res.errors?.[0]).toMatchObject({
      message: 'Unsupported currency "XYZ"',
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('validates input before calling upstream', async () => {
    const { query, upstream } = createTestApp();
    const res = await query('{ convert(amount: -5, from: "USD", to: "EUR") { result } }');
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(upstream.calls.fx).toBe(0);
  });
});

describe('Query.compareDestinations', () => {
  const Q = `query($codes: [String!]!, $home: String, $w: ScoreWeights) {
    compareDestinations(codes: $codes, homeCurrency: $home, weights: $w) {
      homeCurrency weights { weather cost }
      best { country { code } }
      destinations { rank country { code } score weatherScore costScore currency exchangeRate fxChange90d summary warnings }
    }
  }`;

  it('ranks destinations by combined weather + FX score', async () => {
    const { query, upstream } = createTestApp();
    const res = await query(Q, { codes: ['UZ', 'TR', 'JP', 'uz'] });
    expect(res.errors).toBeUndefined();
    const r = res.data.compareDestinations;
    expect(r.homeCurrency).toBe('USD');
    expect(r.weights).toEqual({ weather: 0.6, cost: 0.4 });
    expect(r.destinations).toHaveLength(3); // deduplicated
    expect(r.destinations.map((d: any) => d.rank)).toEqual([1, 2, 3]);
    const scores = r.destinations.map((d: any) => d.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(r.best.country.code).toBe(r.destinations[0].country.code);
    for (const d of r.destinations) {
      // Fixture: historical rates are 5% lower -> USD up ~5.26% -> cost score ~76.3
      expect(d.fxChange90d).toBeCloseTo(5.26, 2);
      expect(d.costScore).toBeCloseTo(76.3, 1);
      expect(d.warnings).toEqual([]);
    }
    // One latest + one historical FX call, one batched forecast call for all capitals.
    expect(upstream.calls.fx).toBe(2);
    expect(upstream.calls.meteo).toBe(1);
  });

  it('treats the home currency as neutral cost', async () => {
    const { query } = createTestApp();
    const res = await query(Q, { codes: ['DE'], home: 'EUR' });
    expect(res.data.compareDestinations.destinations[0]).toMatchObject({
      currency: 'EUR',
      exchangeRate: 1,
      fxChange90d: 0,
      costScore: 50,
    });
  });

  it('degrades gracefully when the weather upstream is down', async () => {
    const { query, upstream } = createTestApp();
    upstream.down('meteo');
    const res = await query(Q, { codes: ['UZ', 'TR'], w: { weather: 1, cost: 1 } });
    expect(res.errors).toBeUndefined();
    for (const d of res.data.compareDestinations.destinations) {
      expect(d.weatherScore).toBeNull();
      expect(d.score).toBe(d.costScore); // renormalised to cost only
      expect(d.warnings[0]).toMatch(/^Weather unavailable/);
    }
  });

  it('rejects unknown codes, too many codes and bad weights', async () => {
    const { query } = createTestApp();
    expect((await query(Q, { codes: ['UZ', 'QQ'] })).errors?.[0]).toMatchObject({
      extensions: { code: 'NOT_FOUND', codes: ['QQ'] },
    });
    const many = ['UZ', 'KZ', 'KG', 'TJ', 'TM', 'AF', 'TR', 'JP', 'DE', 'FR', 'IT'];
    expect((await query(Q, { codes: many })).errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(
      (await query(Q, { codes: ['UZ'], w: { weather: 0, cost: 0 } })).errors?.[0]?.extensions?.code,
    ).toBe('BAD_USER_INPUT');
  });
});

describe('upstream failure handling', () => {
  it('retries transient upstream errors transparently', async () => {
    const { query, upstream } = createTestApp();
    upstream.failNext('countries', 2, 503);
    const res = await query('{ country(code: "TR") { name } }');
    expect(res.data.country.name).toBe('Türkiye');
    expect(upstream.calls.countries).toBe(3);
  });

  it('surfaces UPSTREAM_UNAVAILABLE with partial data when retries are exhausted', async () => {
    const { query, upstream } = createTestApp();
    upstream.down('meteo', 'network');
    const res = await query('{ country(code: "TR") { name weather { timezone } } }');
    expect(res.data.country).toEqual({ name: 'Türkiye', weather: null });
    expect(res.errors?.[0]).toMatchObject({
      path: ['country', 'weather'],
      extensions: { code: 'UPSTREAM_UNAVAILABLE', upstream: 'open-meteo' },
    });
    expect(upstream.calls.meteo).toBe(3); // 1 attempt + 2 retries
  });

  it('serves stale cached data while an upstream is down (SWR + stale-if-error)', async () => {
    const { query, upstream, clock } = createTestApp();
    const q = '{ country(code: "JP") { weather { current { temperature } } } }';
    const first = await query(q);
    clock.advance(11 * 60_000); // weather TTL (10m) expired, inside SWR window
    upstream.down('meteo');
    const second = await query(q);
    expect(second.errors).toBeUndefined();
    expect(second.data).toEqual(first.data);
  });

  it('masks unexpected internal errors', async () => {
    const { query, app } = createTestApp();
    app.dataSources.countries.getIndex = () => Promise.reject(new Error('db password is hunter2'));
    const res = await query('{ countries { totalCount } }');
    expect(res.errors?.[0]?.message).toBe('Unexpected error.');
    expect(JSON.stringify(res)).not.toContain('hunter2');
  });
});
