import type { z } from 'zod';
import { UpstreamError } from './errors.js';
import type { Logger } from './logger.js';
import { withRetry, type RetryOptions } from './retry.js';

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** Logical upstream name used in logs and error extensions. */
  name: string;
  fetch: FetchFn;
  logger: Logger;
  timeoutMs: number;
  retries: number;
  retryBaseDelayMs: number;
  sleep?: RetryOptions['sleep'];
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Thin, typed wrapper over fetch:
 *  - per-attempt timeout via AbortSignal
 *  - retries with exponential backoff + full jitter for transient failures only
 *  - response validation with Zod (an upstream changing its shape is an upstream failure,
 *    not a 500 deep inside a resolver)
 */
export class HttpClient {
  constructor(private readonly opts: HttpClientOptions) {}

  get name(): string {
    return this.opts.name;
  }

  async getJson<S extends z.ZodType>(url: string | URL, schema: S): Promise<z.output<S>> {
    const { name, logger } = this.opts;
    const href = url.toString();

    return withRetry(
      async (attempt) => {
        const started = performance.now();
        let res: Response;
        try {
          res = await this.opts.fetch(href, {
            headers: { accept: 'application/json', 'user-agent': 'travel-insights-graphql/1.0' },
            signal: AbortSignal.timeout(this.opts.timeoutMs),
          });
        } catch (cause) {
          const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
          throw new UpstreamError(
            name,
            timedOut ? 'request timed out' : 'network error',
            undefined,
            {
              cause,
            },
          );
        }

        const durationMs = Math.round(performance.now() - started);
        logger.debug(
          { upstream: name, url: href, status: res.status, durationMs, attempt },
          'upstream call',
        );

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new UpstreamError(
            name,
            `HTTP ${res.status} ${body.slice(0, 200)}`.trim(),
            res.status,
            {
              retryable: RETRYABLE_STATUS.has(res.status),
            },
          );
        }

        let json: unknown;
        try {
          json = await res.json();
        } catch (cause) {
          throw new UpstreamError(name, 'invalid JSON body', res.status, {
            cause,
            retryable: false,
          });
        }

        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          logger.error(
            { upstream: name, url: href, issues: parsed.error.issues.slice(0, 5) },
            'upstream schema mismatch',
          );
          throw new UpstreamError(name, 'unexpected response shape', res.status, {
            retryable: false,
          });
        }
        return parsed.data;
      },
      {
        retries: this.opts.retries,
        baseDelayMs: this.opts.retryBaseDelayMs,
        shouldRetry: (err) => err instanceof UpstreamError && err.retryable,
        onRetry: (err, attempt, delayMs) => {
          logger.warn(
            { upstream: name, url: href, attempt, delayMs, err: (err as Error).message },
            'retrying upstream call',
          );
        },
        ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
      },
    );
  }
}
