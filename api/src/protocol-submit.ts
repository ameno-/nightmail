import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, type Ctx, type Runtime } from './core.js';
import { sendingConnections } from './domain-claims.js';
import { withMemory } from './isolate-memory.js';
import { SMTP_WIRE_LIMIT } from './mailbox-ingest.js';
import { mib } from './outbound-content.js';
import { SEND_LIMITS } from './send-limits.js';
import type { SubmittedFile } from './submission-mime.js';

/**
 * A mail app's SMTP submission, from the gateway: the envelope and the message as the app sent it. An app password's
 * (protocol-content.ts) is sent from its inbox and kept in its Sent folder; a send-only key's (protocol-relay.ts) is
 * sent as POST /v1/emails/send with that key would. The gateway streams the raw message as the request body, with the
 * envelope in x-bane-submit; an older gateway sends it base64 inside the JSON RPC, at most 8 MiB.
 */
export type Submitted = { kid: string; from: string; to: string[]; raw: Uint8Array };
/** An envelope's recipients: RFC 5321 4.5.3.1.8 asks for at least 100. Sends go to SES in messages of up to 50. */
export const SMTP_RECIPIENTS = 100;
const envelope = z.object({
  kid: z.string().min(1).max(120),
  from: z.email(),
  to: z.array(z.email()).min(1).max(SMTP_RECIPIENTS),
  size: z.number().int().min(1).max(SMTP_WIRE_LIMIT),
}).strict();

/** What a submission holds at most: the message, one decoded attachment beside it and the parser's skeleton. */
const reservation = (size: number) => size + Math.min(size, SEND_LIMITS.attachmentBytes) + 4 * 1024 * 1024;

export async function submit(c: Ctx, p: Submitted): Promise<{ id: string; sentCopy?: boolean }> {
  if (p.raw.length > SMTP_WIRE_LIMIT) throw new ApiError(413, 'MESSAGE_SIZE', `A message can be at most ${mib(SMTP_WIRE_LIMIT)}.`);
  return /^(?:key|mbk)_/.test(p.kid) ? (await import('./protocol-relay.js')).relaySubmit(c, p) : (await import('./protocol-content.js')).contentWrite(c, p);
}

/** The streamed submission: the body is exactly `size` bytes whose SHA-256 is the signed digest, read before anything
 *  else is done with it. */
export async function streamedSubmit(c: Ctx, encoded: string, digest: string) {
  const p = envelope.safeParse(JSON.parse(Buffer.from(encoded, 'base64').toString()));
  if (!p.success) throw new ApiError(422, 'INVALID_REQUEST', 'Invalid submission envelope.');
  const { size, ...rest } = p.data;
  if (Number(c.req.header('content-length')) !== size) throw new ApiError(422, 'INVALID_LENGTH', 'Invalid submission length.');
  return withMemory(reservation(size), async () => {
    const body = c.req.raw.body, raw = new Uint8Array(size), hash = createHash('sha256');
    if (!body) throw new ApiError(422, 'INVALID_CONTENT', 'Invalid submission content.');
    const reader = body.getReader();
    let at = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (at + value.length > size) throw new ApiError(422, 'INVALID_CONTENT', 'Invalid submission content.');
        raw.set(value, at); hash.update(value); at += value.length;
      }
    } finally { void reader.cancel().catch(() => {}); }
    if (at !== size || hash.digest('hex') !== digest) throw new ApiError(422, 'INVALID_CONTENT', 'Invalid submission content.');
    return submit(c, { ...rest, raw });
  });
}

/** A submitted file, stored when admission reaches it and not before (mailbox-send.ts resolveAttachments). */
export const submittedFile = (f: SubmittedFile) => ({
  filename: f.filename ?? 'attachment', contentType: f.mimeType, disposition: f.disposition === 'inline' ? 'inline' as const : 'attachment' as const,
  contentId: f.contentId?.replace(/^<|>$/g, ''), size: f.size, bytes: () => f.bytes(),
});

/**
 * A signed or encrypted message (submission-mime.ts sealedMime) is sent as the app wrote it: rebuilding its MIME would
 * break the signature or the encryption. It is screened by what it shows (a signed message's signed part; an encrypted
 * one only by its subject), so on Hosted it needs a sender past its evaluation, whose mail goes out as sent rather than
 * as the copy the screen read. Its bytes travel as text in the email's snapshot and, base64 again, inside SES's JSON:
 * at most the dispatcher's lane budget (8 MiB), and valid UTF-8 without NUL, so the text is the same bytes.
 */
export async function sealedPassthrough(rt: Runtime, workspaceId: string, raw: Uint8Array) {
  if (raw.length > SEND_LIMITS.laneBytes) throw new ApiError(413, 'SEALED_MESSAGE_SIZE', `A signed or encrypted message can be at most ${mib(SEND_LIMITS.laneBytes)}.`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { text = '\0'; }
  if (text.includes('\0')) throw new ApiError(422, 'UNSUPPORTED_MESSAGE', 'A signed or encrypted message must be UTF-8 or 7-bit text.');
  if (rt.config.multiTenant) {
    const { rows: [row] } = await rt.db.execute<{ ok: boolean }>(sql`SELECT EXISTS(SELECT FROM ${sendingConnections(rt)} c WHERE c.workspace_id=${workspaceId}
      AND (c.kind<>'shared' OR (${!!rt.config.trustedPool} AND c.pool_tier='trusted' AND NOT c.legacy_names))) AS ok`);
    if (!row?.ok) throw new ApiError(422, 'SEALED_MAIL_UNAVAILABLE', 'Signed and encrypted mail goes out as written, which a sender can do once its first messages are evaluated.');
  }
  return text;
}
