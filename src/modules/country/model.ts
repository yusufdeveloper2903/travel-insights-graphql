import { z } from 'zod';

/**
 * Upstream record shape (mledoze/countries, the dataset REST Countries v3 was built on).
 * Only the fields we use are declared; Zod strips the rest (translations etc.).
 */
export const upstreamCountrySchema = z.object({
  cca2: z.string().length(2),
  cca3: z.string().length(3),
  name: z.object({ common: z.string(), official: z.string() }),
  capital: z.array(z.string()),
  region: z.string(),
  subregion: z.string(),
  languages: z.record(z.string(), z.string()),
  currencies: z.record(z.string(), z.object({ name: z.string(), symbol: z.string().optional() })),
  latlng: z.tuple([z.number(), z.number()]),
  borders: z.array(z.string()),
  area: z.number(),
  landlocked: z.boolean(),
  independent: z.boolean().nullable().optional(),
  flag: z.string(),
});

export const upstreamCountriesSchema = z.array(upstreamCountrySchema).min(1);

export type UpstreamCountry = z.infer<typeof upstreamCountrySchema>;

export interface CurrencyModel {
  code: string;
  name: string;
  symbol: string | null;
}

/** Internal domain model; GraphQL resolvers map from this, never from upstream JSON. */
export interface CountryModel {
  code: string;
  code3: string;
  name: string;
  officialName: string;
  flag: string;
  capital: string | null;
  region: string;
  subregion: string | null;
  area: number;
  landlocked: boolean;
  independent: boolean;
  latitude: number;
  longitude: number;
  languages: { code: string; name: string }[];
  currencies: CurrencyModel[];
  borders: string[];
}

export function toCountryModel(c: UpstreamCountry): CountryModel {
  return {
    code: c.cca2.toUpperCase(),
    code3: c.cca3.toUpperCase(),
    name: c.name.common,
    officialName: c.name.official,
    flag: c.flag,
    capital: c.capital[0] ?? null,
    region: c.region,
    subregion: c.subregion === '' ? null : c.subregion,
    area: c.area,
    landlocked: c.landlocked,
    independent: c.independent ?? false,
    latitude: c.latlng[0],
    longitude: c.latlng[1],
    languages: Object.entries(c.languages).map(([code, name]) => ({ code, name })),
    currencies: Object.entries(c.currencies).map(([code, v]) => ({
      code: code.toUpperCase(),
      name: v.name,
      symbol: v.symbol ?? null,
    })),
    borders: c.borders.map((b) => b.toUpperCase()),
  };
}
