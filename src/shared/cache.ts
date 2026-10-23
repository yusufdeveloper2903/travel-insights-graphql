import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { Logger } from './logger.js';

/**
 * Storage backend contract. Values are stored together with absolute timestamps, so a store
 * only needs to honour `hardTtlMs` for eviction. The in-memory LRU below is the default; a Redis
 * implementation is a ~20 line adapter (see RedisCacheStore).
 */
export interface CacheStore {
  get<T>(key: string): Promise<CacheEntry<T> | undefined>;
  set<T>(key: string, entry: CacheEntry<T>, hardTtlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CacheEntry<T> {
  value: T;
  /** Epoch ms after which the value is stale (still servable while revalidating). */
  freshUntil: number;
  /** Epoch ms after which the value must not be served at all. */
  staleUntil: number;
}

/** Bounded LRU built on Map insertion order: O(1) get/set/evict, no dependencies. */
export class InMemoryLruStore implements CacheStore {
  private readonly map = new Map<string, { entry: CacheEntry<unknown>; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly clock: Clock = systemClock,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const hit = this.map.get(key);
    if (!hit) return Promise.resolve(undefined);
    if (hit.expiresAt <= this.clock.now()) {
      this.map.delete(key);
      return Promise.resolve(undefined);
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, hit);
    return Promise.resolve(hit.entry as CacheEntry<T>);
  }

  set<T>(key: string, entry: CacheEntry<T>, hardTtlMs: number): Promise<void> {
    this.map.delete(key);
    this.map.set(key, { entry, expiresAt: this.clock.now() + hardTtlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
}

/** Minimal subset of an ioredis / node-redis v4 client, so no Redis dependency is required. */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export class RedisCacheStore implements CacheStore {
  constructor(
    private readonly client: RedisLikeClient,
    private readonly prefix = 'tig:',
  ) {}

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const raw = await this.client.get(this.prefix + key);
    return raw === null ? undefined : (JSON.parse(raw) as CacheEntry<T>);
  }

  async set<T>(key: string, entry: CacheEntry<T>, hardTtlMs: number): Promise<void> {
    await this.client.set(this.prefix + key, JSON.stringify(entry), 'PX', hardTtlMs);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.prefix + key);
  }
}

export interface CachePolicy {
  /** How long a value is considered fresh. */
  ttlMs: number;
  /** Extra window during which a stale value is served while it is refreshed in the background. */
  staleWhileRevalidateMs: number;
}

export type CacheStatus = 'hit' | 'stale' | 'miss';

export interface CacheStats {
  hit: number;
  stale: number;
  miss: number;
  refreshFailures: number;
}

/**
 * Read-through cache with stale-while-revalidate and single-flight loading:
 *  - fresh hit      -> return cached value
 *  - stale hit      -> return cached value immediately, refresh once in the background
 *  - miss           -> load; concurrent callers for the same key share one in-flight promise
 *  - refresh error  -> keep serving the stale value until `staleUntil` (stale-if-error)
 */
export class SwrCache {
  private readonly inflight = new Map<string, Promise<unknown>>();
  readonly stats: CacheStats = { hit: 0, stale: 0, miss: 0, refreshFailures: 0 };

  constructor(
    private readonly store: CacheStore,
    private readonly opts: { clock?: Clock; logger?: Logger } = {},
  ) {}

  private get now(): number {
    return (this.opts.clock ?? systemClock).now();
  }

  async getOrLoad<T>(key: string, policy: CachePolicy, loader: () => Promise<T>): Promise<T> {
    const entry = await this.store.get<T>(key);
    const now = this.now;

    if (entry && now < entry.freshUntil) {
      this.stats.hit++;
      return entry.value;
    }
    if (entry && now < entry.staleUntil) {
      this.stats.stale++;
      this.refresh(key, policy, loader).catch((err: unknown) => {
        this.stats.refreshFailures++;
        this.opts.logger?.warn({ err, key }, 'background cache refresh failed; serving stale');
      });
      return entry.value;
    }

    this.stats.miss++;
    return this.refresh(key, policy, loader);
  }

  /** Bulk variant used by DataLoader batch functions: returns hits and the list of missing keys. */
  async getMany<T>(keys: readonly string[]): Promise<Map<string, CacheEntry<T>>> {
    const out = new Map<string, CacheEntry<T>>();
    const now = this.now;
    const entries = await Promise.all(keys.map((k) => this.store.get<T>(k)));
    keys.forEach((k, i) => {
      const e = entries[i];
      if (e && now < e.staleUntil) out.set(k, e);
    });
    return out;
  }

  isFresh(entry: CacheEntry<unknown>): boolean {
    return this.now < entry.freshUntil;
  }

  async set(key: string, value: unknown, policy: CachePolicy): Promise<void> {
    const now = this.now;
    await this.store.set(
      key,
      {
        value,
        freshUntil: now + policy.ttlMs,
        staleUntil: now + policy.ttlMs + policy.staleWhileRevalidateMs,
      },
      policy.ttlMs + policy.staleWhileRevalidateMs,
    );
  }

  private refresh<T>(key: string, policy: CachePolicy, loader: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const p = (async () => {
      try {
        const value = await loader();
        await this.set(key, value, policy);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
