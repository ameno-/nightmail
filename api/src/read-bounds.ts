import { ApiError, type Ctx } from './core.js';
import { memoryWaiting, withMemory } from './isolate-memory.js';

/** Default response byte budget per paginated read (always keeping at least one row so cursors progress). */
export const PAGE_MAX_BYTES = 512 * 1024;
/** Default isolate working-memory reservation per bounded read. */
export const READ_RESERVATION_BYTES = 8 * 1024 * 1024;
/** Maximum queued reads waiting on isolate memory before answering retryable 503. */
export const READ_MAX_WAITERS = 32;

const utf8Encoder = new TextEncoder();
export const utf8Bytes = (value: string) => utf8Encoder.encode(value).byteLength;

/**
 * Serializes a cursor page within maxBytes, always returning at least one row so keyset pagination never stalls.
 * Callers should also cap cumulative row bytes in SQL so Postgres never sends unbounded payloads to the isolate.
 */
export function buildBoundedPageJson<T extends { id: string }>(
  items: T[],
  hasMoreFromQuery: boolean,
  maxBytes = PAGE_MAX_BYTES,
): { json: string; nextCursor: string | null; count: number } {
  const parts: string[] = [];
  let bytes = 32; // {"data":[],"nextCursor":null}
  let trimmed = false;
  for (let i = 0; i < items.length; i++) {
    const serialized = JSON.stringify(items[i]!);
    const size = utf8Bytes(serialized) + (i > 0 ? 1 : 0);
    if (i > 0 && bytes + size + 64 > maxBytes) { trimmed = true; break; }
    parts.push(serialized);
    bytes += size;
  }
  const hasMore = hasMoreFromQuery || trimmed;
  const nextCursor = hasMore && parts.length > 0 ? items[parts.length - 1]!.id : null;
  return { json: `{"data":[${parts.join(',')}],"nextCursor":${JSON.stringify(nextCursor)}}`, nextCursor, count: parts.length };
}

export type BoundedReadMemoryOptions = {
  bytes?: number;
  maxWaiters?: number;
  busyCode?: string;
  busyMessage?: string;
};

/** Runs a read handler inside the isolate memory budget; answers retryable 503 when the wait queue saturates. */
export async function withBoundedReadMemory(c: Ctx, work: () => Promise<Response>, opts: BoundedReadMemoryOptions = {}): Promise<Response> {
  const bytes = opts.bytes ?? READ_RESERVATION_BYTES;
  const maxWaiters = opts.maxWaiters ?? READ_MAX_WAITERS;
  if (memoryWaiting() >= maxWaiters) {
    c.header('Retry-After', '2');
    throw new ApiError(503, opts.busyCode ?? 'READ_BUSY', opts.busyMessage ?? 'Reads are temporarily busy. Retry shortly.', undefined, true);
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
