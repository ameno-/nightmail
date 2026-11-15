import { Buffer } from 'node:buffer';
import type { TypedResponse } from 'hono';
import { ApiError, type RenderedImage, type Runtime } from './core.js';

// Visual previews embed every cid: reference as the image's whole data URI, hold the page while Browser Run renders it,
// then hold the screenshot until the client has read the response. Everything they hold is counted against one budget
// per isolate (a Worker isolate has 128 MB; on Node, per process), from before the first read until the body is sent.
const MiB = 1024 * 1024;
export const PREVIEW_MEMORY_BUDGET = 24 * MiB;
// One preview's page, counted as it is held: the largest raw image (read and encoded one at a time), then three copies
// of the page with its data URIs (built, serialized for the renderer, and that request's body). Two fit the budget.
export const PREVIEW_INLINE_LIMIT = 8 * MiB;
// Held for the screenshot from the start. A larger one grows the share as Browser Run's response is read (its size
// from Content-Length before anything is allocated, else twice the bytes so far: the chunks and the joined copy).
const SCREENSHOT_RESERVE = 2 * MiB;
// The response is encoded from the PNG as the client reads it, 48 KiB (64 KiB of base64) at a time: the PNG plus this
// covers the chunk in flight and the runtime's send buffers. A client still reading after the deadline is cut off.
const SEND_SLACK = MiB, CHUNK = 48 * 1024;
export const PREVIEW_SEND_DEADLINE_MS = 30_000;
let held = 0;

export type PreviewLease = { resize(bytes: number): void; release(): void };
const busy = () => new ApiError(429, 'PREVIEW_BUSY', 'This server is rendering or sending other previews. Retry in a few seconds.', undefined, true, new Date(Date.now() + 5000).toISOString());
/** Reserves `bytes` of the isolate's preview budget, or throws 429 PREVIEW_BUSY. Release it exactly when the bytes are gone. */
export function holdPreviewMemory(bytes: number): PreviewLease {
  if (held + bytes > PREVIEW_MEMORY_BUDGET) throw busy();
  held += bytes;
  let own = bytes;
  return {
    resize(next: number) { if (next > own && held - own + next > PREVIEW_MEMORY_BUDGET) throw busy(); held += next - own; own = next; },
    release() { held -= own; own = 0; },
  };
}

/** A response body produced as it is read. It holds `memory` (and `source`'s data) until it is read to the end, cancelled, fails, or passes the deadline. */
export function heldBody(memory: PreviewLease, source: () => Uint8Array | null): ReadableStream<Uint8Array> {
  let next: (() => Uint8Array | null) | undefined = source, controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = () => { if (!next) return; next = undefined; clearTimeout(timer); memory.release(); };
  const timer = setTimeout(() => { if (next) { controller?.error(new Error('The preview response was not read before its deadline.')); finish(); } }, PREVIEW_SEND_DEADLINE_MS);
  (timer as { unref?: () => void }).unref?.();
  return new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    pull(c) {
      if (!next) return;
      try { const chunk = next(); if (chunk) c.enqueue(chunk); else { c.close(); finish(); } }
      catch (error) { c.error(error); finish(); }
    },
    cancel() { finish(); },
  }, { highWaterMark: 0 });
}

type InlineImage = { contentId: string | null; contentType: string; size: number };
/** Renders a preview page with its inline images embedded and returns `{ data, mimeType, ...fields }` as JSON, refusing work that does not fit this isolate's budget before reading any image. */
export async function renderPreview<T extends InlineImage, F extends Record<string, unknown> = Record<never, never>>(runtime: Pick<Runtime, 'allowPreview'>, workspaceId: string, html: string, items: T[],
  read: (item: T) => Promise<Uint8Array>, render: (html: string, grow: (bytes: number) => void) => Promise<RenderedImage>, fields = {} as F): Promise<Response & TypedResponse<{ data: string; mimeType: RenderedImage['mimeType'] } & F, 200, 'json'>> {
  const byReference = new Map<string, T>();
  for (const item of items) if (item.contentId && !byReference.has(`cid:${item.contentId}`)) byReference.set(`cid:${item.contentId}`, item);
  // One pass, longest reference first: an embedded URI is never scanned again (a content type may contain "cid:"),
  // and cid:logo never replaces the start of cid:logo2.
  const pattern = new RegExp([...byReference.keys()].sort((a, b) => b.length - a.length).map(reference => reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '(?!)', 'g');
  const counts = new Map<string, number>();
  for (const [reference] of html.matchAll(pattern)) counts.set(reference, (counts.get(reference) ?? 0) + 1);
  let encoded = 0, largest = 0;
  for (const [reference, count] of counts) {
    const item = byReference.get(reference)!;
    encoded += count * (`data:${item.contentType};base64,`.length + 4 * Math.ceil(item.size / 3)); largest = Math.max(largest, item.size);
  }
  // A page with any character beyond Latin-1 is a two-byte string in V8, data URIs included.
  const page = largest + 3 * (/[^\x00-\xff]/.test(html) ? 2 : 1) * (html.length + encoded);
  if (page > PREVIEW_INLINE_LIMIT) throw new ApiError(413, 'PREVIEW_TOO_LARGE', `Previewing these inline images needs ${(page / MiB).toFixed(1)} MiB; the limit is ${PREVIEW_INLINE_LIMIT / MiB} MiB. Use smaller images or reference each one once.`);
  if (runtime.allowPreview && !await runtime.allowPreview(workspaceId, page + SCREENSHOT_RESERVE))
    throw new ApiError(429, 'RENDER_RATE_LIMITED', 'This workspace previewed too many large pages this minute. Retry after the window resets.', undefined, true, new Date(Date.now() + 60_000).toISOString());
  const memory = holdPreviewMemory(page + SCREENSHOT_RESERVE);
  let sending = false;
  try {
    if (counts.size) {
      const uris = new Map<string, string>();
      for (const reference of counts.keys()) {
        const item = byReference.get(reference)!, body = await read(item);
        uris.set(reference, `data:${item.contentType};base64,${Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64')}`);
      }
      html = html.replace(pattern, reference => uris.get(reference)!);
    }
    const image = await render(html, bytes => memory.resize(page + Math.max(SCREENSHOT_RESERVE, bytes)));
    html = '';
    // The page is gone; until the client has read the response, only the PNG remains.
    memory.resize(image.data.byteLength + SEND_SLACK);
    const prefix = '{"data":"', suffix = `",${JSON.stringify({ mimeType: image.mimeType, ...fields }).slice(1)}`;
    const length = prefix.length + 4 * Math.ceil(image.data.byteLength / 3) + suffix.length, encoder = new TextEncoder();
    let data: Uint8Array | undefined = image.data, at = -1;
    const body = heldBody(memory, () => {
      if (!data) return null;
      if (at < 0) { at = 0; return encoder.encode(prefix); }
      if (at < data.byteLength) { const end = Math.min(at + CHUNK, data.byteLength), chunk = Buffer.from(data.buffer, data.byteOffset + at, end - at).toString('base64'); at = end; return encoder.encode(chunk); }
      data = undefined; return encoder.encode(suffix);
    });
    sending = true;
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(length) } }) as Response & TypedResponse<{ data: string; mimeType: RenderedImage['mimeType'] } & F, 200, 'json'>;
  } finally { if (!sending) memory.release(); }
}
