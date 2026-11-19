import { z } from '@hono/zod-openapi';
import { and, eq, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { ApiError, isoTime, redactCapabilityText, type DbExecutor, type MailboxAccess } from './core.js';
import { mailboxMessages as links, mailMessages as messages, retainedMail } from './db/mailbox.js';
import { snippetOf } from './mailbox-store.js';

// Which stored messages a reader sees, and an email's whole conversation: the thread block of getEmailDetail and
// getInboundMessage (includeThread=true), and the thread and its size on each listLogs row. Nothing heavier than the
// schemas, so the sending routes read it without loading the mailbox modules.
//
// A conversation is an inbox thread (mail_threads): its stored messages, received ones and the copy every mailbox send
// writes (mail_messages.sending_email_id), and the emails sent with sendEmail whose In-Reply-To header names one of
// them (mail_message_ids) and that have no copy of their own. A reader sees the messages it could read one by one:
// stored messages by its receiving access (accessibleMessages); those emails only with a workspace credential's mail
// access, which reads every sent email, and never with a key limited to addresses or an inbox, which reads no ordinary send.

export type Filter = { addressId?: string; threadId?: string; messageId?: string };
export const liveBox = (bid: SQLWrapper) => sql`NOT EXISTS(SELECT FROM mailboxes ended WHERE ended.id=${bid} AND ended.delete_after<=statement_timestamp())`;
export function visibleLinks(value: MailboxAccess, filter: Filter) {
  if (filter.addressId && value.mailboxIds && !value.mailboxIds.includes(filter.addressId)) throw new ApiError(404, 'NOT_FOUND', 'Address was not found.');
  return and(liveBox(links.mailboxId), sql`${links.heldReason} IS NULL`, eq(links.workspaceId, value.workspaceId),
    filter.addressId ? eq(links.mailboxId, filter.addressId) : value.mailboxIds ? inArray(links.mailboxId, value.mailboxIds) : undefined,
    filter.threadId ? eq(links.threadId, filter.threadId) : undefined, filter.messageId ? eq(links.messageId, filter.messageId) : undefined);
}
// Which stored messages a reader can see. Shared with the message reads and the unified logs (logs.ts), so every list
// applies the same rule. It names mail_messages and mailbox_messages unaliased: mail_messages is the row being read.
export const accessibleMessages = (v: MailboxAccess, f: Filter) => and(eq(messages.workspaceId, v.workspaceId),
  v.admin && !f.addressId ? retainedMail() : sql`EXISTS (SELECT 1 FROM ${links} WHERE ${visibleLinks(v, f)} AND ${links.messageId}=${messages.id})`);

// Mail sent from a receiving address or inbox is conversation mail: a reply can quote the message it answers and a
// forward carries it whole. The sending log lists and reads it only for credentials the receiving API lets read
// mailboxes (actorMailAccess). Rows queued before snapshots recorded their origin are known by their mailbox message.
// Names sending_emails unaliased.
export const mailboxMail = sql`(sending_emails.snapshot @> '{"mailbox":true}'::jsonb OR EXISTS (SELECT FROM mail_messages m WHERE m.workspace_id=sending_emails.workspace_id AND m.sending_email_id=sending_emails.id))`;
// NOT mailboxMail, spelled so its NOT EXISTS plans as an anti-join on mail_messages_sending, not a hash of every message.
const ordinaryMail = sql`NOT sending_emails.snapshot @> '{"mailbox":true}'::jsonb AND NOT EXISTS (SELECT FROM mail_messages m WHERE m.workspace_id=sending_emails.workspace_id AND m.sending_email_id=sending_emails.id)`;
// A sent email's In-Reply-To as stored Message-IDs are, without angle brackets: exactly the expression of the index
// sending_emails_in_reply_to (migration 349), which finds the emails that answer a thread's messages.
const inReplyTo = sql`btrim(jsonb_path_query_first(sending_emails.snapshot->'headers','$[*] ? (@.Name like_regex "^in-reply-to$" flag "i").Value')#>>'{}','<>')`;
// Emails sent with sendEmail that answer a message of the thread by their In-Reply-To header, without a mailbox copy.
const headerReplies = (workspaceId: string, thread: SQL | string) => sql`mail_messages p
  JOIN mail_message_ids i ON i.workspace_id=p.workspace_id AND i.message_id=p.message_id AND i.mail_message_id=p.id
  JOIN sending_emails ON sending_emails.workspace_id=p.workspace_id AND ${inReplyTo}=p.message_id
  WHERE p.workspace_id=${workspaceId} AND p.thread_id=${thread} AND p.message_id IS NOT NULL AND ${inReplyTo} IS NOT NULL AND ${ordinaryMail}`;

/** The thread of the sending_emails row being read (unaliased): its mailbox copy's, or that of the message its In-Reply-To names. */
export const sentThreadId = sql<string | null>`coalesce(
  (SELECT m.thread_id FROM mail_messages m WHERE m.workspace_id=sending_emails.workspace_id AND m.sending_email_id=sending_emails.id),
  (SELECT p.thread_id FROM mail_message_ids i JOIN mail_messages p ON p.id=i.mail_message_id WHERE i.workspace_id=sending_emails.workspace_id AND i.message_id=${inReplyTo} AND ${ordinaryMail}))`;

/** How many messages of a thread (a column) the reader sees, counted as readThread counts them: listLogs' threadCount. */
export const threadSize = (access: MailboxAccess, sends: boolean, thread: SQL) => sql<number>`((SELECT count(*) FROM mail_messages WHERE mail_messages.thread_id=${thread} AND ${accessibleMessages(access, {})})
  ${sends ? sql`+ (SELECT count(*) FROM ${headerReplies(access.workspaceId, thread)})` : sql``})::int`;

const WINDOW = 50;
const Address = z.object({ name: z.string().nullable(), address: z.string() });
export const ThreadMessage = z.object({
  id: z.string().describe('The stored message (getInboundMessage). An email sent with sendEmail that answers the conversation by its In-Reply-To header has no stored copy: its email ID.'),
  emailId: z.string().nullable().describe('The sent email (getEmailDetail) of an outbound message; null for received mail.'),
  direction: z.enum(['inbound', 'outbound']),
  from: Address,
  snippet: z.string(),
  at: z.string().describe('When it was received or sent.'),
  status: z.string().describe('Received mail: received. Sent mail: the email status (scheduled while it waits for its time).'),
  attachmentCount: z.number().int(),
}).openapi('ThreadMessage');
export const EmailThread = z.object({
  id: z.string().describe('The conversation (getInboundThread).'),
  count: z.number().int().describe('Messages in it that the caller can read.'),
  messages: z.array(ThreadMessage).describe(`Up to ${WINDOW} of them around this email, oldest first.`),
}).openapi('EmailThread');

type Row = { id: string; email_id: string | null; direction: 'inbound' | 'outbound'; from_name: string | null; from_address: string; snippet: string; at: string; status: string; attachment_count: number; text: string | null; html: string | null; sealed: boolean; total: number };
/**
 * The conversation of focus (a message or email ID) as access reads it, or null when it reads none of it. sends: also
 * the emails that answer it by header (a workspace credential with mail access, without an address filter). manage:
 * their snippets keep unsubscribe capabilities, as getEmailContent shows them.
 */
export async function readThread(db: DbExecutor, input: { access: MailboxAccess; threadId: string; focus: string; addressId?: string; sends: boolean; manage: boolean }): Promise<z.infer<typeof EmailThread> | null> {
  const { access, threadId, focus } = input;
  const stored = sql`SELECT mail_messages.id, mail_messages.sending_email_id AS email_id, mail_messages.direction, mail_messages.from_name, mail_messages.from_address, mail_messages.snippet,
      mail_messages.received_at AS at, mail_messages.status, mail_messages.attachment_count, NULL::text AS text, NULL::text AS html, false AS sealed
    FROM mail_messages WHERE mail_messages.thread_id=${threadId} AND ${accessibleMessages(access, { threadId, addressId: input.addressId })}`;
  const replies = sql`SELECT sending_emails.id, sending_emails.id AS email_id, 'outbound' AS direction, sending_emails.snapshot->>'fromName' AS from_name, sending_emails.from_address, '' AS snippet,
      sending_emails.created_at AS at, sending_emails.status, coalesce(jsonb_array_length(sending_emails.snapshot->'attachments'),0) AS attachment_count,
      left(sending_emails.snapshot->>'text',16384) AS text, left(sending_emails.snapshot->>'html',16384) AS html, coalesce((sending_emails.snapshot->>'sealed')::boolean,false) AS sealed
    FROM ${headerReplies(access.workspaceId, threadId)}`;
  // A long conversation keeps the messages around this one: up to half the window before it, and the rest after.
  const { rows } = await db.execute<Row>(sql`WITH visible AS (${stored}${input.sends ? sql` UNION ALL ${replies}` : sql``}),
    ordered AS (SELECT *, row_number() OVER (ORDER BY at, id) AS n, count(*) OVER () AS total FROM visible),
    place AS (SELECT coalesce(min(n) FILTER (WHERE id=${focus} OR email_id=${focus}), max(n)) AS n, max(total) AS total FROM ordered)
    SELECT ordered.id, ordered.email_id, ordered.direction, ordered.from_name, ordered.from_address, ordered.snippet, ordered.at::text AS at, ordered.status, ordered.attachment_count,
      ordered.text, ordered.html, ordered.sealed, place.total::int AS total
    FROM ordered, place WHERE ordered.n > greatest(0, least(place.n - ${WINDOW / 2}, place.total - ${WINDOW})) ORDER BY ordered.n LIMIT ${WINDOW}`);
  if (!rows.length) return null;
  return {
    id: threadId, count: rows[0]!.total,
    messages: rows.map(row => {
      // An email that answers by header has no stored snippet: it comes from what was sent, redacted as getEmailContent redacts it.
      const reply = row.email_id === row.id, snippet = reply ? row.sealed ? '' : snippetOf(row.text, row.html) : row.snippet;
      return { id: row.id, emailId: row.email_id, direction: row.direction, from: { name: row.from_name, address: row.from_address },
        snippet: reply && !input.manage ? redactCapabilityText(snippet) : snippet, at: isoTime(row.at)!, status: row.status, attachmentCount: row.attachment_count };
    }),
  };
}
