import type { YogaInitialContext } from 'graphql-yoga';
import type { Config } from './config.js';
import type { CountryDataSource } from './modules/country/datasource.js';
import { createCountryLoaders } from './modules/country/loaders.js';
import type { FxDataSource } from './modules/currency/datasource.js';
import { createCurrencyLoaders } from './modules/currency/loaders.js';
import type { GeocodingDataSource, WeatherDataSource } from './modules/weather/datasource.js';
import { createWeatherLoaders } from './modules/weather/loaders.js';
import type { Clock } from './shared/clock.js';
import type { Logger } from './shared/logger.js';

/** Long-lived, process-wide services (HTTP clients + shared cache live inside these). */
export interface DataSources {
  countries: CountryDataSource;
  weather: WeatherDataSource;
  geocoding: GeocodingDataSource;
  fx: FxDataSource;
}

export function createLoaders(ds: DataSources) {
  return {
    ...createCountryLoaders(ds.countries),
    ...createWeatherLoaders(ds.weather, ds.geocoding),
    ...createCurrencyLoaders(ds.fx),
  };
}

export type Loaders = ReturnType<typeof createLoaders>;

export interface GraphQLContext {
  requestId: string;
  config: Config;
  logger: Logger;
  clock: Clock;
  dataSources: DataSources;
  /**
   * Fresh per request: DataLoader's memoization cache must never be shared between users or
   * outlive a request, otherwise it becomes an unbounded, never-invalidated cache.
   */
  loaders: Loaders;
}

export type ServerContext = YogaInitialContext;
