import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toCountryModel, upstreamCountriesSchema } from '../../src/modules/country/model.js';
import {
  decodeCursor,
  encodeCursor,
  filterCountries,
  paginate,
} from '../../src/modules/country/pagination.js';
import { BadUserInputError } from '../../src/shared/errors.js';

const all = upstreamCountriesSchema
  .parse(JSON.parse(readFileSync(new URL('../fixtures/countries.json', import.meta.url), 'utf8')))
  .map(toCountryModel)
  .sort((a, b) => a.name.localeCompare(b.name));

describe('filterCountries', () => {
  it('filters by region and subregion case-insensitively', () => {
    const central = filterCountries(all, { region: 'asia', subregion: 'CENTRAL ASIA' });
    expect(central.map((c) => c.code).sort()).toEqual(['KG', 'KZ', 'TJ', 'TM', 'UZ']);
  });
  it('matches common or official name substrings', () => {
    // Only the UK has "Kingdom" in its common name; the others match on official name.
    expect(filterCountries(all, { nameContains: 'kingdom' }).map((c) => c.code)).toEqual([
      'MA',
      'ES',
      'TH',
      'GB',
    ]);
    expect(filterCountries(all, { nameContains: 'uzbek' }).map((c) => c.code)).toEqual(['UZ']);
  });
  it('returns everything without a filter', () => {
    expect(filterCountries(all, null)).toHaveLength(all.length);
  });
});

describe('paginate', () => {
  it('walks the full list with cursors without gaps or duplicates', () => {
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    for (;;) {
      const page = paginate(all, 10, after);
      seen.push(...page.edges.map((e) => e.node.code));
      pages++;
      expect(page.pageInfo.hasPreviousPage).toBe(after !== null);
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(all.map((c) => c.code));
    expect(new Set(seen).size).toBe(all.length);
  });

  it('round-trips opaque cursors', () => {
    expect(decodeCursor(encodeCursor('UZ'))).toBe('UZ');
  });

  it('rejects malformed cursors and page sizes', () => {
    expect(() => paginate(all, 10, 'garbage')).toThrow(BadUserInputError);
    expect(() => paginate(all, 51, null)).toThrow(BadUserInputError);
    expect(() => paginate(all, -1, null)).toThrow(BadUserInputError);
  });
});
