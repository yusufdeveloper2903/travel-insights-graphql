import type { GraphQLContext } from '../../context.js';
import { BadUserInputError, NotFoundError } from '../../shared/errors.js';
import type { CountryModel } from '../country/model.js';
import type { RateTable } from '../currency/model.js';
import { normalizeCurrency } from '../currency/model.js';
import type { WeatherReport } from '../weather/model.js';
import { capitalWeather } from '../weather/service.js';
import {
  costScore,
  DEFAULT_WEIGHTS,
  describeWeather,
  fxChange,
  normalizeWeights,
  rainLevel,
  rank,
  tripScore,
  weatherScore,
  type Weights,
} from './scoring.js';

export const MAX_DESTINATIONS = 10;
export const FX_LOOKBACK_DAYS = 90;

export interface DestinationScoreModel {
  rank: number;
  country: CountryModel;
  score: number | null;
  weatherScore: number | null;
  costScore: number | null;
  weatherLocation: string | null;
  avgTemperatureMax: number | null;
  rainyDays: number | null;
  forecastDays: number;
  currency: string | null;
  exchangeRate: number | null;
  fxChange90d: number | null;
  summary: string;
  warnings: string[];
}

export interface TripComparisonModel {
  homeCurrency: string;
  comparedAt: string;
  weights: Weights;
  best: DestinationScoreModel | null;
  destinations: DestinationScoreModel[];
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const round = (n: number, d: number) => Number(n.toFixed(d));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function compareDestinations(
  input: { codes: readonly string[]; homeCurrency?: string | null; weights?: Weights | null },
  ctx: GraphQLContext,
): Promise<TripComparisonModel> {
  const codes = [...new Set(input.codes.map((c) => c.trim().toUpperCase()))];
  if (codes.length === 0 || codes.length > MAX_DESTINATIONS) {
    throw new BadUserInputError(`Provide between 1 and ${MAX_DESTINATIONS} country codes`, {
      argumentName: 'codes',
    });
  }
  const home = normalizeCurrency(input.homeCurrency ?? 'USD');
  if (!home)
    throw new BadUserInputError('homeCurrency must be an ISO 4217 code', {
      argumentName: 'homeCurrency',
    });

  let weights: Weights;
  try {
    weights = normalizeWeights(input.weights ?? DEFAULT_WEIGHTS);
  } catch (e) {
    throw new BadUserInputError(errMsg(e), { argumentName: 'weights' });
  }

  const { loaders, clock } = ctx;
  const found = await loaders.countryByCode.loadMany(codes);
  const missing = codes.filter((_, i) => !found[i] || found[i] instanceof Error);
  if (missing.length > 0) {
    throw new NotFoundError(`Unknown country code(s): ${missing.join(', ')}`, { codes: missing });
  }
  const countries = found as CountryModel[];

  const now = clock.now();
  // Two FX requests in total, regardless of how many destinations are compared.
  const [latest, past] = await Promise.allSettled([
    loaders.rates.load({ base: home }),
    loaders.rates.load({ base: home, date: isoDate(now - FX_LOOKBACK_DAYS * 86_400_000) }),
  ]);
  if (latest.status === 'rejected' && latest.reason instanceof BadUserInputError)
    throw latest.reason;

  // All capital forecasts go through the forecast DataLoader -> one batched Open-Meteo call.
  const weather = await Promise.allSettled(countries.map((c) => capitalWeather(c, loaders)));

  const scored = countries.map((country, i) => {
    const warnings: string[] = [];
    const w: PromiseSettledResult<WeatherReport> = weather[i] ?? {
      status: 'rejected',
      reason: new Error('missing forecast'),
    };
    const days = w.status === 'fulfilled' ? w.value.daily : [];
    if (w.status === 'rejected') warnings.push(`Weather unavailable: ${errMsg(w.reason)}`);

    const ws = weatherScore(days);
    const { currency, rateNow, change } = fxFor(country, home, latest, past, warnings);
    const cs = change === null ? null : costScore(change);
    const score = tripScore({ weather: ws, cost: cs }, weights);

    const fxText =
      change === null
        ? 'FX trend unavailable'
        : currency === home
          ? `uses ${home}`
          : `${home} ${change >= 0 ? 'up' : 'down'} ${Math.abs(change * 100).toFixed(1)}% vs ${currency} over ${FX_LOOKBACK_DAYS}d`;

    return {
      name: country.name,
      country,
      score,
      weatherScore: ws,
      costScore: cs,
      weatherLocation: w.status === 'fulfilled' ? w.value.location.name : null,
      avgTemperatureMax: days.length
        ? round(days.reduce((s, d) => s + d.temperatureMax, 0) / days.length, 1)
        : null,
      rainyDays: days.length ? days.filter((d) => rainLevel(d) === 'wet').length : null,
      forecastDays: days.length,
      currency,
      exchangeRate: rateNow,
      fxChange90d: change === null ? null : round(change * 100, 2),
      summary: `${describeWeather(days)}; ${fxText}`,
      warnings,
    };
  });

  const destinations = rank(scored).map(({ name: _name, ...rest }) => rest);
  return {
    homeCurrency: home,
    comparedAt: new Date(now).toISOString(),
    weights,
    best: destinations.find((d) => d.score !== null) ?? null,
    destinations,
  };
}

function fxFor(
  country: CountryModel,
  home: string,
  latest: PromiseSettledResult<RateTable>,
  past: PromiseSettledResult<RateTable>,
  warnings: string[],
): { currency: string | null; rateNow: number | null; change: number | null } {
  const currencies = country.currencies.map((c) => c.code);
  const [primary] = currencies;
  if (primary === undefined) {
    warnings.push('Country has no currency');
    return { currency: null, rateNow: null, change: null };
  }
  if (currencies.includes(home)) return { currency: home, rateNow: 1, change: 0 };
  if (latest.status === 'rejected') {
    warnings.push(`FX unavailable: ${errMsg(latest.reason)}`);
    return { currency: primary, rateNow: null, change: null };
  }
  // First of the country's currencies that the FX source actually quotes.
  const quoted = currencies
    .map((code) => ({ code, rate: latest.value.rates[code] }))
    .find((q): q is { code: string; rate: number } => q.rate !== undefined);
  if (!quoted) {
    warnings.push(`No ${home} rate for ${currencies.join('/')}`);
    return { currency: primary, rateNow: null, change: null };
  }
  const { code: currency, rate: rateNow } = quoted;
  const rateThen = past.status === 'fulfilled' ? past.value.rates[currency] : undefined;
  if (rateThen === undefined) {
    warnings.push('Historical FX rate unavailable');
    return { currency, rateNow, change: null };
  }
  return { currency, rateNow, change: fxChange(rateNow, rateThen) };
}
