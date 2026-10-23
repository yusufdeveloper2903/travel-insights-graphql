export const typeDefs = /* GraphQL */ `
  "A country with static reference data. Weather and currency fields are resolved lazily."
  type Country {
    "ISO 3166-1 alpha-2 code, e.g. UZ."
    code: ID!
    "ISO 3166-1 alpha-3 code, e.g. UZB."
    code3: String!
    name: String!
    officialName: String!
    "Flag emoji."
    flag: String!
    capital: String
    region: String!
    subregion: String
    "Area in km²."
    area: Float!
    landlocked: Boolean!
    independent: Boolean!
    "Geographic centre of the country."
    coordinates: Coordinates!
    languages: [Language!]!
    "Neighbouring countries."
    borders: [Country!]! @cost(weight: 2) @listSize(assumedSize: 5)
  }

  type Language {
    code: String!
    name: String!
  }

  input CountryFilter {
    "Exact match, case-insensitive (Africa, Americas, Antarctic, Asia, Europe, Oceania)."
    region: String
    "Exact match, case-insensitive, e.g. Central Asia."
    subregion: String
    "Substring match on common or official name."
    nameContains: String
  }

  type CountryEdge {
    cursor: String!
    node: Country!
  }

  type CountryConnection {
    edges: [CountryEdge!]!
    "Shortcut for edges { node }."
    nodes: [Country!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  extend type Query {
    "Look up a country by ISO alpha-2 or alpha-3 code."
    country(code: String!): Country
    "Relay-style cursor pagination over countries sorted by name. first: max 50."
    countries(filter: CountryFilter, first: Int = 10, after: String): CountryConnection!
      @listSize(slicingArgument: "first", assumedSize: 50)
  }
`;
