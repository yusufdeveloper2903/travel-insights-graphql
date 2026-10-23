import type { Resolvers } from '../../generated/graphql.js';
import { DEFAULT_WEIGHTS } from './scoring.js';
import { compareDestinations } from './service.js';

export const resolvers: Resolvers = {
  Query: {
    compareDestinations: (_root, { codes, homeCurrency, weights }, ctx) =>
      compareDestinations(
        {
          codes,
          homeCurrency,
          weights: weights
            ? {
                weather: weights.weather ?? DEFAULT_WEIGHTS.weather,
                cost: weights.cost ?? DEFAULT_WEIGHTS.cost,
              }
            : null,
        },
        ctx,
      ),
  },
};
