import { describe, expect, it } from 'vitest';
import {
  costScore,
  dayComfort,
  describeWeather,
  fxChange,
  normalizeWeights,
  rainLevel,
  rank,
  temperatureComfort,
  tripScore,
  weatherScore,
  type ForecastDay,
} from '../../src/modules/trip/scoring.js';

const day = (max: number, min: number, mm = 0, prob = 0): ForecastDay => ({
  temperatureMax: max,
  temperatureMin: min,
  precipitationSum: mm,
  precipitationProbability: prob,
});

describe('temperatureComfort', () => {
  it('is 1 inside the 18-26 °C band', () => {
    expect(temperatureComfort(18)).toBe(1);
    expect(temperatureComfort(22)).toBe(1);
    expect(temperatureComfort(26)).toBe(1);
  });
  it('falls off linearly and clamps at 0', () => {
    expect(temperatureComfort(13)).toBeCloseTo(0.5);
    expect(temperatureComfort(31)).toBeCloseTo(0.5);
    expect(temperatureComfort(-20)).toBe(0);
    expect(temperatureComfort(50)).toBe(0);
  });
});

describe('rainLevel', () => {
  it('classifies by probability or amount, treating nulls as dry', () => {
    expect(rainLevel(day(20, 10, 0, 0))).toBe('dry');
    expect(rainLevel(day(20, 10, 0.6, 0))).toBe('showers');
    expect(rainLevel(day(20, 10, 0, 30))).toBe('showers');
    expect(rainLevel(day(20, 10, 2, 0))).toBe('wet');
    expect(rainLevel(day(20, 10, 0, 80))).toBe('wet');
    expect(rainLevel({ precipitationSum: null, precipitationProbability: null })).toBe('dry');
  });
});

describe('weatherScore', () => {
  it('returns null without forecast data', () => {
    expect(weatherScore([])).toBeNull();
  });
  it('scores a perfect dry week at 100', () => {
    expect(weatherScore(Array.from({ length: 7 }, () => day(25, 15)))).toBe(100);
  });
  it('halves a perfect day when it is wet', () => {
    expect(dayComfort(day(25, 15, 5, 90))).toBe(0.5);
  });
  it('prefers mild over freezing', () => {
    expect(weatherScore([day(24, 14)])!).toBeGreaterThan(weatherScore([day(2, -5)])!);
  });
});

describe('FX cost', () => {
  it('computes relative change of destination units per home unit', () => {
    expect(fxChange(110, 100)).toBeCloseTo(0.1);
    expect(fxChange(95, 100)).toBeCloseTo(-0.05);
  });
  it('rejects non-positive rates', () => {
    expect(() => fxChange(0, 100)).toThrow(RangeError);
  });
  it('maps change to 0..100 around a neutral 50', () => {
    expect(costScore(0)).toBe(50);
    expect(costScore(0.05)).toBe(75);
    expect(costScore(-0.05)).toBe(25);
    expect(costScore(0.5)).toBe(100);
    expect(costScore(-0.5)).toBe(0);
  });
});

describe('tripScore', () => {
  it('applies normalised weights', () => {
    expect(tripScore({ weather: 80, cost: 50 }, { weather: 3, cost: 2 })).toBe(68);
  });
  it('renormalises when a component is missing', () => {
    expect(tripScore({ weather: 80, cost: null })).toBe(80);
    expect(tripScore({ weather: null, cost: 40 })).toBe(40);
    expect(tripScore({ weather: null, cost: null })).toBeNull();
  });
  it('ignores a component with zero weight', () => {
    expect(tripScore({ weather: 90, cost: 10 }, { weather: 1, cost: 0 })).toBe(90);
  });
  it('validates weights', () => {
    expect(() => normalizeWeights({ weather: 0, cost: 0 })).toThrow(RangeError);
    expect(() => normalizeWeights({ weather: -1, cost: 1 })).toThrow(RangeError);
  });
});

describe('rank', () => {
  it('sorts by score desc, nulls last, ties by name', () => {
    const ranked = rank([
      { name: 'C', score: null },
      { name: 'B', score: 70 },
      { name: 'A', score: 70 },
      { name: 'D', score: 90 },
    ]);
    expect(ranked.map((r) => `${r.rank}${r.name}`)).toEqual(['1D', '2A', '3B', '4C']);
  });
});

describe('describeWeather', () => {
  it('summarises temperature and rain', () => {
    expect(describeWeather([day(22, 12), day(22, 12, 5, 90)])).toBe(
      'Mild and mostly dry (avg high 22°C, 1 rainy day)',
    );
    expect(describeWeather([])).toBe('no forecast');
  });
});
