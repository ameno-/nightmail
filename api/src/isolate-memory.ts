import { AsyncLocalStorage } from 'node:async_hooks';
import { SEND_LIMITS } from './send-limits.js';

// One byte budget for every path that holds a large attachment in memory: raw uploads, attachment downloads, the
// dispatcher's pages with attachments or large bodies (every lane counts), and inbox mail's attachment copy and Sent
// archive. A Worker isolate has 128 MB for all its requests at once and the loaded app holds about 25 MB, so these paths
// together may hold at most SEND_LIMITS.isolateWorkingBytes. Each path reserves its expected peak (the file and every
// buffer it builds from it) before it reads anything, waits in arrival order while the budget is spent, and gives it
// back when it is done. A reservation larger than the budget waits for the whole budget and then runs alone.
const budget = SEND_LIMITS.isolateWorkingBytes;
let used = 0;
const waiting: { bytes: number; start: () => void }[] = [];
// A path that already holds a reservation (the dispatcher's page, a Sent archive) covers the work inside it, so a nested
// reservation never waits on its own holder.
const holding = new AsyncLocalStorage<true>();

function admit() {
  while (waiting.length && used + waiting[0]!.bytes <= budget) { const next = waiting.shift()!; used += next.bytes; next.start(); }
}
export type MemoryLease = { release(): void };
/** Reserves `bytes` (at most the whole budget) and resolves once they are free. Release the lease exactly when done; it is idempotent. */
export async function reserveMemory(bytes: number): Promise<MemoryLease> {
  if (holding.getStore()) return { release() {} };
  const n = Math.max(1, Math.min(budget, Math.ceil(bytes)));
  await new Promise<void>(start => { waiting.push({ bytes: n, start }); admit(); });
  let held = true;
  return { release() { if (held) { held = false; used -= n; admit(); } } };
}
/** Runs `work` holding `bytes` of the isolate's budget. */
export async function withMemory<T>(bytes: number, work: () => Promise<T>): Promise<T> {
  if (holding.getStore()) return work();
  const lease = await reserveMemory(bytes);
  try { return await holding.run(true, work); } finally { lease.release(); }
}
/** What the budget has handed out now (for tests and measurements). */
export const memoryInUse = () => used;

/** A dispatcher page's peak: per byte of files, the files and the SES JSON body with their base64 (4/3), and for raw
 * MIME (inline images, at most the lane budget of files) also the message (1.37) and its base64 again (1.83); per byte
 * of body text, the snapshot, its rendered copy and the JSON body. */
export const sendReservation = (files: number, content: number) => files * (files <= SEND_LIMITS.laneBytes ? 4.25 : 2.5) + content * 3;
