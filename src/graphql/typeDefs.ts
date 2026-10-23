export const typeDefs = /* GraphQL */ `
  "Static cost of resolving a field (default: 1 for object fields, 0 for scalars)."
  directive @cost(weight: Int!) on FIELD_DEFINITION

  "List size hint for cost analysis. slicingArgument wins over assumedSize when present."
  directive @listSize(slicingArgument: String, assumedSize: Int) on FIELD_DEFINITION

  type Query {
    "Liveness probe through the GraphQL layer."
    ping: String!
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  type Coordinates {
    latitude: Float!
    longitude: Float!
  }
`;
