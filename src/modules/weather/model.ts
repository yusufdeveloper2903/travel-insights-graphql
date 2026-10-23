import { z } from 'zod';

const nnum = z.number().nullable();

export const forecastSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string(),
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    relative_humidity_2m: nnum.optional(),
    apparent_temperature: nnum.optional(),
    precipitation: nnum.optional(),
    weather_code: z.number().int(),
    wind_speed_10m: nnum.optional(),
  }),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: z.array(nnum),
    temperature_2m_max: z.array(nnum),
    temperature_2m_min: z.array(nnum),
    precipitation_sum: z.array(nnum),
    precipitation_probability_max: z.array(nnum),
  }),
});

/** Open-Meteo returns an object for one location and an array for several. */
export const forecastResponseSchema = z.union([forecastSchema, z.array(forecastSchema)]);

export type UpstreamForecast = z.infer<typeof forecastSchema>;

export const geocodingResponseSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country_code: z.string().optional(),
        feature_code: z.string().optional(),
        population: z.number().optional(),
      }),
    )
    .optional(),
});

export interface GeoPoint {
  latitude: number;
  longitude: number;
  name: string | null;
}

export interface DailyForecastModel {
  date: string;
  temperatureMin: number;
  temperatureMax: number;
  precipitationSum: number | null;
  precipitationProbability: number | null;
  weatherCode: number;
}

export type CurrentWeatherModel = WeatherReport['current'];

export interface WeatherReport {
  location: GeoPoint;
  timezone: string;
  current: {
    time: string;
    temperature: number;
    apparentTemperature: number | null;
    relativeHumidity: number | null;
    precipitation: number | null;
    windSpeed: number | null;
    weatherCode: number;
  };
  daily: DailyForecastModel[];
}

export function toWeatherReport(f: UpstreamForecast, name: string | null): WeatherReport {
  const d = f.daily;
  const daily: DailyForecastModel[] = [];
  d.time.forEach((date, i) => {
    const max = d.temperature_2m_max[i];
    const min = d.temperature_2m_min[i];
    const code = d.weather_code[i];
    // Skip days the model has no data for rather than inventing values.
    if (max == null || min == null || code == null) return;
    daily.push({
      date,
      temperatureMin: min,
      temperatureMax: max,
      precipitationSum: d.precipitation_sum[i] ?? null,
      precipitationProbability: d.precipitation_probability_max[i] ?? null,
      weatherCode: code,
    });
  });
  return {
    location: { latitude: f.latitude, longitude: f.longitude, name },
    timezone: f.timezone,
    current: {
      time: f.current.time,
      temperature: f.current.temperature_2m,
      apparentTemperature: f.current.apparent_temperature ?? null,
      relativeHumidity: f.current.relative_humidity_2m ?? null,
      precipitation: f.current.precipitation ?? null,
      windSpeed: f.current.wind_speed_10m ?? null,
      weatherCode: f.current.weather_code,
    },
    daily,
  };
}

const WMO: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow fall',
  73: 'Moderate snow fall',
  75: 'Heavy snow fall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

/** WMO weather interpretation code -> human readable text. */
export const describeWeatherCode = (code: number): string => WMO[code] ?? 'Unknown';
