import type { CachePolicy, SwrCache } from '../../shared/cache.js';
import type { HttpClient } from '../../shared/http-client.js';
import { toCountryModel, upstreamCountriesSchema, type CountryModel } from './model.js';

export interface CountryIndex {
  /** Sorted by name; the order cursors are defined against. */
  all: readonly CountryModel[];
  byCode: ReadonlyMap<string, CountryModel>;
}

/**
 * The upstream is a single static JSON document, so the whole dataset is fetched once, cached
 * for ~24h (with SWR) and indexed in memory. Lookups by code are then O(1) and never fan out.
 */
export class CountryDataSource {
  private indexFor = new WeakMap<readonly CountryModel[], CountryIndex>();

  constructor(
    private readonly http: HttpClient,
    private readonly cache: SwrCache,
    private readonly url: string,
    private readonly policy: CachePolicy,
  ) {}

  async getIndex(): Promise<CountryIndex> {
    const all = await this.cache.getOrLoad('countries:all', this.policy, async () => {
      const raw = await this.http.getJson(this.url, upstreamCountriesSchema);
      return raw.map(toCountryModel).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    });
    // Cache stores plain data (Redis-friendly); the index is derived once per dataset instance.
    let index = this.indexFor.get(all);
    if (!index) {
      const byCode = new Map<string, CountryModel>();
      for (const c of all) {
        byCode.set(c.code, c);
        byCode.set(c.code3, c);
      }
      index = { all, byCode };
      this.indexFor.set(all, index);
    }
    return index;
  }

  async findByCodes(codes: readonly string[]): Promise<(CountryModel | null)[]> {
    const { byCode } = await this.getIndex();
    return codes.map((c) => byCode.get(c.toUpperCase()) ?? null);
  }
}
