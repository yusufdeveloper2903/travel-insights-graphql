export interface RetryOptions {
  /** Number of retries after the first attempt. */
  retries: number;
  /** Base delay for exponential backoff. */
  baseDelayMs: number;
  /** Upper bound for a single delay. */
  maxDelayMs?: number;
  /** Decide whether an error is worth retrying. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Called before sleeping; handy for logging/metrics. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Injected for deterministic tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * "Full jitter" exponential backoff (AWS Architecture Blog): delay = random(0, min(cap, base * 2^n)).
 * Spreads retries out so many clients do not hammer a recovering upstream in lockstep.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * exp);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const {
    retries,
    baseDelayMs,
    maxDelayMs = 5_000,
    shouldRetry = () => true,
    onRetry,
    random = Math.random,
    sleep = defaultSleep,
  } = opts;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err, attempt)) throw err;
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
      onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
    }
  }
}
