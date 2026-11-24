import { ApiError, type Ctx } from './core.js';

/** Default response byte budget per paginated read (always keeping at least one row so cursors progress). */
export const PAGE_MAX_BYTES = 512 * 1024;
/** Global concurrent bounded reads per isolate (isolated from attachment/import memory pool). */
export const READ_MAX_ACTIVE = 8;
/** Maximum concurrent bounded reads admitted at once for a single workspace. */
export const READ_MAX_ACTIVE_PER_WORKSPACE = 2;
/** Maximum queued bounded reads per workspace before answering retryable 429 for that workspace only. */
export const READ_MAX_WAITING_PER_WORKSPACE = 4;
/** Maximum total queued bounded reads across all workspaces before answering retryable 503. */
export const READ_MAX_WAITERS = 32;
/** Backwards-compatible alias for the estimated working memory of one 512 KiB bounded read. */
export const READ_RESERVATION_BYTES = 2 * 1024 * 1024;

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

type Waiter = { workspaceId: string; maxPerWorkspace: number; start: () => void };
class FairPool {
  active = 0;
  readonly activeByWs = new Map<string, number>();
  readonly waitingByWs = new Map<string, number>();
  readonly queue: Waiter[] = [];
  constructor(readonly maxActive: number, readonly defaultMaxPerWs: number, readonly defaultMaxWaitingPerWs: number, readonly maxWaitingTotal: number) {}
  private inc(map: Map<string, number>, key: string, delta: number) {
    const next = (map.get(key) ?? 0) + delta;
    if (next <= 0) map.delete(key); else map.set(key, next);
  }
  private admit() {
    while (this.active < this.maxActive && this.queue.length > 0) {
      const idx = this.queue.findIndex(w => (this.activeByWs.get(w.workspaceId) ?? 0) < w.maxPerWorkspace);
      if (idx < 0) break;
      const next = this.queue.splice(idx, 1)[0]!;
      this.inc(this.waitingByWs, next.workspaceId, -1);
      this.active++;
      this.inc(this.activeByWs, next.workspaceId, 1);
      next.start();
    }
  }
  async acquire(
    workspaceId: string,
    signal: AbortSignal | undefined,
    opts: { maxPerWs?: number; maxWaitingPerWs?: number; busyCode: string; busyMessage: string; wsBusyCode: string; wsBusyMessage: string; retryAfter?: string },
  ): Promise<() => void> {
    const maxPerWs = opts.maxPerWs ?? this.defaultMaxPerWs;
    const maxWaitingPerWs = opts.maxWaitingPerWs ?? this.defaultMaxWaitingPerWs;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const wsActive = this.activeByWs.get(workspaceId) ?? 0;
    if (this.active < this.maxActive && wsActive < maxPerWs) {
      this.active++;
      this.inc(this.activeByWs, workspaceId, 1);
      return this.releaser(workspaceId);
    }
    if ((this.waitingByWs.get(workspaceId) ?? 0) >= maxWaitingPerWs) {
      throw new ApiError(429, opts.wsBusyCode, opts.wsBusyMessage, undefined, true);
    }
    if (this.queue.length >= this.maxWaitingTotal) {
      throw new ApiError(503, opts.busyCode, opts.busyMessage, undefined, true);
    }
    this.inc(this.waitingByWs, workspaceId, 1);
    await new Promise<void>((resolve, reject) => {
      const entry: Waiter = {
        workspaceId,
        maxPerWorkspace: maxPerWs,
        start: () => { signal?.removeEventListener('abort', onAbort); resolve(); },
      };
      const onAbort = () => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          this.inc(this.waitingByWs, workspaceId, -1);
          this.admit();
        }
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
    return this.releaser(workspaceId);
  }
  private releaser(workspaceId: string) {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      this.inc(this.activeByWs, workspaceId, -1);
      this.admit();
    };
  }
}

const readPool = new FairPool(READ_MAX_ACTIVE, READ_MAX_ACTIVE_PER_WORKSPACE, READ_MAX_WAITING_PER_WORKSPACE, READ_MAX_WAITERS);
// Separate per-workspace fairness gate for large contact-import operations (max 2 active + 2 waiting per workspace; max 4 global active).
const importPool = new FairPool(4, 2, 2, 16);

export const boundedReadsActive = () => readPool.active;
export const boundedReadsWaiting = () => readPool.queue.length;

export type BoundedReadMemoryOptions = {
  maxActivePerWorkspace?: number;
  maxWaitingPerWorkspace?: number;
  busyCode?: string;
  busyMessage?: string;
  workspaceBusyCode?: string;
  workspaceBusyMessage?: string;
};

/** Runs a bounded read inside the fair per-workspace read pool (isolated from attachment/import memory). */
export async function withBoundedReadMemory(c: Ctx, work: () => Promise<Response>, opts: BoundedReadMemoryOptions = {}): Promise<Response> {
  const workspaceId = c.get('actor')?.workspaceId ?? 'anonymous';
  let release: (() => void) | undefined;
  try {
    release = await readPool.acquire(workspaceId, c.req.raw.signal, {
      maxPerWs: opts.maxActivePerWorkspace,
      maxWaitingPerWs: opts.maxWaitingPerWorkspace,
      busyCode: opts.busyCode ?? 'READ_BUSY',
      busyMessage: opts.busyMessage ?? 'Reads are temporarily busy. Retry shortly.',
      wsBusyCode: opts.workspaceBusyCode ?? 'READ_CONCURRENCY_LIMIT',
      wsBusyMessage: opts.workspaceBusyMessage ?? 'Too many concurrent reads in this workspace. Retry shortly.',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return new Response(null, { status: 499 });
    if (err instanceof ApiError && (err.status === 429 || err.status === 503)) c.header('Retry-After', err.status === 429 ? '1' : '2');
    throw err;
  }
  try {
    if (c.req.raw.signal?.aborted) return new Response(null, { status: 499 });
    return await work();
  } finally {
    release();
  }
}

/** Acquires a per-workspace fairness slot for large import requests; caller must invoke the returned releaser when finished. */
export async function acquireImportSlot(c: Ctx, maxPerWorkspace = 2): Promise<() => void> {
  const workspaceId = c.get('actor')?.workspaceId ?? 'anonymous';
  try {
    return await importPool.acquire(workspaceId, c.req.raw.signal, {
      maxPerWs: maxPerWorkspace,
      maxWaitingPerWs: 2,
      busyCode: 'IMPORT_BUSY',
      busyMessage: 'Imports are temporarily busy. Retry shortly.',
      wsBusyCode: 'IMPORT_CONCURRENCY_LIMIT',
      wsBusyMessage: 'Too many concurrent import requests in this workspace. Retry shortly.',
    });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 429 || err.status === 503)) c.header('Retry-After', '2');
    throw err;
  }
}
