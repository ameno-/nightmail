import { z } from '@hono/zod-openapi';
import { usd } from './rates.js';

// Billing money is integer micro-cents (µ¢): 1¢ = 1,000,000 µ¢, $1 = 100,000,000 µ¢. A bigint brand, never a JS
// number except through Number() for display. API JSON carries it as an integer string; API inputs are whole cents;
// Stripe amounts are cents.
export type MicroCents = bigint & { readonly __brand: 'MicroCents' };
export const UC_PER_CENT = 1_000_000n, UC_PER_USD = 100_000_000n;
export { RATES } from './rates.js';

/** Parses an integer µ¢ value (bigint or integer string). Throws on anything else. */
export const microCents = (v: bigint | string): MicroCents => {
  if (typeof v === 'bigint') return v as MicroCents;
  if (!/^-?\d{1,19}$/.test(v)) throw new RangeError(`Not an integer micro-cent amount: ${JSON.stringify(v)}`);
  return BigInt(v) as MicroCents;
};
export const fromCents = (cents: number): MicroCents => {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Not a whole number of cents: ${cents}`);
  return (BigInt(cents) * UC_PER_CENT) as MicroCents;
};
/** Whole cents, rounded towards negative infinity. */
export const toCentsFloor = (v: MicroCents): number => {
  const q = v / UC_PER_CENT, r = v % UC_PER_CENT;
  return Number(r < 0n ? q - 1n : q);
};
/** "$12.34", "−$0.50"; four decimals when 0 < |v| < 1¢ ("$0.0002"). The public price pages format with the same function. */
export const formatUsd = (v: MicroCents): string => usd(v);
export const MicroCentsJson = z.string().regex(/^-?\d{1,19}$/).openapi('MicroCents', { description: 'Integer micro-cents (1¢ = 1,000,000) as a string.', example: '2500000000' });
