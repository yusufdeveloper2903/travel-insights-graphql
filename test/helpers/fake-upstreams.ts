import { readFileSync } from 'node:fs';
import type { FetchFn } from '../../src/shared/http-client.js';

export const countriesFixture: { cca2: string; capital: string[]; latlng: [number, number] }[] =
  JSON.parse(readFileSync(new URL('../fixtures/countries.json', import.meta.url), 'utf8'));

export const COUNTRIES_URL = 'https://countries.test/countries.json';
export const METEO_URL = 'https://meteo.test/v1';
export const GEO_URL = 'https://geo.test/v1';
export const FX_URL = 'https://fx.test/v2';

/** Latest "units per 1 USD"; historical rates are 5% lower (USD got stronger). */
export const USD_RATES: Record<string, number> = {
  EUR: 0.9,
  GBP: 0.75,
  JPY: 150,
  TRY: 50,
  UZS: 12_000,
  KZT: 450,
  THB: 36,
  AUD: 1.5,
  CAD: 1.4,
  MXN: 18,
  BRL: 5,
  ARS: 1500,
  EGP: 48,
  MAD: 9.5,
  NZD: 1.7,
  AFN: 65,
  KGS: 87,
  TJS: 10.5,
  VND: 26_000,
};

export type Host = 'countries' | 'meteo' | 'geo' | 'fx';

export interface FakeUpstreams {
  fetch: FetchFn;
  calls: Record<Host, number>;
  urls: Record<Host, URL[]>;
  /** Make the next N calls to a host fail with the given HTTP status (or a network error). */
  failNext(host: Host, times: number, status?: number | 'network'): void;
  /** Permanently fail a host. */
  down(host: Host, status?: number | 'network'): void;
  reset(): void;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Deterministic forecast derived from latitude: warm near the equator, cold near the poles. */
export function fakeForecast(lat: number, lon: number) {
  const base = 30 - Math.abs(lat) * 0.4;
  const days = Array.from({ length: 7 }, (_, i) => `2026-10-${String(23 + i).padStart(2, '0')}`);
  return {
    latitude: lat,
    longitude: lon,
    timezone: 'UTC',
    current: {
      time: '2026-10-23T12:00',
      temperature_2m: base,
      relative_humidity_2m: 40,
      apparent_temperature: base - 1,
      precipitation: 0,
      weather_code: 1,
      wind_speed_10m: 10,
    },
    daily: {
      time: days,
      weather_code: days.map((_, i) => (i % 3 === 0 ? 61 : 1)),
      temperature_2m_max: days.map(() => base + 4),
      temperature_2m_min: days.map(() => base - 6),
      precipitation_sum: days.map((_, i) => (i % 3 === 0 ? 3 : 0)),
      precipitation_probability_max: days.map((_, i) => (i % 3 === 0 ? 70 : 5)),
    },
  };
}

export function createFakeUpstreams(): FakeUpstreams {
  const calls: Record<Host, number> = { countries: 0, meteo: 0, geo: 0, fx: 0 };
  const urls: Record<Host, URL[]> = { countries: [], meteo: [], geo: [], fx: [] };
  const failures = new Map<Host, { remaining: number; status: number | 'network' }>();

  const hostOf = (url: URL): Host => {
    if (url.href.startsWith(COUNTRIES_URL)) return 'countries';
    if (url.href.startsWith(METEO_URL)) return 'meteo';
    if (url.href.startsWith(GEO_URL)) return 'geo';
    if (url.href.startsWith(FX_URL)) return 'fx';
    throw new Error(`Unexpected outbound request in test: ${url.href}`);
  };

  const fetch: FetchFn = (input) => {
    const url = new URL(input.toString());
    const host = hostOf(url);
    calls[host]++;
    urls[host].push(url);

    const f = failures.get(host);
    if (f && f.remaining > 0) {
      f.remaining--;
      if (f.status === 'network') return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(json({ error: 'boom' }, f.status));
    }

    switch (host) {
      case 'countries':
        return Promise.resolve(json(countriesFixture));
      case 'meteo': {
        const lats = url.searchParams.get('latitude')!.split(',').map(Number);
        const lons = url.searchParams.get('longitude')!.split(',').map(Number);
        const out = lats.map((lat, i) => fakeForecast(lat, lons[i]!));
        return Promise.resolve(json(out.length === 1 ? out[0] : out));
      }
      case 'geo': {
        const name = url.searchParams.get('name')!;
        const cc = url.searchParams.get('countryCode')!;
        const c = countriesFixture.find((x) => x.cca2 === cc && x.capital[0] === name);
        if (!c) return Promise.resolve(json({ generationtime_ms: 0.1 }));
        return Promise.resolve(
          json({
            results: [
              {
                name,
                latitude: c.latlng[0] + 0.25,
                longitude: c.latlng[1] + 0.25,
                country_code: cc,
                feature_code: 'PPLC',
                population: 1_000_000,
              },
            ],
          }),
        );
      }
      case 'fx': {
        const base = url.searchParams.get('base')!;
        const historical = url.searchParams.has('date');
        const usdTo: Record<string, number> = { USD: 1, ...USD_RATES };
        const baseRate = usdTo[base];
        if (baseRate === undefined) {
          return Promise.resolve(json({ status: 422, message: `invalid currency: ${base}` }, 422));
        }
        const factor = historical ? 0.95 : 1;
        const rows = Object.entries(usdTo)
          .filter(([q]) => q !== base)
          .map(([quote, r]) => ({
            date: historical ? url.searchParams.get('date') : '2026-10-23',
            base,
            quote,
            rate: (r / baseRate) * factor,
          }));
        return Promise.resolve(json(rows));
      }
    }
  };

  return {
    fetch,
    calls,
    urls,
    failNext(host, times, status = 503) {
      failures.set(host, { remaining: times, status });
    },
    down(host, status = 503) {
      failures.set(host, { remaining: Number.POSITIVE_INFINITY, status });
    },
    reset() {
      for (const k of Object.keys(calls) as Host[]) {
        calls[k] = 0;
        urls[k] = [];
      }
      failures.clear();
    },
  };
}
