import DataLoader from 'dataloader';
import type { GeoPoint, WeatherReport } from './model.js';
import { coordKey, type GeocodingDataSource, type WeatherDataSource } from './datasource.js';

export function createWeatherLoaders(weather: WeatherDataSource, geocoding: GeocodingDataSource) {
  return {
    /**
     * All Country.weather / capitalWeather fields resolved in the same tick are collected
     * into one batch -> one Open-Meteo request (per 50 points). Duplicate points are deduped.
     */
    forecast: new DataLoader<GeoPoint, WeatherReport, string>(
      (points) => weather.getForecasts(points),
      {
        cacheKeyFn: (p) => coordKey(p.latitude, p.longitude),
        maxBatchSize: 200,
      },
    ),
    /** Geocoding has no batch API: DataLoader still dedupes identical lookups per request. */
    city: new DataLoader<{ name: string; countryCode: string }, GeoPoint | null, string>(
      (keys) =>
        Promise.all(
          keys.map((k) =>
            geocoding.findCity(k.name, k.countryCode).catch((e: unknown) => e as Error),
          ),
        ),
      { cacheKeyFn: (k) => `${k.countryCode.toUpperCase()}|${k.name.toLowerCase()}` },
    ),
  };
}
