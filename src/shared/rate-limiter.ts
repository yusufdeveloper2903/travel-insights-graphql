import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until at least one token is available (0 when allowed). */
  retryAfterSec: number;
}

/**
 * Per-key token bucket with lazy refill: O(1) per request, no timers per key. Idle buckets
 * are pruned so memory stays bounded under IP churn. In a multi-instance deployment this
 * moves to Redis (or the edge/gateway); the interface stays the same.
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly clock: Clock = systemClock,
    private readonly maxKeys = 100_000,
  ) {}

  take(key: string, cost = 1): RateLimitResult {
    const now = this.clock.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsedSec = (now - b.updatedAt) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.updatedAt = now;

    // Re-insert to keep Map order ~ LRU for pruning.
    this.buckets.delete(key);
    this.buckets.set(key, b);
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }

    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
    }
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.ceil((cost - b.tokens) / this.refillPerSec),
    };
  }

  /** Drop buckets that have fully refilled; they are indistinguishable from new ones. */
  prune(): void {
    const now = this.clock.now();
    const fullAfterMs = (this.capacity / this.refillPerSec) * 1000;
    for (const [key, b] of this.buckets) {
      if (now - b.updatedAt >= fullAfterMs) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
