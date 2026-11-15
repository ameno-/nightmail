import { Buffer } from 'node:buffer';
import { ApiError, type RenderedImage, type Runtime } from './core.js';

// Visual previews embed every cid: reference as the image's whole data URI and hold the page while Browser Run renders
// it, so their memory is counted against one budget per isolate (a Worker isolate has 128 MB; on Node, per process).
const MiB = 1024 * 1024;
export const PREVIEW_MEMORY_BUDGET = 24 * MiB;
// One preview's page, counted as it is held: the largest raw image (read and encoded one at a time), then three copies
// of the page with its data URIs (built, serialized for the renderer, and that request's body). Two fit the budget.
export const PREVIEW_INLINE_LIMIT = 8 * MiB;
// The screenshot is held three times (PNG, base64, JSON response). This much is reserved from the start, enough for a
// screenshot under 1 MiB; a larger one must fit the budget when it arrives.
const SCREENSHOT_RESERVE = 3 * MiB, SCREENSHOT_COPIES = 3;
let held = 0;

const busy = () => new ApiError(429, 'PREVIEW_BUSY', 'This server is rendering other previews. Retry in a few seconds.', undefined, true, new Date(Date.now() + 5000).toISOString());
function reserve(bytes: number) {
  if (held + bytes > PREVIEW_MEMORY_BUDGET) throw busy();
  held += bytes;
  let own = bytes;
  return {
    resize(next: number) { if (next > own && held - own + next > PREVIEW_MEMORY_BUDGET) throw busy(); held += next - own; own = next; },
    release() { held -= own; own = 0; },
  };
}

type InlineImage = { contentId: string | null; contentType: string; size: number };
/** Renders a preview page with its inline images embedded, refusing work that does not fit this isolate's budget before reading any image. */
export async function renderPreview<T extends InlineImage, R>(runtime: Pick<Runtime, 'allowPreview'>, workspaceId: string, html: string, items: T[], read: (item: T) => Promise<Uint8Array>,
  render: (html: string) => Promise<RenderedImage>, respond: (image: { data: string; mimeType: RenderedImage['mimeType'] }) => R): Promise<R> {
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
  const memory = reserve(page + SCREENSHOT_RESERVE);
  try {
    if (counts.size) {
      const uris = new Map<string, string>();
      for (const reference of counts.keys()) {
        const item = byReference.get(reference)!, body = await read(item);
        uris.set(reference, `data:${item.contentType};base64,${Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64')}`);
      }
      html = html.replace(pattern, reference => uris.get(reference)!);
    }
    const image = await render(html);
    html = '';
    // The page is gone; the screenshot and its encodings remain.
    memory.resize(Math.max(SCREENSHOT_RESERVE, SCREENSHOT_COPIES * image.data.byteLength));
    return respond({ data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString('base64'), mimeType: image.mimeType });
  } finally { memory.release(); }
}
