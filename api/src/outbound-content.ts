import { z } from '@hono/zod-openapi';
import { Buffer } from 'node:buffer';
import { ApiError } from './core.js';

// Shared validation for sending, audience/consent and template reply addresses.
export const mailAddress = (base=z.string()) => base.email({pattern:/^(?!\.)(?!.*\.\.)[a-z0-9_'+.\-]*[a-z0-9_+\-]@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,}|xn--[a-z0-9][a-z0-9-]*[a-z0-9])$/i}).max(254).regex(/^[\x21-\x7e]+$/, 'Use ASCII email addresses (punycode domains are supported).')
  .refine(v => v.indexOf('@') <= 64 && v.slice(v.indexOf('@')+1).split('.').every(label => label.length <= 63), 'The local part may not exceed 64 bytes or a domain label 63 bytes.');

// A sender display name may not read as an address or an angle-bracketed route in any client, and may not carry the
// characters that reorder or hide what a client renders. The address check runs on a folded copy of the name, built
// the way Unicode TR39 builds a confusable skeleton: NFD, format characters removed, each character replaced by its
// confusables.txt prototype, NFD again. The table below is that data (version 18.0.0) for every source that is not a
// letter and whose prototype contains @, < or > or TR39's angle bracket exemplars ❬ and ❭, plus every source whose
// prototype is the letter a or A. Letters drawn as arrowheads (hiragana く, Canadian syllabics ᐳ) stay letters, as names
// are written in them. TR39 and NFKC both read an enclosed a as the letter, so circled a becomes @ before NFKC folds
// the remaining compatibility forms, and a or A under a combining enclosing mark becomes @ after it; combining marks
// are then removed so none can sit between the characters that matter. Joiners stay allowed in the name itself, for
// emoji and script shaping, as do the weak directional marks some names need to display correctly.
const CONTROL = /[\x00-\x1f\x7f-\x9f\u180e\u2028\u2029\u202a-\u202e\u2066-\u2069\ufff9-\ufffb\u{e0001}\u{e0020}-\u{e007f}]/u;
const CONFUSABLES = new Map<number, string>([
  [0x251, 'a'], [0x2C2, '<'], [0x2C3, '>'], [0x391, 'A'], [0x3B1, 'a'], [0x410, 'A'], [0x430, 'a'], [0x13AA, 'A'], [0x15C5, 'A'], [0x2039, '<'],
  [0x203A, '>'], [0x226A, '<<'], [0x226B, '>>'], [0x22D6, '<\u{B7}'], [0x22D7, '\u{B7}>'], [0x22D8, '<<<'], [0x22D9, '>>>'], [0x237A, 'a'],
  [0x276E, '<'], [0x276F, '>'], [0x27E8, '\u{276C}'], [0x27E9, '\u{276D}'], [0x2A20, '>>'], [0x2AA5, '><'], [0x3008, '\u{276C}'],
  [0x3009, '\u{276D}'], [0x31DB, '\u{276C}'], [0xA4EE, 'A'], [0xAB64, 'a'], [0xFE64, '<'], [0xFE65, '>'], [0xFE6B, '@'], [0xFF1C, '<'],
  [0xFF1E, '>'], [0xFF20, '@'], [0xFF21, 'A'], [0xFF41, 'a'], [0x102A0, 'A'], [0x16F40, 'A'], [0x1CCD6, 'A'], [0x1D236, '<'], [0x1D237, '>'],
  [0x1D400, 'A'], [0x1D41A, 'a'], [0x1D434, 'A'], [0x1D44E, 'a'], [0x1D468, 'A'], [0x1D482, 'a'], [0x1D49C, 'A'], [0x1D4B6, 'a'], [0x1D4D0, 'A'],
  [0x1D4EA, 'a'], [0x1D504, 'A'], [0x1D51E, 'a'], [0x1D538, 'A'], [0x1D552, 'a'], [0x1D56C, 'A'], [0x1D586, 'a'], [0x1D5A0, 'A'], [0x1D5BA, 'a'],
  [0x1D5D4, 'A'], [0x1D5EE, 'a'], [0x1D608, 'A'], [0x1D622, 'a'], [0x1D63C, 'A'], [0x1D656, 'a'], [0x1D670, 'A'], [0x1D68A, 'a'], [0x1D6A8, 'A'],
  [0x1D6C2, 'a'], [0x1D6E2, 'A'], [0x1D6FC, 'a'], [0x1D71C, 'A'], [0x1D736, 'a'], [0x1D756, 'A'], [0x1D770, 'a'], [0x1D790, 'A'], [0x1D7AA, 'a'],
  [0x1DF5A, 'a'], [0x1DF6A, 'A']]);
const skeleton = (value: string) => Array.from(value.normalize('NFD').replace(/\p{Cf}/gu, ''), c => CONFUSABLES.get(c.codePointAt(0)!) ?? c).join('').normalize('NFD');
export const foldedDisplayName = (value: string) => skeleton(value).replace(/[\u24b6\u24d0\u{1f150}]/gu, '@').normalize('NFKC').normalize('NFD')
  .replace(/[aA]\p{M}*[\u20dd-\u20e0\u20e2-\u20e4]/gu, '@').replace(/\u276c/g, '<').replace(/\u276d/g, '>').replace(/[\p{M}\p{Cf}]/gu, '');
export const displayNameAllowed = (value: string) => !CONTROL.test(value) && !/[@<>]/.test(foldedDisplayName(value));
export const senderDisplayName = () => z.string().max(200).refine(displayNameAllowed, 'Sender name cannot contain an address, angle brackets, or control characters.');

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
// Base64 of 8 MiB plus padding and the line breaks MIME tools and SDKs insert.
export const MAX_ATTACHMENT_BASE64 = 12 * 1024 * 1024;
// https://docs.aws.amazon.com/ses/latest/dg/mime-types.html: SES rejects these extensions; everything else is deliverable.
const BANNED_EXTENSIONS = new Set(['ade', 'adp', 'app', 'asp', 'bas', 'bat', 'cer', 'chm', 'cmd', 'com', 'cpl', 'crt', 'csh', 'der', 'exe', 'fxp', 'gadget', 'hlp', 'hta', 'inf', 'ins', 'isp', 'its', 'js', 'jse', 'ksh', 'lib', 'lnk',
  'mad', 'maf', 'mag', 'mam', 'maq', 'mar', 'mas', 'mat', 'mau', 'mav', 'maw', 'mda', 'mdb', 'mde', 'mdt', 'mdw', 'mdz', 'msc', 'msh', 'msh1', 'msh2', 'mshxml', 'msh1xml', 'msh2xml', 'msi', 'msp', 'mst', 'ops', 'pcd', 'pif', 'plg', 'prf', 'prg',
  'reg', 'scf', 'scr', 'sct', 'shb', 'shs', 'sys', 'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'tmp', 'url', 'vb', 'vbe', 'vbs', 'vps', 'vsmacros', 'vss', 'vst', 'vsw', 'vxd', 'ws', 'wsc', 'wsf', 'wsh', 'xnk']);

export const AttachmentFilename = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f/\\]+$/);
export const AttachmentContentType = z.string().max(78).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?: *;[ -~]*)?$/, 'Use a MIME type such as application/pdf, optionally with parameters.');
export const AttachmentContentId = z.string().min(1).max(78).regex(/^[a-zA-Z0-9_.@-]+$/);
export const AttachmentDisposition = z.enum(['attachment', 'inline']);
export const AttachmentMetadata = z.object({ filename: AttachmentFilename, contentType: AttachmentContentType.default('application/octet-stream'), disposition: AttachmentDisposition.default('attachment'), contentId: AttachmentContentId.optional() }).strict();
export const AttachmentUpload = AttachmentMetadata.extend({ content: z.string().min(4).max(MAX_ATTACHMENT_BASE64).describe('Base64 (standard or URL-safe alphabet; line breaks are accepted). No data URLs. Maximum decoded bytes: 8 MiB.') }).strict().openapi('AttachmentUpload');
export type AttachmentMetadataInput = z.infer<typeof AttachmentMetadata>;

/** Decodes base64 as SDKs actually emit it: standard or URL-safe alphabet, with or without padding, line breaks and spaces ignored. */
export function decodeBase64(content: string, field = 'content'): Uint8Array {
  // Flat character classes only: repeated groups would exhaust the stack on multi-megabyte uploads.
  const compact = content.replace(/[\r\n\t ]+/g, '');
  const unpadded = compact.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/_-]*$/.test(unpadded) || unpadded.length % 4 === 1 || compact.length - unpadded.length > 2) throw new ApiError(422, 'INVALID_BASE64', 'Attachment content must be base64.', field);
  const bytes = Buffer.from(unpadded, 'base64');
  if (bytes.length !== Math.floor(unpadded.length * 3 / 4)) throw new ApiError(422, 'INVALID_BASE64', 'Attachment content must be base64.', field);
  return bytes;
}

/** Size caps and the SES banned-extension list are the only content rules; type, charset and file signatures are the caller's business. */
export function blockedExtension(filename: string) {
  // Windows ignores trailing dots and spaces when it opens a file, so "payload.exe. " is still an executable.
  const name = filename.replace(/[. ]+$/, ''), dot = name.lastIndexOf('.'), extension = dot > 0 ? name.slice(dot + 1).trim().toLowerCase() : '';
  return BANNED_EXTENSIONS.has(extension) ? extension : null;
}
export function validateAttachment<T extends AttachmentMetadataInput>(metadata: T, bytes: Uint8Array): T {
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new ApiError(413, 'ATTACHMENT_LIMIT_EXCEEDED', `Attachment ${metadata.filename} must be nonempty and at most 8 MiB decoded.`);
  const extension = blockedExtension(metadata.filename);
  if (extension) throw new ApiError(422, 'UNSUPPORTED_ATTACHMENT_TYPE', `Amazon SES does not deliver .${extension} attachments.`, 'filename');
  if (metadata.disposition === 'inline' && !metadata.contentId) throw new ApiError(422, 'INLINE_ATTACHMENT_INVALID', 'Inline attachments require contentId.', 'contentId');
  return metadata;
}

// A visual preview embeds every cid: reference as the image's whole data URI, so 3 KB of references to one 8 MiB
// image would build gigabytes. Measure the expansion from the stored sizes first, then read only referenced images.
export const MAX_PREVIEW_INLINE_BYTES = 16 * 1024 * 1024;
export async function embedInlineImages<T extends { contentId: string | null; contentType: string; size: number }>(html: string, items: T[], read: (item: T) => Promise<Uint8Array>) {
  const byReference = new Map<string, T>();
  for (const item of items) if (item.contentId && !byReference.has(`cid:${item.contentId}`)) byReference.set(`cid:${item.contentId}`, item);
  if (!byReference.size) return html;
  // One pass, longest reference first: an embedded URI is never scanned again (a content type may contain "cid:"),
  // and cid:logo never replaces the start of cid:logo2.
  const pattern = new RegExp([...byReference.keys()].sort((a, b) => b.length - a.length).map(reference => reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const counts = new Map<string, number>();
  for (const [reference] of html.matchAll(pattern)) counts.set(reference, (counts.get(reference) ?? 0) + 1);
  let added = 0;
  for (const [reference, count] of counts) { const item = byReference.get(reference)!; added += count * (`data:${item.contentType};base64,`.length + 4 * Math.ceil(item.size / 3)); }
  if (added > MAX_PREVIEW_INLINE_BYTES) throw new ApiError(413, 'PREVIEW_TOO_LARGE', 'Inline images would add more than 16 MiB to this preview. Reference each large image once, or use smaller images.');
  const uris = new Map<string, string>();
  for (const reference of counts.keys()) { const item = byReference.get(reference)!; uris.set(reference, `data:${item.contentType};base64,${Buffer.from(await read(item)).toString('base64')}`); }
  return html.replace(pattern, reference => uris.get(reference)!);
}
