import type { Resolvers } from '../../generated/graphql.js';
import { BadUserInputError } from '../../shared/errors.js';
import { FORECAST_DAYS } from './datasource.js';
import { describeWeatherCode } from './model.js';
import { capitalWeather } from './service.js';

export const resolvers: Resolvers = {
  Query: {
    weather: (_root, { latitude, longitude }, { loaders }) => {
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        throw new BadUserInputError('latitude must be within ±90 and longitude within ±180');
      }
      return loaders.forecast.load({ latitude, longitude, name: null });
    },
  },
  Country: {
    weather: (c, _args, { loaders }) =>
      loaders.forecast.load({ latitude: c.latitude, longitude: c.longitude, name: c.name }),
    capitalWeather: (c, _args, { loaders }) => capitalWeather(c, loaders),
  },
  Weather: {
    daily: (w, { days }) => {
      const n = days;
      if (!Number.isInteger(n) || n < 1 || n > FORECAST_DAYS) {
        throw new BadUserInputError(`"days" must be between 1 and ${FORECAST_DAYS}`, {
          argumentName: 'days',
        });
      }
      return w.daily.slice(0, n);
    },
  },
  CurrentWeather: {
    condition: (c) => describeWeatherCode(c.weatherCode),
  },
  DailyForecast: {
    condition: (d) => describeWeatherCode(d.weatherCode),
  },
};
