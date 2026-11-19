import { Buffer } from 'node:buffer';

/**
 * Every limit a send is admitted against, defined once. The admission decision (send_admission, migration 323)
 * receives them as parameters, so SQL repeats none of these numbers; the dispatcher and the advisory sendability
 * score read the same values.
 */
export const SEND_LIMITS = {
  /** Outstanding (queued or attempting) direct mail per workspace: a day of the account's own SES quota within these
   * bounds; Hosted gets the floor (the ceiling when exempt) unless an operator overrides it. */
  pendingFloor: 10_000,
  pendingCeiling: 200_000,
  /** Recipients in a rolling 24 hours from which Hosted transactional mail needs aligned DMARC, as marketing always does. */
  bulkVolume: 5_000,
  /** DMARC facts older than this are not evidence. */
  dmarcMaxAgeHours: 48,
  /** SES's limit on an attachment's MIME type and content ID, in printable ASCII characters. */
  mimeFieldChars: 78,
  /** Decoded attachments per message (so also per attachment). SES v2 takes messages up to 40 MB after base64
   * encoding (https://docs.aws.amazon.com/ses/latest/dg/quotas.html); base64 with MIME line breaks grows a file by
   * 4/3 × 78/76 (about 37%), so 25 MiB of files is about 36 MB on the wire and leaves room for the body and headers. */
  attachmentBytes: 25 * 1024 * 1024,
  /** A file sent as base64 inside a JSON request (uploadAttachment's JSON body, inbox mail's inline content, MCP): the
   * request text, the parsed string and the decoded bytes are all held at once, so these stay at 8 MiB decoded.
   * Larger files upload as raw bytes (POST /v1/attachments/upload). */
  jsonAttachmentBytes: 8 * 1024 * 1024,
  /** The estimated encoded message (estimatedMimeBytes) may not pass SES's own maximum: 40 MB after encoding. */
  encodedBytes: 40_000_000,
  /** Attachment and body bytes one dispatcher lane prepares at once; a larger message is a page of its own. */
  laneBytes: 8 * 1024 * 1024,
  /** What every large-attachment path in one isolate may hold at once (isolate-memory.ts): with the loaded app's
   * ~25 MB this keeps a Worker isolate under ~90 MB of its 128 MB. */
  isolateWorkingBytes: 64 * 1024 * 1024,
  /** How the encoded size is estimated: body parts grow by bodyFactor, each attachment is base64 grown by lineFactor
   * plus perAttachment of headers, and the message adds envelope. */
  mime: { bodyFactor: 1.4, lineFactor: 1.04, perAttachment: 2048, envelope: 16384 },
  /** Outstanding campaign recipients per workspace and per sender key. */
  campaignPendingWorkspace: 4_000_000,
  campaignPendingKey: 2_000_000,
} as const;

/** UTF-8 bytes of the parts a message's MIME carries, counted without copying them. */
export const contentBytes = (parts: { raw?: string; html?: string; text?: string; subject?: string }) =>
  [parts.raw, parts.html, parts.text, parts.subject].reduce<number>((n, part) => n + (part ? Buffer.byteLength(part) : 0), 0);
/** A conservative estimate of the encoded message: base64/MIME expansion, line folding and headers. */
export function estimatedMimeBytes(parts: { raw?: string; html?: string; text?: string; subject?: string }, rows: { size: number }[]) {
  const { bodyFactor, lineFactor, perAttachment, envelope } = SEND_LIMITS.mime;
  return Math.ceil(Math.ceil(contentBytes(parts) * bodyFactor) + rows.reduce((sum, r) => sum + Math.ceil(r.size / 3) * 4 * lineFactor + perAttachment, 0) + envelope);
}
