export const typeDefs = /* GraphQL */ `
  "Forecast from Open-Meteo. Temperatures in °C, precipitation in mm, wind in km/h."
  type Weather {
    location: WeatherLocation!
    "IANA timezone of the location."
    timezone: String!
    current: CurrentWeather!
    "Daily forecast, 1-7 days."
    daily(days: Int = 7): [DailyForecast!]! @listSize(slicingArgument: "days", assumedSize: 7)
  }

  type WeatherLocation {
    name: String
    latitude: Float!
    longitude: Float!
  }

  type CurrentWeather {
    "Local time, ISO 8601."
    time: String!
    temperature: Float!
    apparentTemperature: Float
    relativeHumidity: Float
    precipitation: Float
    windSpeed: Float
    "WMO weather interpretation code."
    weatherCode: Int!
    condition: String!
  }

  type DailyForecast {
    date: String!
    temperatureMin: Float!
    temperatureMax: Float!
    precipitationSum: Float
    "Max precipitation probability, %."
    precipitationProbability: Float
    weatherCode: Int!
    condition: String!
  }

  extend type Country {
    "Weather at the geographic centre of the country."
    weather: Weather @cost(weight: 5)
    "Weather in the capital (geocoded); falls back to the centre when there is no capital."
    capitalWeather: Weather @cost(weight: 6)
  }

  extend type Query {
    "Weather at arbitrary coordinates."
    weather(latitude: Float!, longitude: Float!): Weather! @cost(weight: 5)
  }
`;
