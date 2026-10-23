import type { CachePolicy, SwrCache } from '../../shared/cache.js';
import { UpstreamError } from '../../shared/errors.js';
import type { HttpClient } from '../../shared/http-client.js';
import type { Logger } from '../../shared/logger.js';
import {
  forecastResponseSchema,
  geocodingResponseSchema,
  toWeatherReport,
  type GeoPoint,
  type UpstreamForecast,
  type WeatherReport,
} from './model.js';

export const FORECAST_DAYS = 7;
/** Open-Meteo accepts many coordinates per request; keep URLs comfortably short. */
export const MAX_LOCATIONS_PER_REQUEST = 50;

/** ~1.1 km grid: improves cache hit rate and lets DataLoader dedupe near-identical points. */
export const coordKey = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

export class WeatherDataSource {
  constructor(
    private readonly http: HttpClient,
    private readonly cache: SwrCache,
    private readonly baseUrl: string,
    private readonly policy: CachePolicy,
    private readonly logger: Logger,
  ) {}

  /**
   * Batch entry point used by the DataLoader. Fresh cache hits are served directly, stale hits
   * are served and refreshed in the background, and all misses are fetched with ONE upstream
   * request per 50 locations (Open-Meteo supports comma-separated coordinate lists).
   */
  async getForecasts(points: readonly GeoPoint[]): Promise<(WeatherReport | Error)[]> {
    const items = points.map((point) => ({
      point,
      key: `weather:${coordKey(point.latitude, point.longitude)}`,
    }));
    const cached = await this.cache.getMany<WeatherReport>(items.map((i) => i.key));

    const results = new Map<number, WeatherReport | Error>();
    const missing: { idx: number; point: GeoPoint }[] = [];
    const stale: GeoPoint[] = [];

    items.forEach(({ point, key }, idx) => {
      const hit = cached.get(key);
      if (!hit) {
        missing.push({ idx, point });
        return;
      }
      results.set(idx, { ...hit.value, location: { ...hit.value.location, name: point.name } });
      if (!this.cache.isFresh(hit)) stale.push(point);
    });

    if (stale.length > 0) {
      this.fetchAndStore(stale).catch((err: unknown) => {
        this.logger.warn({ err }, 'background weather refresh failed; serving stale');
      });
    }

    if (missing.length > 0) {
      try {
        const fetched = await this.fetchAndStore(missing.map((m) => m.point));
        missing.forEach((m, j) => {
          const report = fetched[j];
          if (report) results.set(m.idx, report);
        });
      } catch (err) {
        const e = err instanceof Error ? err : new UpstreamError('open-meteo', String(err));
        missing.forEach((m) => results.set(m.idx, e));
      }
    }
    return items.map(
      (_, idx) => results.get(idx) ?? new UpstreamError('open-meteo', 'missing forecast'),
    );
  }

  private async fetchAndStore(points: readonly GeoPoint[]): Promise<WeatherReport[]> {
    const out: WeatherReport[] = [];
    for (let i = 0; i < points.length; i += MAX_LOCATIONS_PER_REQUEST) {
      const chunk = points.slice(i, i + MAX_LOCATIONS_PER_REQUEST);
      const forecasts = await this.fetchChunk(chunk);
      if (forecasts.length !== chunk.length) {
        throw new UpstreamError(
          'open-meteo',
          `expected ${chunk.length} forecasts, got ${forecasts.length}`,
        );
      }
      const pairs = chunk.map((point, j) => ({ point, forecast: forecasts[j] }));
      for (const { point, forecast } of pairs) {
        if (!forecast) continue;
        const report = toWeatherReport(forecast, point.name);
        await this.cache.set(
          `weather:${coordKey(point.latitude, point.longitude)}`,
          report,
          this.policy,
        );
        out.push(report);
      }
    }
    return out;
  }

  private async fetchChunk(points: readonly GeoPoint[]): Promise<UpstreamForecast[]> {
    const url = new URL(`${this.baseUrl}/forecast`);
    url.searchParams.set('latitude', points.map((p) => p.latitude.toFixed(4)).join(','));
    url.searchParams.set('longitude', points.map((p) => p.longitude.toFixed(4)).join(','));
    url.searchParams.set(
      'current',
      'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
    );
    url.searchParams.set(
      'daily',
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max',
    );
    url.searchParams.set('forecast_days', String(FORECAST_DAYS));
    url.searchParams.set('timezone', 'auto');
    const res = await this.http.getJson(url, forecastResponseSchema);
    return Array.isArray(res) ? res : [res];
  }
}

export class GeocodingDataSource {
  constructor(
    private readonly http: HttpClient,
    private readonly cache: SwrCache,
    private readonly baseUrl: string,
    private readonly policy: CachePolicy,
  ) {}

  /** Resolve a city (e.g. a capital) within a country to coordinates. Null if unknown. */
  async findCity(name: string, countryCode: string): Promise<GeoPoint | null> {
    const key = `geo:${countryCode.toUpperCase()}:${name.toLowerCase()}`;
    // `null` results are cached too, so unknown places do not hammer the upstream.
    const hit = await this.cache.getOrLoad<GeoPoint | null>(key, this.policy, async () => {
      const url = new URL(`${this.baseUrl}/search`);
      url.searchParams.set('name', name);
      url.searchParams.set('count', '5');
      url.searchParams.set('language', 'en');
      url.searchParams.set('format', 'json');
      url.searchParams.set('countryCode', countryCode.toUpperCase());
      const res = await this.http.getJson(url, geocodingResponseSchema);
      const results = res.results ?? [];
      // Prefer the feature coded as a capital (PPLC), else the most populous match.
      const best =
        results.find((r) => r.feature_code === 'PPLC') ??
        [...results].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
      return best ? { latitude: best.latitude, longitude: best.longitude, name: best.name } : null;
    });
    return hit;
  }
}
