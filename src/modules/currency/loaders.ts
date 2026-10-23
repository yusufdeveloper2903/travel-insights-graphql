import DataLoader from 'dataloader';
import type { FxDataSource } from './datasource.js';
import type { RateTable } from './model.js';

export interface RatesKey {
  base: string;
  date?: string | undefined;
}

export function createCurrencyLoaders(fx: FxDataSource) {
  return {
    /**
     * Currency.rate(base) on N countries -> one key per distinct base -> one upstream call.
     * Errors are returned per key so one bad base does not fail unrelated fields.
     */
    rates: new DataLoader<RatesKey, RateTable, string>(
      (keys) =>
        Promise.all(keys.map((k) => fx.getRates(k.base, k.date).catch((e: unknown) => e as Error))),
      { cacheKeyFn: (k) => `${k.base}@${k.date ?? 'latest'}` },
    ),
  };
}
