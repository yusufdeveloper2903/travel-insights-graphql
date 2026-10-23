import type { Resolvers } from '../../generated/graphql.js';
import { BadUserInputError, NotFoundError } from '../../shared/errors.js';
import type { CountryModel } from './model.js';
import { filterCountries, paginate } from './pagination.js';

const CODE_RE = /^[A-Za-z]{2,3}$/;

export const resolvers: Resolvers = {
  Query: {
    country: async (_root, { code }, { loaders }) => {
      if (!CODE_RE.test(code)) {
        throw new BadUserInputError('Country code must be ISO 3166-1 alpha-2 or alpha-3', {
          argumentName: 'code',
        });
      }
      const country = await loaders.countryByCode.load(code);
      if (!country) throw new NotFoundError(`Country "${code.toUpperCase()}" not found`);
      return country;
    },
    countries: async (_root, { filter, first, after }, { dataSources }) => {
      const { all } = await dataSources.countries.getIndex();
      return paginate(filterCountries(all, filter), first, after);
    },
  },
  CountryConnection: {
    nodes: (conn) => conn.edges.map((e) => e.node),
  },
  Country: {
    coordinates: (c) => ({ latitude: c.latitude, longitude: c.longitude }),
    borders: async (c, _args, { loaders }) => {
      const found = await loaders.countryByCode.loadMany(c.borders);
      return found.filter((x): x is CountryModel => x !== null && !(x instanceof Error));
    },
  },
};
