import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { ApiError, type Ctx } from './core.js';
import { memoryWaiting, withMemory } from './isolate-memory.js';

export const INBOUND_ADDRESS_STORE_LIMIT = 100;
export const INBOUND_ADDRESS_PAGE_LIMIT = 20;
export const INBOUND_ADDRESS_NAME_LIMIT = 256;
export const INBOUND_ADDRESS_ADDR_LIMIT = 320;
export const INBOUND_PAGE_MAX_BYTES = 512 * 1024;
export const INBOUND_READ_RESERVATION_BYTES = 4 * 1024 * 1024;
export const INBOUND_DETAIL_RESERVATION_BYTES = 8 * 1024 * 1024;
export const ROUTING_READ_RESERVATION_BYTES = 8 * 1024 * 1024;
export const READ_MAX_WAITERS = 32;

const utf8Encoder = new TextEncoder();
export const utf8Bytes = (value: string) => utf8Encoder.encode(value).byteLength;

/**
 * Slices a jsonb array column in SQL to at most `limit` elements.
 * Uses an O(1) jsonb_array_length fast path so ordinary small rows never unnest.
 */
export const sliceJsonbArray = (column: SQLWrapper, limit: number): SQL => sql`CASE
  WHEN jsonb_array_length(${column}) <= ${limit} THEN ${column}
  ELSE coalesce((SELECT jsonb_agg(e ORDER BY ord) FROM (SELECT e, ord FROM jsonb_array_elements(${column}) WITH ORDINALITY t(e, ord) LIMIT ${limit}) s), '[]'::jsonb)
END`;

/** Extracts up to `limit` plain address strings from a jsonb MailAddress[] column in SQL. */
export const sliceAddressStrings = (column: SQLWrapper, limit: number): SQL => sql`coalesce(
  (SELECT jsonb_agg(e->>'address' ORDER BY ord) FROM (SELECT e, ord FROM jsonb_array_elements(${column}) WITH ORDINALITY t(e, ord) LIMIT ${limit}) s),
  '[]'::jsonb
)`;

export type AddressCountKey = 'toCount' | 'ccCount' | 'replyToCount' | 'referencesCount';

/** Exact pre-cap count for a message address/references field, covering both newly capped and older rows. */
export const messageFieldCount = (column: SQLWrapper, verdicts: SQLWrapper, key: AddressCountKey): SQL<number> =>
  sql<number>`greatest(jsonb_array_length(${column}), coalesce((${verdicts}->>${sql.raw(`'${key}'`)})::int, 0))::int`;

/**
 * Keeps the longest prefix of `items` whose JSON serialization fits inside `maxBytes`
 * (always keeping at least one item when non-empty so cursor pagination always progresses).
 */
export function fitPageByBytes<T>(items: T[], hasMoreFromQuery: boolean, maxBytes = INBOUND_PAGE_MAX_BYTES, overhead = 256): { items: T[]; hasMore: boolean } {
  if (!items.length) return { items: [], hasMore: hasMoreFromQuery };
  let bytes = overhead;
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    const size = utf8Bytes(JSON.stringify(items[i]!)) + (i > 0 ? 1 : 0);
    if (i > 0 && bytes + size > maxBytes) return { items: items.slice(0, count), hasMore: true };
    bytes += size;
    count++;
  }
  return { items, hasMore: hasMoreFromQuery };
}

/** Runs a read inside the isolate memory budget; answers retryable 503 when too many reads are queued. */
export async function withReadMemory(c: Ctx, bytes: number, work: () => Promise<Response>): Promise<Response> {
  if (memoryWaiting() >= READ_MAX_WAITERS) {
    c.header('Retry-After', '2');
    throw new ApiError(503, 'READ_BUSY', 'Reads are temporarily busy. Retry shortly.', undefined, true);
  }
  try {
    return await withMemory(bytes, async () => {
      if (c.req.raw.signal?.aborted) return new Response(null, { status: 499 });
      return work();
    }, c.req.raw.signal);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return new Response(null, { status: 499 });
    throw err;
  }
}

/** Runs an internal read step inside the isolate memory budget (e.g. one poll tick, without holding across sleep). */
export async function withReadLease<T>(c: Ctx, bytes: number, work: () => Promise<T>): Promise<T> {
  if (memoryWaiting() >= READ_MAX_WAITERS) {
    c.header('Retry-After', '2');
    throw new ApiError(503, 'READ_BUSY', 'Reads are temporarily busy. Retry shortly.', undefined, true);
  }
  return withMemory(bytes, work, c.req.raw.signal);
}
