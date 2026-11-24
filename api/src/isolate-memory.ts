import { AsyncLocalStorage } from 'node:async_hooks';
import { log } from './core.js';
import { SEND_LIMITS } from './send-limits.js';

// One byte budget for every path that holds a large attachment in memory: raw uploads, attachment downloads, the
// dispatcher's pages with attachments or large bodies (every lane counts), and inbox mail's attachment copies and Sent
// archive. A Worker isolate has 128 MB for all its requests at once and the loaded app holds about 25 MB, so these paths
// together may hold at most SEND_LIMITS.isolateWorkingBytes. Each path reserves its expected peak (the file and every
// buffer it builds from it) before it reads anything, waits in arrival order while the budget is spent, and gives it
// back only once those buffers are unreachable. A reservation larger than the budget waits for the whole budget and then
// runs alone.
const budget = SEND_LIMITS.isolateWorkingBytes;
let used = 0;
const waiting: { bytes: number; start: () => void }[] = [];
// The reservation a path holds. Work inside it (a Sent archive that copies its files first, a mailbox copy that
// finishes a pending archive) is covered up to that size without waiting on its own holder; past it, the extra is
// added at once (it never waits, so a holder cannot deadlock on itself) and logged, because the outer estimate was short.
const holding = new AsyncLocalStorage<{ bytes: number }>();

function admit() {
  while (waiting.length && used + waiting[0]!.bytes <= budget) { const next = waiting.shift()!; used += next.bytes; next.start(); }
}
export type MemoryLease = { release(): void };
const lease = (n: number): MemoryLease => { let held = true; return { release() { if (held) { held = false; used -= n; admit(); } } }; };
/** Reserves `bytes` (at most the whole budget) and resolves once they are free. Release the lease exactly once its
 * buffers are unreachable; release is idempotent. */
export async function reserveMemory(bytes: number, signal?: AbortSignal): Promise<MemoryLease> {
  const n = Math.max(1, Math.min(budget, Math.ceil(bytes))), outer = holding.getStore();
  if (outer) {
    if (n <= outer.bytes) return { release() {} };
    log('warn', { code: 'ISOLATE_MEMORY_NESTED_GROWTH', heldBytes: outer.bytes, neededBytes: n });
    used += n - outer.bytes;
    return lease(n - outer.bytes);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const entry = { bytes: n, start: () => { signal?.removeEventListener('abort', onAbort); resolve(); } };
    const onAbort = () => {
      const idx = waiting.indexOf(entry);
      if (idx >= 0) { waiting.splice(idx, 1); admit(); }
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    waiting.push(entry);
    admit();
  });
  return lease(n);
}
/** Runs `work` holding `bytes` of the isolate's budget. */
export async function withMemory<T>(bytes: number, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const held = await reserveMemory(bytes, signal), outer = holding.getStore();
  try { return await holding.run({ bytes: Math.max(outer?.bytes ?? 0, Math.min(budget, Math.ceil(bytes))) }, work); } finally { held.release(); }
}
/** What the budget has handed out now (for tests and measurements). */
export const memoryInUse = () => used;
/** Number of requests currently waiting for a memory lease. */
export const memoryWaiting = () => waiting.length;

/** A dispatcher page's peak: per byte of files, the files and the SES JSON body with their base64 (4/3), and for raw
 * MIME (inline images, at most the lane budget of files) also the message (1.37) and its base64 again (1.83); per byte
 * of body text, the snapshot, its rendered copy and the JSON body. */
export const sendReservation = (files: number, content: number) => files * (files <= SEND_LIMITS.laneBytes ? 4.25 : 2.5) + content * 3;
