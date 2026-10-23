import { describe, expect, it } from 'vitest';
import { TokenBucketRateLimiter } from '../../src/shared/rate-limiter.js';
import { FakeClock } from '../helpers/test-app.js';

describe('TokenBucketRateLimiter', () => {
  it('allows bursts up to capacity, then refills over time', () => {
    const clock = new FakeClock(0);
    const rl = new TokenBucketRateLimiter(3, 1, clock);
    expect([1, 2, 3].map(() => rl.take('ip').allowed)).toEqual([true, true, true]);
    const denied = rl.take('ip');
    expect(denied).toMatchObject({ allowed: false, retryAfterSec: 1 });
    clock.advance(1_000);
    expect(rl.take('ip').allowed).toBe(true);
    expect(rl.take('ip').allowed).toBe(false);
  });

  it('isolates keys', () => {
    const rl = new TokenBucketRateLimiter(1, 1, new FakeClock(0));
    expect(rl.take('a').allowed).toBe(true);
    expect(rl.take('b').allowed).toBe(true);
    expect(rl.take('a').allowed).toBe(false);
  });

  it('prunes fully refilled buckets and bounds the key count', () => {
    const clock = new FakeClock(0);
    const rl = new TokenBucketRateLimiter(2, 1, clock, 3);
    ['a', 'b', 'c', 'd'].forEach((k) => rl.take(k));
    expect(rl.size).toBe(3);
    clock.advance(2_000);
    rl.prune();
    expect(rl.size).toBe(0);
  });
});
