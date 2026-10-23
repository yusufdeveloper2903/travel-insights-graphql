import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('boots with zero configuration', () => {
    const c = loadConfig({});
    expect(c.port).toBe(4000);
    expect(c.graphql.introspection).toBe(true);
    expect(c.cache.ttl).toEqual({
      countries: 86_400_000,
      geocoding: 604_800_000,
      weather: 600_000,
      fx: 3_600_000,
    });
  });

  it('disables introspection in production unless explicitly enabled', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).graphql.introspection).toBe(false);
    expect(
      loadConfig({ NODE_ENV: 'production', GRAPHQL_INTROSPECTION: 'true' }).graphql.introspection,
    ).toBe(true);
  });

  it('parses lists and fails loudly on invalid values', () => {
    expect(loadConfig({ CORS_ORIGINS: 'https://a.com, https://b.com' }).cors.origins).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
  });
});
