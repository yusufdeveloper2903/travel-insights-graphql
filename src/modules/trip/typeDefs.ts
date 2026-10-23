export const typeDefs = /* GraphQL */ `
  input ScoreWeights {
    weather: Float! = 0.6
    cost: Float! = 0.4
  }

  type TripWeights {
    weather: Float!
    cost: Float!
  }

  type DestinationScore {
    rank: Int!
    country: Country!
    "0-100, higher is better. Null only if neither weather nor FX data was available."
    score: Float
    "0-100: daytime temperature comfort (18-26 °C ideal) discounted by rain, over the 7-day forecast."
    weatherScore: Float
    "0-100: 50 = unchanged purchasing power vs 90 days ago; >50 = home currency got stronger."
    costScore: Float
    weatherLocation: String
    "Average daily high over the forecast window, °C."
    avgTemperatureMax: Float
    rainyDays: Int
    forecastDays: Int!
    "Destination currency used for the cost component."
    currency: String
    "Destination currency units per 1 home currency unit, today."
    exchangeRate: Float
    "Change of exchangeRate vs 90 days ago, in %. Positive = destination got cheaper."
    fxChange90d: Float
    summary: String!
    "Non-fatal data problems (e.g. weather upstream down) that affected this score."
    warnings: [String!]!
  }

  type TripComparison {
    homeCurrency: String!
    comparedAt: String!
    "Normalised weights actually used."
    weights: TripWeights!
    best: DestinationScore
    "Sorted by score, best first."
    destinations: [DestinationScore!]!
  }

  extend type Query {
    "Rank up to 10 destinations by a trip score combining weather comfort and FX-driven cost."
    compareDestinations(
      codes: [String!]!
      homeCurrency: String = "USD"
      weights: ScoreWeights
    ): TripComparison! @cost(weight: 10) @listSize(slicingArgument: "codes", assumedSize: 10)
  }
`;
