import { createRoute, z } from '@hono/zod-openapi';
import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { requestHeader, headerPrefix } from './brand.js';
import { ApiError, digest, errors, response, FORWARDED_MAIL_PATH, type App, type Runtime } from './core.js';
import { mailboxDomains, mailReceipts } from './db/mailbox.js';
import { forwardedStagingKey, mailObjectsFor } from './mail-objects.js';
import { acceptForwardedReceipt, wakeReceivedMail, FORWARD_BUCKET } from './mailbox-receipts.js';
import { boundRequestBody } from './request-body.js';

const MAX_RAW_BYTES = 40 * 1024 * 1024;
const Accepted = z.object({ accepted: z.literal(true), duplicate: z.boolean().describe('This ID was already accepted for these recipients: nothing new was stored.'), recipients: z.array(z.string()).describe('The envelope recipients on a receiving domain. Others are ignored.') }).openapi('ForwardedMailAccepted');
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const invalid = (name: string, rule: string) => new ApiError(422, 'FORWARD_ENVELOPE_INVALID', `${headerPrefix}${name} ${rule}`);

export function registerForwardedMail(app: App) {
  app.openapi(createRoute({
    method: 'post', path: FORWARDED_MAIL_PATH, operationId: 'receiveForwardedMail', tags: ['Events'], security: [], summary: 'Receive forwarded mail',
    description: `Self-hosted only, with MAIL_FORWARDER_SECRET set: a trusted mail forwarder posts one raw RFC 5322 message (at most 40 MiB) with its envelope, authenticated by Authorization: Bearer <MAIL_FORWARDER_SECRET>. Headers: ${headerPrefix}Message-Id, the forwarder's own ID for this delivery (1 to 512 characters; repeating it stores nothing new, and it adds recipients only with the same bytes, or fails with FORWARD_MESSAGE_CHANGED); ${headerPrefix}Envelope-From, the envelope sender (empty for a bounce); ${headerPrefix}Envelope-To, 1 to 200 comma-separated envelope recipients. Recipients that are not on a receiving domain are ignored; if none is, the request fails with FORWARD_RECIPIENT_UNKNOWN and nothing is stored. No SPF, DKIM, DMARC, spam or virus check runs: the forwarder is trusted to screen mail.`,
    request: { body: { required: true, content: { 'message/rfc822': { schema: z.string().openapi({ format: 'binary' }) } } } },
    responses: { 202: response(Accepted), ...errors },
  }), async c => {
    const { config } = c.env, secret = config.mailForwarderSecret;
    if (config.multiTenant || !secret) throw new ApiError(404, 'NOT_FOUND', 'Forwarded mail is not turned on for this installation.');
    // Checked before a byte of the body is read. Digests make the comparison constant-time whatever length was sent.
    if (!timingSafeEqual(sha256(c.req.header('authorization') ?? ''), sha256(`Bearer ${secret}`))) throw new ApiError(401, 'FORWARD_UNAUTHORIZED', 'The mail forwarder secret is missing or wrong.');
    const headers = c.req.raw.headers, forwarderId = requestHeader(headers, 'message-id') ?? '', sender = requestHeader(headers, 'envelope-from') ?? '';
    const envelope = [...new Set((requestHeader(headers, 'envelope-to') ?? '').split(',').map(address => address.trim().toLowerCase()).filter(Boolean))];
    if (!forwarderId || forwarderId.length > 512) throw invalid('Message-Id', 'must be 1 to 512 characters.');
    if (sender.length > 320) throw invalid('Envelope-From', 'must be at most 320 characters.');
    if (!envelope.length || envelope.length > 200 || envelope.some(address => address.length > 320 || !/^[^@\s]+@[^@\s]+$/.test(address))) throw invalid('Envelope-To', 'must list 1 to 200 email addresses, separated by commas.');
    const wid = config.workspaceId, host = (address: string) => address.slice(address.indexOf('@') + 1);
    const hosts = new Set((await c.env.db.select({ name: mailboxDomains.name }).from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, wid), eq(mailboxDomains.region, config.regions[0]!),
      inArray(mailboxDomains.name, envelope.map(host)), inArray(mailboxDomains.status, ['provisioning', 'waiting_for_mx', 'active'])))).map(row => row.name));
    const recipients = envelope.filter(address => hosts.has(host(address)));
    if (!recipients.length) throw new ApiError(422, 'FORWARD_RECIPIENT_UNKNOWN', 'No envelope recipient is on a domain that receives mail here. Nothing was stored.');
    const mid = `fwd-${await digest(forwarderId)}`;
    const [receipt] = await c.env.db.select({ recipients: mailReceipts.recipients, notification: mailReceipts.notification }).from(mailReceipts).where(and(eq(mailReceipts.workspaceId, wid), eq(mailReceipts.sesMessageId, mid)));
    if (receipt && recipients.every(address => receipt.recipients.includes(address))) return c.json({ accepted: true as const, duplicate: true, recipients }, 202);
    // With every recipient held there is no receipt yet: the hold alone knows which bytes this ID was accepted with.
    const accepted = receipt?.notification ?? (await c.env.db.execute<{ notification: unknown }>(sql`SELECT notification FROM mail_receipt_holds WHERE bucket=${FORWARD_BUCKET} AND ses_message_id=${mid}`)).rows[0]?.notification;
    await boundRequestBody(c, MAX_RAW_BYTES);
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (!raw.length) throw new ApiError(422, 'FORWARD_MESSAGE_EMPTY', 'The body must be the raw message.');
    // The first bytes accepted under an ID are the message: new recipients are added only to those same bytes.
    const hash = createHash('sha256').update(raw).digest('hex');
    if (accepted && (accepted as { sha256?: string }).sha256 !== hash) throw new ApiError(409, 'FORWARD_MESSAGE_CHANGED', 'This ID was accepted with a different message. Send another message under its own ID.');
    const stagingKey = forwardedStagingKey(wid, mid);
    await mailObjectsFor(c.env, wid, FORWARD_BUCKET).put(stagingKey, raw, 'message/rfc822');
    let queued: number;
    try { queued = await acceptForwardedReceipt(c.env, { mid, sender, recipients, stagingKey, sha256: hash }); }
    // A concurrent request for this ID, or a refusal, leaves a copy nothing reads: it is deleted like a settled one (592).
    finally { await c.env.db.execute(sql`SELECT public.mail_forwarded_staging_drop(${wid},${mid},${config.regions[0]!},${stagingKey})`); }
    try { await wakeReceivedMail(c.env, queued); } catch { /* the job is committed: the runner takes it */ }
    return c.json({ accepted: true as const, duplicate: false, recipients }, 202);
  });
  // An access proxy that can only bypass whole paths leaves every method here to this route (app.ts). Registered after POST.
  app.all(FORWARDED_MAIL_PATH, (c, next) => {
    if (!c.env.config.mailForwarderSecret) return next();
    c.header('Allow', 'POST');
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Forwarded mail takes POST only.');
  });
}
