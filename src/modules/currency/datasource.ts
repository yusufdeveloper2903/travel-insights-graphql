import type { CachePolicy, SwrCache } from '../../shared/cache.js';
import { BadUserInputError, UpstreamError } from '../../shared/errors.js';
import type { HttpClient } from '../../shared/http-client.js';
import { ratesResponseSchema, type RateTable } from './model.js';

/**
 * Frankfurter v2 (api.frankfurter.dev). v1 only covers ~30 ECB currencies; v2 covers ~165,
 * including UZS, KZT, etc. One call per base returns all quotes, so a whole page of countries
 * needs exactly one FX request.
 */
export class FxDataSource {
  constructor(
    private readonly http: HttpClient,
    private readonly cache: SwrCache,
    private readonly baseUrl: string,
    private readonly policy: CachePolicy,
  ) {}

  /** @param date ISO date (YYYY-MM-DD) for historical rates; omitted = latest. */
  async getRates(base: string, date?: string): Promise<RateTable> {
    // Historical rates are immutable: cache them much longer than the latest snapshot.
    const policy = date
      ? { ttlMs: this.policy.ttlMs * 24, staleWhileRevalidateMs: this.policy.ttlMs * 24 }
      : this.policy;
    return this.cache.getOrLoad(`fx:${base}:${date ?? 'latest'}`, policy, async () => {
      const url = new URL(`${this.baseUrl}/rates`);
      url.searchParams.set('base', base);
      if (date) url.searchParams.set('date', date);
      try {
        const rows = await this.http.getJson(url, ratesResponseSchema);
        const rates: Record<string, number> = {};
        let latest = '';
        for (const r of rows) {
          rates[r.quote] = r.rate;
          if (r.date > latest) latest = r.date;
        }
        rates[base] = 1;
        return { base, date: latest, rates };
      } catch (err) {
        if (err instanceof UpstreamError && (err.status === 422 || err.status === 404)) {
          throw new BadUserInputError(`Unsupported currency "${base}"`, {
            argumentName: 'currency',
          });
        }
        throw err;
      }
    });
  }
}
