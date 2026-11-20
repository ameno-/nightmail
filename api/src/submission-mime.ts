import type { Attachment, Email } from 'postal-mime';
import { mimeIndex, type MimePart } from './mailbox-mime-index.js';
import { parseInboundMime, SUBMISSION_PARSE_LIMIT } from './mailbox-ingest.js';

/**
 * A mail app's SMTP submission, parsed without holding its attachments more than once. The MIME parser holds about six
 * times a message's attachments, so a submission with 25 MiB of files can't be parsed whole in a Worker isolate. Each
 * leaf the parser files as an attachment and that is past LIFTED bytes is lifted out: the parser reads a skeleton, the
 * same bytes with that part's body replaced by a marker, and the part is decoded from the raw message only when it is
 * stored (file.bytes()), one at a time. The decoders follow the parser's, so a lifted file has the bytes the parser
 * would have given it.
 */
const LIFTED = 64 * 1024;

export type SubmittedFile = {
  filename: string | null; mimeType: string; disposition: string | null; contentId?: string;
  /** The decoded size, or a bound on it for a lifted part. */
  size: number;
  bytes(): Uint8Array;
};
export type Submission = { mail: Email; files: SubmittedFile[] };
type Lifted = { part: MimePart; ended: boolean };

const fieldOf = (header: string, name: string) => new RegExp(`^${name}[ \\t]*:(.*)$`, 'im').exec(header.replace(/\r?\n[ \t]+/g, ' '))?.[1];
const field = (raw: Uint8Array, part: MimePart, name: string) => fieldOf(Buffer.from(raw.buffer, raw.byteOffset + part.offset, part.headerLength).toString('latin1'), name);
const valueOf = (text: string | undefined) => text?.split(';', 1)[0]!.trim().toLowerCase() || null;
// The transfer encoding as the parser reads it: comments removed, trimmed, lower case.
const encodingOf = (raw: Uint8Array, part: MimePart) => (field(raw, part, 'content-transfer-encoding') ?? '').replace(/\([^)]*\)/g, '').trim().toLowerCase();

/** Leaves the parser files as attachments, past LIFTED bytes. An attached message/rfc822, which it files whole, is
 *  lifted whole, never its insides. `ended`: a boundary ends the part (a multipart's child), not the end of its
 *  message (the root, or the root of a message/rfc822 the parser reads inline). */
function liftable(raw: Uint8Array, part: MimePart, ended: boolean, out: Lifted[]) {
  const disposition = valueOf(field(raw, part, 'content-disposition'));
  if (part.parts && !(part.type === 'message/rfc822' && disposition === 'attachment')) {
    for (const child of part.parts) liftable(raw, child, part.type.startsWith('multipart/'), out);
    return;
  }
  if (part.length - part.headerLength < LIFTED || part.type.startsWith('multipart/')) return;
  if ((part.type === 'text/plain' || part.type === 'text/html') && disposition !== 'attachment') return;
  if (part.type === 'text/calendar' || part.type === 'application/ics') return;
  out.push({ part, ended });
}

const BASE64 = new Int8Array(256).fill(-1);
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => { BASE64[c.charCodeAt(0)] = i; });
/** Base64 as the parser decodes it: other bytes are skipped, and each '=' ends a unit, whose trailing single character
 *  carries no byte. */
function base64Bytes(src: Uint8Array) {
  const out = new Uint8Array(Math.floor(src.length * 3 / 4) + 3);
  let n = 0, k = 0, a = 0, b = 0, c = 0;
  const flush = () => { if (k >= 2) out[n++] = (a << 2) | (b >> 4); if (k === 3) out[n++] = ((b & 15) << 4) | (c >> 2); k = 0; };
  for (const byte of src) {
    const v = BASE64[byte]!;
    if (v < 0) { if (byte === 61) flush(); continue; }
    if (k === 3) { out[n++] = (a << 2) | (b >> 4); out[n++] = ((b & 15) << 4) | (c >> 2); out[n++] = ((c & 3) << 6) | v; k = 0; continue; }
    if (k === 0) a = v; else if (k === 1) b = v; else c = v;
    k++;
  }
  flush();
  return out.subarray(0, n);
}
const hex = (byte: number) => byte >= 48 && byte <= 57 ? byte - 48 : byte >= 65 && byte <= 70 ? byte - 55 : byte >= 97 && byte <= 102 ? byte - 87 : -1;
/** Quoted-printable as the parser decodes it: trailing white space is dropped, a final '=' is a soft line break, an
 *  invalid escape stays literal, and every other line keeps the break it came with, except a final one a boundary owns. */
function qpBytes(src: Uint8Array, ended: boolean) {
  const out = new Uint8Array(src.length + 1);
  let n = 0, start = 0, pending: Uint8Array | null = null;
  while (start < src.length) {
    const lf = src.indexOf(10, start), stop = lf < 0 ? src.length : lf + 1;
    let end = stop;
    while (end > start && (src[end - 1] === 10 || src[end - 1] === 13)) end--;
    if (pending) { out.set(pending, n); n += pending.length; }
    let len = end;
    while (len > start && (src[len - 1] === 32 || src[len - 1] === 9)) len--;
    const soft = len > start && src[len - 1] === 61;
    if (soft) len--;
    for (let i = start; i < len; i++) {
      const high = src[i] === 61 && i + 2 < len ? hex(src[i + 1]!) : -1, low = high < 0 ? -1 : hex(src[i + 2]!);
      if (high >= 0 && low >= 0) { out[n++] = (high << 4) | low; i += 2; } else out[n++] = src[i]!;
    }
    pending = soft ? null : lf < 0 ? Uint8Array.of(10) : src.subarray(end, stop);
    start = stop;
  }
  if (!ended && pending) { out.set(pending, n); n += pending.length; }
  return out.subarray(0, n);
}
function decoded(raw: Uint8Array, { part, ended }: Lifted) {
  const body = raw.subarray(part.offset + part.headerLength, part.offset + part.length), encoding = encodingOf(raw, part);
  if (encoding === 'base64') return base64Bytes(body);
  if (encoding === 'quoted-printable') return qpBytes(body, ended);
  // A part its message's end ends keeps its last line break, and gets one if it has none.
  return ended || body.at(-1) === 10 ? body : Buffer.concat([body, Buffer.of(10)]);
}

const parsed = (a: Attachment): SubmittedFile => {
  const bytes = new Uint8Array(a.content as ArrayBuffer);
  return { filename: a.filename, mimeType: a.mimeType, disposition: a.disposition, contentId: a.contentId, size: bytes.length, bytes: () => bytes };
};

/** The parsed submission, or null when it can't be parsed within the parser's limits. */
export async function parseSubmission(raw: Uint8Array): Promise<Submission | null> {
  const index = mimeIndex(raw), lifted: Lifted[] = [];
  if (index) liftable(raw, index, false, lifted);
  const whole = async () => {
    if (raw.length > SUBMISSION_PARSE_LIMIT) return null;
    const mail = await parseInboundMime(raw, 'submission');
    return mail && { mail, files: mail.attachments.map(parsed) };
  };
  if (!lifted.length) return whole();
  const nonce = crypto.randomUUID().replace(/-/g, ''), markers = new Map<string, Lifted>(), pieces: Uint8Array[] = [];
  let at = 0;
  lifted.sort((x, y) => x.part.offset - y.part.offset).forEach((item, i) => {
    const marker = `nightmail-part-${nonce}-${i}`, { part } = item;
    markers.set(marker, item);
    pieces.push(raw.subarray(at, part.offset + part.headerLength), Buffer.from(encodingOf(raw, part) === 'base64' ? Buffer.from(marker).toString('base64') : marker, 'latin1'));
    at = part.offset + part.length;
  });
  pieces.push(raw.subarray(at));
  const mail = await parseInboundMime(Buffer.concat(pieces), 'submission');
  if (!mail) return null;
  const found = new Set<string>(), files = mail.attachments.map(a => {
    const content = new Uint8Array(a.content as ArrayBuffer), marker = content.length < 80 ? Buffer.from(content).toString('latin1') : '';
    const item = markers.get(marker);
    if (!item) return parsed(a);
    found.add(marker);
    const body = item.part.length - item.part.headerLength;
    return { filename: a.filename, mimeType: a.mimeType, disposition: a.disposition, contentId: a.contentId,
      size: encodingOf(raw, item.part) === 'base64' ? Math.ceil(body * 3 / 4) : body + 1, bytes: () => decoded(raw, item) };
  });
  // Each lifted part comes back as one attachment and its marker nowhere else; otherwise the message is parsed whole.
  if (found.size !== markers.size || [mail.text, mail.html].some(v => v?.includes(nonce))) return whole();
  return { mail, files };
}

/** Signed or encrypted as a whole (RFC 1847 multipart/signed or multipart/encrypted, S/MIME, PGP): only the top-level
 *  Content-Type counts, so a signed message forwarded as an attachment is an ordinary attachment. */
export function sealedMime(raw: Uint8Array) {
  const head = Buffer.from(raw.buffer, raw.byteOffset, Math.min(raw.length, 65536)).toString('latin1'), end = head.search(/\r?\n\r?\n/);
  return /^(?:multipart\/(?:signed|encrypted)|application\/(?:x-)?(?:pkcs7|pgp))/.test(valueOf(fieldOf(end < 0 ? head : head.slice(0, end), 'content-type')) ?? '');
}
