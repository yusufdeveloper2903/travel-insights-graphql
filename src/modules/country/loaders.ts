import DataLoader from 'dataloader';
import type { CountryDataSource } from './datasource.js';
import type { CountryModel } from './model.js';

export function createCountryLoaders(ds: CountryDataSource) {
  return {
    /** Accepts ISO alpha-2 or alpha-3 codes, case-insensitive. */
    countryByCode: new DataLoader<string, CountryModel | null>((codes) => ds.findByCodes(codes), {
      cacheKeyFn: (code) => code.toUpperCase(),
    }),
  };
}
