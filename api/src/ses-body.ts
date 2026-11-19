import { Buffer } from 'node:buffer';
import { SEND_LIMITS } from './send-limits.js';

// The SES v2 API takes attachments (and raw MIME) as base64 inside a JSON body. The SDK encodes each part to a base64
// string and then copies it into the body, so a 25 MiB attachment held about 90 MB at once (the part, the string and
// the body; measured), too much of a Worker isolate's 128 MB beside its other work.
// This middleware keeps the SDK (serialization, signing, retries, errors) and changes only how large parts reach the
// body: before serialization it swaps each part of LARGE_PART bytes or more for a short unique marker, and after
// serialization it writes the request body once, as bytes, with each part's base64 written straight into it. A send
// then holds its parts plus one body of 4/3 their size.
const LARGE_PART = 64 * 1024, MARKER_BYTES = 24, CHUNK = 3 * 16 * 1024;
type Parts = Map<string, Uint8Array>;
// The SDK types its stack per command; this adds the same two middlewares to any SES v2 client.
type Middleware = { add(middleware: (next: (args: any) => Promise<any>, context: any) => (args: any) => Promise<any>, options: any): void };

const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;
function swap(input: any, parts: Parts) {
  const marker = (bytes: Uint8Array) => {
    if (bytes.length < LARGE_PART) return bytes;
    const key = crypto.getRandomValues(new Uint8Array(MARKER_BYTES));
    parts.set(Buffer.from(key).toString('base64'), bytes);
    return key;
  };
  const content = input?.Content;
  if (!content) return input;
  const raw = isBytes(content.Raw?.Data) ? { Raw: { ...content.Raw, Data: marker(content.Raw.Data) } } : {};
  const attachments = Array.isArray(content.Simple?.Attachments) ? { Simple: { ...content.Simple, Attachments: content.Simple.Attachments.map((a: any) => isBytes(a?.RawContent) ? { ...a, RawContent: marker(a.RawContent) } : a) } } : {};
  return parts.size ? { ...input, Content: { ...content, ...raw, ...attachments } } : input;
}

/** The JSON body with every marker replaced by its part's base64, written once into a byte array. */
export function spliceBody(body: string, parts: Parts): Uint8Array<ArrayBuffer> {
  const found = [...parts].map(([marker, bytes]) => ({ at: body.indexOf(marker), marker, bytes }));
  if (found.some(f => f.at < 0)) throw new Error('SES request body is missing an attachment marker');
  found.sort((a, b) => a.at - b.at);
  const encoder = new TextEncoder();
  let size = 0, from = 0;
  for (const f of found) { size += Buffer.byteLength(body.slice(from, f.at)) + Math.ceil(f.bytes.length / 3) * 4; from = f.at + f.marker.length; }
  size += Buffer.byteLength(body.slice(from));
  const out = new Uint8Array(size);
  let written = 0;
  const text = (value: string) => { written += encoder.encodeInto(value, out.subarray(written)).written; };
  from = 0;
  for (const f of found) {
    text(body.slice(from, f.at));
    // Whole 3-byte groups per chunk, so chunk encodings concatenate to the part's base64.
    for (let i = 0; i < f.bytes.length; i += CHUNK) text(Buffer.from(f.bytes.buffer, f.bytes.byteOffset + i, Math.min(CHUNK, f.bytes.length - i)).toString('base64'));
    from = f.at + f.marker.length;
  }
  text(body.slice(from));
  if (written !== size) throw new Error('SES request body size mismatch');
  return out;
}

/** Adds the body splice to an SES v2 client's middleware stack (SendEmail only; other commands carry no parts). */
export function addSesBodySplice(stack: Middleware) {
  const pending = new WeakMap<object, Parts>();
  stack.add((next, context) => async (args: any) => {
    if (context.commandName !== 'SendEmailCommand') return next(args);
    const parts: Parts = new Map();
    const input = swap(args.input, parts);
    if (parts.size) pending.set(context, parts);
    return next({ ...args, input });
  }, { step: 'initialize', name: 'nightmailSesPartsOut', priority: 'low' });
  stack.add((next, context) => async (args: any) => {
    const parts = pending.get(context);
    // The SDK's JSON serializer writes bytes (a Uint8Array) or, in older versions, a string; with the parts swapped
    // out it is small either way.
    const serialized: unknown = args.request?.body;
    if (parts && (typeof serialized === 'string' || serialized instanceof Uint8Array)) {
      const body = spliceBody(typeof serialized === 'string' ? serialized : new TextDecoder().decode(serialized), parts);
      args.request.body = body;
      args.request.headers['content-length'] = String(body.length);
      pending.delete(context);
    }
    return next(args);
  }, { step: 'build', name: 'nightmailSesPartsIn', priority: 'high' });
}

// One message above the ordinary lane budget at a time per isolate: its parts and body are a large share of the
// isolate's memory, so two must never overlap (dispatcher lanes, inbox replies and downloads share one isolate).
let largeTail: Promise<unknown> = Promise.resolve();
export async function oneLargeMessage<T>(bytes: number, work: () => Promise<T>): Promise<T> {
  if (bytes <= SEND_LIMITS.laneBytes) return work();
  const run = largeTail.then(work, work);
  largeTail = run.catch(() => undefined);
  return run;
}
