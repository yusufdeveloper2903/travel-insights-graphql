import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, withRetry } from '../../src/shared/retry.js';

describe('backoffDelay (full jitter)', () => {
  it('grows exponentially and is capped', () => {
    const max = () => 0.9999999;
    expect(backoffDelay(0, 100, 10_000, max)).toBe(99);
    expect(backoffDelay(1, 100, 10_000, max)).toBe(199);
    expect(backoffDelay(3, 100, 10_000, max)).toBe(799);
    expect(backoffDelay(20, 100, 1_000, max)).toBe(999);
  });

  it('is uniformly jittered between 0 and the exponential ceiling', () => {
    expect(backoffDelay(2, 100, 10_000, () => 0)).toBe(0);
    expect(backoffDelay(2, 100, 10_000, () => 0.5)).toBe(200);
  });
});

describe('withRetry', () => {
  it('retries until success and reports each delay', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const onRetry = vi.fn();
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, {
      retries: 3,
      baseDelayMs: 100,
      sleep,
      onRetry,
      random: () => 0.5,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[50], [100]]);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured number of retries', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('always')));
    await expect(
      withRetry(fn, { retries: 2, baseDelayMs: 0, sleep: () => Promise.resolve() }),
    ).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('fatal')));
    await expect(
      withRetry(fn, {
        retries: 5,
        baseDelayMs: 0,
        shouldRetry: () => false,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
