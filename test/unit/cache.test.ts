import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryLruStore,
  RedisCacheStore,
  SwrCache,
  type RedisLikeClient,
} from '../../src/shared/cache.js';
import { FakeClock } from '../helpers/test-app.js';

const policy = { ttlMs: 1_000, staleWhileRevalidateMs: 5_000 };
const flush = () => new Promise((r) => setImmediate(r));

function setup() {
  const clock = new FakeClock(0);
  const store = new InMemoryLruStore(100, clock);
  const cache = new SwrCache(store, { clock });
  return { clock, store, cache };
}

describe('InMemoryLruStore', () => {
  it('evicts the least recently used entry when full', async () => {
    const clock = new FakeClock(0);
    const store = new InMemoryLruStore(2, clock);
    const e = (v: number) => ({ value: v, freshUntil: 10, staleUntil: 10 });
    await store.set('a', e(1), 1000);
    await store.set('b', e(2), 1000);
    await store.get('a'); // touch a -> b is now LRU
    await store.set('c', e(3), 1000);
    expect(await store.get('b')).toBeUndefined();
    expect((await store.get('a'))?.value).toBe(1);
    expect((await store.get('c'))?.value).toBe(3);
  });

  it('expires entries after the hard TTL', async () => {
    const clock = new FakeClock(0);
    const store = new InMemoryLruStore(10, clock);
    await store.set('k', { value: 1, freshUntil: 0, staleUntil: 0 }, 100);
    clock.advance(99);
    expect(await store.get('k')).toBeDefined();
    clock.advance(1);
    expect(await store.get('k')).toBeUndefined();
    expect(store.size).toBe(0);
  });
});

describe('SwrCache', () => {
  it('serves fresh hits without calling the loader', async () => {
    const { cache } = setup();
    const loader = vi.fn().mockResolvedValue('v1');
    expect(await cache.getOrLoad('k', policy, loader)).toBe('v1');
    expect(await cache.getOrLoad('k', policy, loader)).toBe('v1');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stats).toMatchObject({ miss: 1, hit: 1 });
  });

  it('serves stale data immediately and revalidates once in the background', async () => {
    const { cache, clock } = setup();
    await cache.getOrLoad('k', policy, () => Promise.resolve('v1'));
    clock.advance(1_500); // past TTL, inside SWR window

    let resolveRefresh!: (v: string) => void;
    const loader = vi.fn(() => new Promise<string>((r) => (resolveRefresh = r)));
    // Two concurrent stale reads -> both get v1, only one refresh is started.
    const [a, b] = await Promise.all([
      cache.getOrLoad('k', policy, loader),
      cache.getOrLoad('k', policy, loader),
    ]);
    expect([a, b]).toEqual(['v1', 'v1']);
    expect(loader).toHaveBeenCalledTimes(1);

    resolveRefresh('v2');
    await flush();
    expect(await cache.getOrLoad('k', policy, loader)).toBe('v2');
    expect(cache.stats.stale).toBe(2);
  });

  it('keeps serving stale data when the background refresh fails', async () => {
    const { cache, clock } = setup();
    await cache.getOrLoad('k', policy, () => Promise.resolve('v1'));
    clock.advance(2_000);
    expect(await cache.getOrLoad('k', policy, () => Promise.reject(new Error('down')))).toBe('v1');
    await flush();
    expect(cache.stats.refreshFailures).toBe(1);
    expect(await cache.getOrLoad('k', policy, () => Promise.reject(new Error('down')))).toBe('v1');
  });

  it('treats data past the SWR window as a miss', async () => {
    const { cache, clock } = setup();
    await cache.getOrLoad('k', policy, () => Promise.resolve('v1'));
    clock.advance(6_001);
    expect(await cache.getOrLoad('k', policy, () => Promise.resolve('v2'))).toBe('v2');
  });

  it('single-flights concurrent misses', async () => {
    const { cache } = setup();
    const loader = vi.fn(async () => {
      await flush();
      return 42;
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cache.getOrLoad('k', policy, loader)),
    );
    expect(results).toEqual([42, 42, 42, 42, 42]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures on a miss', async () => {
    const { cache } = setup();
    await expect(
      cache.getOrLoad('k', policy, () => Promise.reject(new Error('x'))),
    ).rejects.toThrow('x');
    expect(await cache.getOrLoad('k', policy, () => Promise.resolve('ok'))).toBe('ok');
  });
});

describe('RedisCacheStore', () => {
  it('round-trips entries through a Redis-like client with PX expiry', async () => {
    const data = new Map<string, string>();
    const client: RedisLikeClient = {
      get: (k) => Promise.resolve(data.get(k) ?? null),
      set: vi.fn((k: string, v: string) => {
        data.set(k, v);
        return Promise.resolve('OK');
      }),
      del: (k) => Promise.resolve(data.delete(k)),
    };
    const store = new RedisCacheStore(client);
    await store.set('a', { value: { x: 1 }, freshUntil: 1, staleUntil: 2 }, 500);
    expect(client.set).toHaveBeenCalledWith('tig:a', expect.any(String), 'PX', 500);
    expect(await store.get('a')).toEqual({ value: { x: 1 }, freshUntil: 1, staleUntil: 2 });
    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
  });
});
