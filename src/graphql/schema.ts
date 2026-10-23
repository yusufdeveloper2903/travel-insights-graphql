import { createSchema } from 'graphql-yoga';
import type { GraphQLContext } from '../context.js';
import type { Resolvers } from '../generated/graphql.js';
import * as country from '../modules/country/index.js';
import * as currency from '../modules/currency/index.js';
import * as trip from '../modules/trip/index.js';
import * as weather from '../modules/weather/index.js';
import { typeDefs as baseTypeDefs } from './typeDefs.js';

const modules = [country, weather, currency, trip];

const baseResolvers: Resolvers = {
  Query: { ping: () => 'pong' },
};

export function buildSchema() {
  return createSchema<GraphQLContext>({
    typeDefs: [baseTypeDefs, ...modules.map((m) => m.typeDefs)],
    resolvers: [baseResolvers, ...modules.map((m) => m.resolvers)],
  });
}
