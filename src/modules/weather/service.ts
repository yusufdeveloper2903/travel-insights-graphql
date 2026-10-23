import type { CountryModel } from '../country/model.js';
import type { Loaders } from '../../context.js';
import type { GeoPoint, WeatherReport } from './model.js';

/** Where we take a country's "capital weather": geocoded capital, else the country centroid. */
export async function capitalLocation(country: CountryModel, loaders: Loaders): Promise<GeoPoint> {
  if (country.capital) {
    const found = await loaders.city.load({ name: country.capital, countryCode: country.code });
    if (found) return { ...found, name: country.capital };
  }
  return { latitude: country.latitude, longitude: country.longitude, name: country.name };
}

export async function capitalWeather(
  country: CountryModel,
  loaders: Loaders,
): Promise<WeatherReport> {
  return loaders.forecast.load(await capitalLocation(country, loaders));
}
