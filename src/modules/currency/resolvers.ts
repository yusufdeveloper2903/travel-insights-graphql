import type { Resolvers } from '../../generated/graphql.js';
import { BadUserInputError } from '../../shared/errors.js';
import { normalizeCurrency } from './model.js';

function requireCurrency(code: string, argumentName: string): string {
  const c = normalizeCurrency(code);
  if (!c) throw new BadUserInputError(`"${code}" is not an ISO 4217 code`, { argumentName });
  return c;
}

const round = (n: number, digits = 6) => Number(n.toFixed(digits));

export const resolvers: Resolvers = {
  Query: {
    convert: async (_root, args, { loaders }) => {
      const from = requireCurrency(args.from, 'from');
      const to = requireCurrency(args.to, 'to');
      if (!Number.isFinite(args.amount) || args.amount < 0) {
        throw new BadUserInputError('"amount" must be a non-negative number', {
          argumentName: 'amount',
        });
      }
      const table = await loaders.rates.load({ base: from });
      const rate = table.rates[to];
      if (rate === undefined) throw new BadUserInputError(`Unsupported currency "${to}"`);
      return {
        amount: args.amount,
        from,
        to,
        rate,
        result: round(args.amount * rate, 4),
        date: table.date,
      };
    },
  },
  Country: {
    currencies: (c) => c.currencies,
  },
  Currency: {
    rate: async (cur, { base }, { loaders }) => {
      const b = requireCurrency(base, 'base');
      if (b === cur.code) return 1;
      const table = await loaders.rates.load({ base: b });
      return table.rates[cur.code] ?? null;
    },
  },
};
