import { BadUserInputError } from '../../shared/errors.js';
import type { CountryModel } from './model.js';

export interface CountryFilterInput {
  region?: string | null;
  subregion?: string | null;
  nameContains?: string | null;
}

export interface Connection<T> {
  edges: { cursor: string; node: T }[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
  totalCount: number;
}

export const MAX_PAGE_SIZE = 50;
const CURSOR_PREFIX = 'country:';

/** Opaque keyset cursor: stable even if the dataset is refreshed between page requests. */
export const encodeCursor = (code: string) =>
  Buffer.from(CURSOR_PREFIX + code, 'utf8').toString('base64url');

export function decodeCursor(cursor: string): string {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!raw.startsWith(CURSOR_PREFIX) || raw.length <= CURSOR_PREFIX.length) {
    throw new BadUserInputError('Invalid cursor', { argumentName: 'after' });
  }
  return raw.slice(CURSOR_PREFIX.length);
}

const norm = (s: string) => s.trim().toLocaleLowerCase('en');

export function filterCountries(
  all: readonly CountryModel[],
  filter: CountryFilterInput | null | undefined,
): CountryModel[] {
  const region = filter?.region ? norm(filter.region) : null;
  const subregion = filter?.subregion ? norm(filter.subregion) : null;
  const needle = filter?.nameContains ? norm(filter.nameContains) : null;
  return all.filter(
    (c) =>
      (!region || norm(c.region) === region) &&
      (!subregion || (c.subregion !== null && norm(c.subregion) === subregion)) &&
      (!needle || norm(c.name).includes(needle) || norm(c.officialName).includes(needle)),
  );
}

export function paginate(
  items: readonly CountryModel[],
  first: number | null | undefined,
  after: string | null | undefined,
): Connection<CountryModel> {
  const size = first ?? 10;
  if (!Number.isInteger(size) || size < 0 || size > MAX_PAGE_SIZE) {
    throw new BadUserInputError(`"first" must be between 0 and ${MAX_PAGE_SIZE}`, {
      argumentName: 'first',
    });
  }

  let start = 0;
  if (after) {
    const code = decodeCursor(after);
    const idx = items.findIndex((c) => c.code === code);
    if (idx === -1) throw new BadUserInputError('Cursor does not belong to this result set');
    start = idx + 1;
  }

  const slice = items.slice(start, start + size);
  const edges = slice.map((node) => ({ cursor: encodeCursor(node.code), node }));
  return {
    edges,
    pageInfo: {
      hasNextPage: start + size < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
    totalCount: items.length,
  };
}
