import { z } from 'zod';

/** Frankfurter v2 `/rates` returns one row per quote currency. */
export const ratesResponseSchema = z.array(
  z.object({
    date: z.string(),
    base: z.string(),
    quote: z.string(),
    rate: z.number().positive(),
  }),
);

export interface RateTable {
  base: string;
  /** Most recent publication date among the quotes. */
  date: string;
  /** Units of quote currency per 1 unit of base. */
  rates: Record<string, number>;
}

export const CURRENCY_RE = /^[A-Z]{3}$/;

export function normalizeCurrency(code: string): string | null {
  const c = code.trim().toUpperCase();
  return CURRENCY_RE.test(c) ? c : null;
}
