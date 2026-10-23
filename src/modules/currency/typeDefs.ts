export const typeDefs = /* GraphQL */ `
  type Currency {
    "ISO 4217 code."
    code: String!
    name: String!
    symbol: String
    "Units of this currency per 1 unit of base. Null if the pair is not covered."
    rate(base: String = "USD"): Float @cost(weight: 2)
  }

  type Conversion {
    amount: Float!
    from: String!
    to: String!
    rate: Float!
    result: Float!
    "Publication date of the rate."
    date: String!
  }

  extend type Country {
    currencies: [Currency!]!
  }

  extend type Query {
    convert(amount: Float!, from: String!, to: String!): Conversion! @cost(weight: 2)
  }
`;
