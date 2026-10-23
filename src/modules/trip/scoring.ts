/**
 * Pure trip-scoring functions. No I/O, no clock, no GraphQL: trivially unit-testable and the
 * single place product changes to "what makes a good destination" happen.
 */

export interface ForecastDay {
  temperatureMin: number;
  temperatureMax: number;
  precipitationSum: number | null;
  precipitationProbability: number | null;
}

export interface Weights {
  weather: number;
  cost: number;
}

export const DEFAULT_WEIGHTS: Weights = { weather: 0.6, cost: 0.4 };

/** Daytime temperature band that scores 1.0, and how many °C outside it the score hits 0. */
export const COMFORT_BAND = { min: 18, max: 26, falloff: 10 } as const;
/** A ±10% FX move maps to the ends of the 0..100 cost scale. */
export const FX_SENSITIVITY = 500;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Perceived daytime temperature: highs matter more than overnight lows for a traveller. */
export const daytimeTemperature = (d: Pick<ForecastDay, 'temperatureMin' | 'temperatureMax'>) =>
  0.7 * d.temperatureMax + 0.3 * d.temperatureMin;

export function temperatureComfort(t: number): number {
  if (t >= COMFORT_BAND.min && t <= COMFORT_BAND.max) return 1;
  const distance = t < COMFORT_BAND.min ? COMFORT_BAND.min - t : t - COMFORT_BAND.max;
  return clamp(1 - distance / COMFORT_BAND.falloff, 0, 1);
}

export type RainLevel = 'dry' | 'showers' | 'wet';

export function rainLevel(
  d: Pick<ForecastDay, 'precipitationSum' | 'precipitationProbability'>,
): RainLevel {
  const p = d.precipitationProbability ?? 0;
  const mm = d.precipitationSum ?? 0;
  if (p >= 50 || mm >= 2) return 'wet';
  if (p >= 20 || mm >= 0.5) return 'showers';
  return 'dry';
}

const RAIN_FACTOR: Record<RainLevel, number> = { dry: 1, showers: 0.8, wet: 0.5 };

export function dayComfort(d: ForecastDay): number {
  return temperatureComfort(daytimeTemperature(d)) * RAIN_FACTOR[rainLevel(d)];
}

/** 0..100, or null when there is no forecast. */
export function weatherScore(days: readonly ForecastDay[]): number | null {
  if (days.length === 0) return null;
  const avg = days.reduce((s, d) => s + dayComfort(d), 0) / days.length;
  return round1(avg * 100);
}

/**
 * Relative FX movement of the destination currency against the traveller's home currency.
 * Rates are "destination units per 1 home unit"; a higher rate now than before means the home
 * currency buys more, i.e. the destination got cheaper. Returns a fraction (0.05 = +5%).
 */
export function fxChange(rateNow: number, rateThen: number): number {
  if (!(rateNow > 0) || !(rateThen > 0)) throw new RangeError('rates must be positive');
  return rateNow / rateThen - 1;
}

/** 50 = unchanged purchasing power; 100 = home currency ≥10% stronger; 0 = ≥10% weaker. */
export function costScore(change: number): number {
  return round1(clamp(50 + change * FX_SENSITIVITY, 0, 100));
}

export function normalizeWeights(w: Weights): Weights {
  if (w.weather < 0 || w.cost < 0 || !Number.isFinite(w.weather) || !Number.isFinite(w.cost)) {
    throw new RangeError('weights must be finite and non-negative');
  }
  const sum = w.weather + w.cost;
  if (sum === 0) throw new RangeError('at least one weight must be positive');
  return { weather: w.weather / sum, cost: w.cost / sum };
}

/**
 * Weighted total. Missing components are dropped and the remaining weights renormalised, so a
 * destination with an FX outage is still comparable on weather alone (and vice versa).
 */
export function tripScore(
  parts: { weather: number | null; cost: number | null },
  weights: Weights = DEFAULT_WEIGHTS,
): number | null {
  const w = normalizeWeights(weights);
  let total = 0;
  let used = 0;
  if (parts.weather !== null && w.weather > 0) {
    total += parts.weather * w.weather;
    used += w.weather;
  }
  if (parts.cost !== null && w.cost > 0) {
    total += parts.cost * w.cost;
    used += w.cost;
  }
  return used === 0 ? null : round1(total / used);
}

/** Sort by score desc (nulls last, ties by name) and assign 1-based ranks. */
export function rank<T extends { score: number | null; name: string }>(
  items: readonly T[],
): (T & { rank: number })[] {
  return [...items]
    .sort((a, b) => {
      if (a.score === b.score) return a.name.localeCompare(b.name);
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score;
    })
    .map((item, i) => ({ ...item, rank: i + 1 }));
}

export function describeWeather(days: readonly ForecastDay[]): string {
  if (days.length === 0) return 'no forecast';
  const avgHigh = days.reduce((s, d) => s + d.temperatureMax, 0) / days.length;
  const rainy = days.filter((d) => rainLevel(d) === 'wet').length;
  const feel =
    avgHigh < 5
      ? 'Cold'
      : avgHigh < 15
        ? 'Cool'
        : avgHigh < 24
          ? 'Mild'
          : avgHigh < 30
            ? 'Warm'
            : 'Hot';
  const rain = rainy === 0 ? 'dry' : rainy <= 2 ? 'mostly dry' : 'wet';
  return `${feel} and ${rain} (avg high ${Math.round(avgHigh)}°C, ${rainy} rainy day${rainy === 1 ? '' : 's'})`;
}
