import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';

/**
 * Proves the N+1 problem is solved: 20 countries x (weather + capitalWeather + currency rate +
 * borders) would naively be 20 + 20 (+20 geocoding) + 20 + ~60 upstream calls.
 */
const PAGE = `{
  countries(first: 20) {
    nodes {
      code
      weather { current { temperature } }
      capitalWeather { current { temperature } }
      currencies { code rate(base: "USD") }
      borders { name currencies { rate(base: "USD") } }
    }
  }
}`;

describe('DataLoader batching', () => {
  it('collapses N+1 upstream calls into one batched call per source', async () => {
    const { query, upstream } = createTestApp();
    const res = await query(PAGE);
    expect(res.errors).toBeUndefined();
    expect(res.data.countries.nodes).toHaveLength(20);

    expect(upstream.calls.countries).toBe(1); // whole dataset, once
    expect(upstream.calls.fx).toBe(1); // one rate table for base USD serves all 20 + borders
    // Forecasts for all centroids are requested in a single multi-location call; capital
    // forecasts follow in one more batch once geocoding resolved (a dependent round trip).
    expect(upstream.calls.meteo).toBe(2);

    const [centroids, capitals] = upstream.urls.meteo;
    expect(centroids!.searchParams.get('latitude')!.split(',')).toHaveLength(20);
    expect(capitals!.searchParams.get('latitude')!.split(',').length).toBeGreaterThanOrEqual(19);

    // Geocoding has no batch endpoint: one call per distinct capital, never more.
    const capitals20 = res.data.countries.nodes.length;
    expect(upstream.calls.geo).toBeLessThanOrEqual(capitals20);
  });

  it('deduplicates identical loads within a request (aliases, repeated countries)', async () => {
    const { query, upstream } = createTestApp();
    const res = await query(`{
      a: country(code: "UZ") { weather { timezone } currencies { rate } }
      b: country(code: "uzb") { weather { timezone } currencies { rate } }
      c: country(code: "UZ") { weather { timezone } currencies { rate(base: "USD") } }
    }`);
    expect(res.errors).toBeUndefined();
    expect(upstream.calls.meteo).toBe(1);
    expect(upstream.urls.meteo[0]!.searchParams.get('latitude')!.split(',')).toHaveLength(1);
    expect(upstream.calls.fx).toBe(1);
  });

  it('serves a repeated query entirely from the shared cache', async () => {
    const { query, upstream } = createTestApp();
    await query(PAGE);
    upstream.reset();
    const res = await query(PAGE);
    expect(res.errors).toBeUndefined();
    expect(upstream.calls).toEqual({ countries: 0, meteo: 0, geo: 0, fx: 0 });
  });

  it('uses fresh loaders per request (no cross-request memoization)', async () => {
    const { query, upstream, clock } = createTestApp();
    await query('{ country(code: "TR") { weather { timezone } } }');
    clock.advance(25 * 60_000); // past TTL + SWR window for weather
    await query('{ country(code: "TR") { weather { timezone } } }');
    expect(upstream.calls.meteo).toBe(2);
  });
});
