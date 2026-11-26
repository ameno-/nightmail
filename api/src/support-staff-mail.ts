import { createHash } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { errors, json, log, notFound, response, type App, type Config, type Database } from './core.js';
import { productName } from './brand.js';
import { htmlToPlain } from './mailbox-store.js';
import { renderNotice, type Line, type Notice } from './notices.js';
import { approvalLink, KINDS, propose } from './support-approvals.js';
import { supportPlatformOnly } from './support-conversations.js';
import { event, itemColumns, itemFrom, triageCandidates, TRIAGE_REASONS, type ItemRow } from './support-inbox.js';

// One path to a human. Whatever needs a person in support has a ticket and one email thread to staff: every conversation
// in Needs you (src/support-inbox.ts: an open ticket, held or failed answers, blocked work, a customer waiting on a paused
// agent, no reply sent; agent feedback, whose reports are tickets), and every email to a support address that never
// became a conversation and that nobody answered. A conversation without a ticket is given one here (type staff; the
// agent's own ticket, mirrored later, takes its place).
//
// The support platform asks for the emails on its sweep (POST /v1/operator/support/staff-mail, the binding only), sends
// each from the support address to the team address it keeps (TICKET_TO), and reports it sent: the first one in a thread
// starts it, later ones reply in it under the same subject. Each email is written here once and frozen, so a retried send
// is the same email under the same key. A thread's first email goes at once (one workspace's agent feedback waits five
// minutes, so a burst of reports is one email); after that it hears of something new (they wrote again, an answer was
// held, a new reason) at most every 30 minutes, and all of support sends staff at most 20 emails an hour.
//
// Each email is short and readable on a phone, in this order: who and which workspace; what they asked, in their own
// words (quoted as untrusted text: escaped, links shown with their real host and never made clickable); what the agent
// checked and found; the one decision, with the agent's recommendation; one link to the conversation. Where the
// decision is a yes or no on something proposed (src/support-approvals.ts), the button opens the conversation with it
// ready to confirm, and only a signed-in operator's confirm runs it.

const UPDATE_EVERY = 30, FEEDBACK_WINDOW = 60, FEEDBACK_SETTLE = 5, FEEDBACK_WAIT = 30, UNROUTED_AFTER = 30, UNROUTED_DAYS = 30;
export const STAFF_MAIL_LIMITS = { perHour: 20, batch: 20 } as const;

type Words = { text: string; at: string };
type Brief = { title: string; summary: string; ask: string; recommendation: string; tried?: { tool: string; finding: string }[] };
export type StaffRow = ItemRow & {
  brief: Brief | null; evidence: { filedBy?: string } | null; staff_thread: string | null; staff_seq: number; staff_reasons: string[]; role: string | null;
  max_seq: number; held_reason: string | null; held_seq: number | null; held_id: string | null; first_words: Words | null; fresh_words: Words[] | null;
  operation: string | null; request_id: string | null; filed_at: string | null; failed_by: 'agent' | 'staff' | null;
};
type Need = 'failed' | 'held' | 'no_reply' | 'blocked' | 'waiting' | 'ticket' | 'feedback';
type Thread = { key: string; subject: string; opened_at: string; last_sent_at: string | null; emails: number; pending: boolean };

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ticketId = () => `tkt_${Array.from(crypto.getRandomValues(new Uint8Array(16)), b => BASE32[b & 31]).join('')}`;
const emailKey = (thread: string, seq: number) => `staff-${createHash('sha256').update(thread).digest('hex').slice(0, 24)}-${seq}`;
/** Words someone else chose (a name, a title, a subject) on one line, without control characters, at most `max` long. */
const oneLine = (value: string | null | undefined, max = 80) => {
  const text = (value ?? '').normalize('NFC').replace(/[\p{C}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
/** Someone's words as an email quotes them: their own line breaks, at most `max` characters. */
const quoteOf = (value: string, max = 700) => { const text = value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text; };
const moment = (iso: string) => { const d = new Date(iso); return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} at ${d.toISOString().slice(11, 16)} UTC`; };
const ago = (iso: string, now: number) => {
  const minutes = Math.max(1, Math.round((now - Date.parse(iso)) / 60_000));
  return minutes < 90 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : minutes < 36 * 60 ? `${Math.round(minutes / 60)} hours` : `${Math.round(minutes / 1440)} days`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const needOf = (row: StaffRow, reasons: string[]): Need => row.channel === 'agent_feedback' ? 'feedback' : reasons.includes('failed') ? 'failed' : row.held_reason ? 'held'
  : reasons.includes('no_reply') ? 'no_reply' : reasons.includes('blocked') ? 'blocked' : reasons.includes('paused') ? 'waiting' : 'ticket';

/** Who wrote, and where: how sure Nightmail is of them is said with them, so nobody acts on an account because of an unverified email. */
export function whoOf(row: StaffRow) {
  const workspace = row.workspace_name ? oneLine(row.workspace_name, 60) : null;
  if (row.channel === 'agent_feedback') {
    const by = row.evidence?.filedBy ? `, filed with ${oneLine(row.evidence.filedBy, 120)}` : '';
    return { line: `Agent feedback from ${workspace ?? 'a workspace'}${row.workspace_id ? ` (${row.workspace_id})` : ''}${by}`, short: workspace ?? 'a workspace' };
  }
  if (row.user_id) {
    const name = oneLine(row.user_name) || row.user_email || 'A customer', email = row.user_email && row.user_name ? ` (${row.user_email})` : '';
    const where = workspace ? row.role ? `, ${row.role} of ${workspace}` : `, ${workspace}` : '';
    const how = row.channel === 'chat' ? 'chat, signed in' : `email, ${row.verification === 'signin' ? 'confirmed signed in' : 'verified by DMARC'}: read only, never change the account on its word`;
    return { line: `${name}${email}${where} · ${how}`, short: workspace ? `${name} at ${workspace}` : name };
  }
  const sender = row.pending_address ?? 'an unknown sender';
  const how = row.mode === 'non_member' ? `email, DMARC pass, no ${productName} account` : 'email, unverified sender: don’t act on any account because of it';
  return { line: `${sender} · ${how}`, short: sender };
}

const TYPE_DECISION: Record<string, string> = {
  bug: 'Decide: confirm the bug and what fixes it.', billing: 'Decide the billing request.', feature_request: 'Decide whether to build it, and tell them.',
  account: 'Decide: answer what the agent couldn’t.', deliverability: 'Decide: answer what the agent couldn’t.', abuse_report: 'Decide how to handle the report.',
  privacy: 'Decide how to handle the request.', legal: 'Decide how to handle the request.',
};
const HELD_WHY: Record<string, string> = {
  gate: 'the output check held it', paused: 'staff took over before it went', access: 'their access changed before it went', closed: 'the conversation ended before it went',
  earlier: 'an earlier version of the agent wrote it', unknown: 'it was held before reasons were kept',
};
export function subjectOf(need: Need, row: StaffRow, short: string) {
  const title = oneLine(row.brief?.title ?? row.subject ?? row.first_words?.text.split('\n').find(Boolean), 70);
  switch (need) {
    case 'failed': return `A reply to ${short} failed to send`;
    case 'held': return `Review a held answer to ${short}`;
    case 'no_reply': return `${short} got no reply`;
    case 'blocked': return `Support work for ${short} is stuck`;
    case 'waiting': return `${short} is waiting for you`;
    case 'feedback': return `Agent feedback from ${short}${title ? `: ${title}` : ''}`;
    case 'ticket': {
      const what = { bug: 'Bug report', billing: 'Billing decision', feature_request: 'Feature request', abuse_report: 'Abuse report', privacy: 'Privacy request', legal: 'Legal request' }[row.ticket_type ?? ''];
      return what ? `${what} from ${short}${title ? `: ${title}` : ''}` : `${short} needs an answer${title ? `: ${title}` : ''}`;
    }
  }
}

/** What the agent checked and found, and why this needs a person now: a sentence or two. */
function foundOf(need: Need, row: StaffRow, now: number): string[] {
  const lines: string[] = [];
  if (need === 'failed') lines.push(row.failed_by === 'staff' ? 'A staff reply to them failed to send.' : 'The agent’s answer to them failed to send.');
  if (need === 'held') lines.push(`The agent wrote an answer, but it wasn’t sent: ${HELD_WHY[row.held_reason ?? 'unknown'] ?? HELD_WHY.unknown}. It’s in the conversation, not in this email.`);
  if (need === 'no_reply' && row.since) lines.push(`Nothing has reached them since they wrote, ${ago(row.since, now)} ago.`);
  if (need === 'blocked') lines.push(`The support platform couldn’t finish ${plural(row.blocked_work, 'piece')} of work for this conversation.`);
  if (need === 'waiting') lines.push(row.paused_by === 'ticket' ? 'The agent stopped when it filed its ticket, and they are waiting.' : `${oneLine(row.paused_by_name) || 'Staff'} paused the agent, and they are waiting.`);
  if (row.brief?.summary) lines.push(`The agent’s summary: ${quoteOf(row.brief.summary, 300).replace(/\s+/g, ' ')}`);
  const tried = (row.brief?.tried ?? []).map(t => oneLine(t.tool, 40).replaceAll('_', ' ')).filter(Boolean);
  if (tried.length) lines.push(`It checked: ${[...new Set(tried)].slice(0, 6).join(', ')}.`);
  if (!row.brief && need !== 'held' && need !== 'feedback') lines.push('The agent left no summary.');
  return lines;
}
function decisionOf(need: Need, row: StaffRow): { decision: string; recommendation: string | null } {
  const recommended = row.brief?.recommendation ? `The agent recommends: ${quoteOf(row.brief.recommendation, 300).replace(/\s+/g, ' ')}` : null;
  switch (need) {
    case 'failed': return { decision: 'Decide: send the reply again, or write a new one.', recommendation: null };
    case 'held': return ['access', 'earlier', 'unknown'].includes(row.held_reason ?? 'unknown')
      ? { decision: 'Decide: write them a fresh reply.', recommendation: 'The held answer may be out of date: don’t send it as written.' }
      : { decision: 'Decide: send the held answer as written, or write your own.', recommendation: recommended ?? (row.held_reason === 'gate' ? 'Read it first: the check holds anything that names something outside the conversation.' : null) };
    case 'no_reply': return { decision: 'Decide: reply to them now.', recommendation: recommended };
    case 'blocked': return { decision: 'Decide: retry the stuck work, or look at why it’s stuck.', recommendation: null };
    case 'waiting': return { decision: 'Decide: reply to them, or hand the conversation back to the agent.', recommendation: recommended };
    case 'ticket': return { decision: TYPE_DECISION[row.ticket_type ?? ''] ?? 'Decide: answer them.', recommendation: recommended };
    case 'feedback': return { decision: 'Decide: is it a bug to fix, a gap in the docs, or neither? Mark it done when it’s handled.',
      recommendation: row.request_id ? 'Start with its request ID in the logs.' : null };
  }
}

/** What's new for a conversation since its last email, as one sentence. */
function changesOf(row: StaffRow, reasons: string[], now: number) {
  const parts: string[] = [];
  if (row.fresh_words?.length) parts.push(row.fresh_words.length === 1 ? 'they wrote again' : `they wrote ${row.fresh_words.length} more times`);
  if ((row.held_seq ?? 0) > row.staff_seq) parts.push('an answer was held');
  for (const reason of reasons.filter(r => !row.staff_reasons.includes(r))) {
    if (reason === 'no_reply' && row.since) parts.push(`no reply has reached them for ${ago(row.since, now)}`);
    if (reason === 'failed') parts.push('a reply failed to send');
    if (reason === 'blocked') parts.push('support work got stuck');
    if (reason === 'paused') parts.push('the agent is paused and they are waiting');
    if (reason === 'ticket' && row.ticket_type !== 'staff') parts.push('the agent filed a ticket');
  }
  return parts.length ? `Since the last email: ${parts.join(', ')}.` : 'Since the last email: it still needs you.';
}

/** A conversation's email: the thread's first (the whole case) or an update (what changed). */
export function conversationEmail(origin: string, row: StaffRow, reasons: string[], first: boolean, now: number, approval: { url: string; label: string } | null, subject: string): Notice {
  const need = needOf(row, reasons), who = whoOf(row), lines: Line[] = [{ text: who.line, tone: 'muted' }];
  if (!first) lines.push(changesOf(row, reasons, now));
  const words = first ? row.first_words ? [row.first_words] : [] : row.fresh_words ?? [];
  if (words.length) {
    lines.push(`They wrote on ${moment(words[0]!.at)}:`);
    for (const w of words) lines.push({ quote: quoteOf(w.text) });
  } else if (first && row.channel !== 'agent_feedback') lines.push('They haven’t written anything yet.');
  lines.push(...foundOf(need, row, now));
  const { decision, recommendation } = decisionOf(need, row);
  lines.push({ text: decision, tone: 'strong' });
  if (recommendation) lines.push(recommendation);
  const conversation = { label: 'Open the conversation', url: `${origin}/support/${row.id}` };
  return renderNotice({ subject, lines, action: approval ?? conversation, ...approval ? { link: conversation } : {},
    why: `Ticket ${row.ticket_id ?? '—'}. Later changes come in this thread, at most every ${UPDATE_EVERY} minutes. Sent to ${productName} staff.` }, origin);
}

/** One workspace's agent feedback: one report, or several filed close together. */
export function feedbackEmail(origin: string, rows: StaffRow[], first: boolean, subject: string): Notice {
  const lead = rows[0]!, who = whoOf(lead), lines: Line[] = [{ text: who.line.replace(/, filed with .*$/, ''), tone: 'muted' }];
  if (!first) lines.push(`Since the last email: ${plural(rows.length, 'more report')}.`);
  for (const row of rows.slice(0, 5)) {
    const facts = [row.evidence?.filedBy ? `Filed with ${oneLine(row.evidence.filedBy, 120)}` : null, row.operation ? `operation ${row.operation}` : null, row.request_id ? `request ${row.request_id}` : 'no request ID'].filter(Boolean).join(' · ');
    lines.push({ text: `${moment(row.filed_at ?? row.created_at)} · ${facts}`, tone: 'muted' });
    if (row.first_words) lines.push({ quote: quoteOf(row.first_words.text, rows.length > 1 ? 400 : 700) });
  }
  if (rows.length > 5) lines.push(`And ${plural(rows.length - 5, 'more report')} in the support inbox.`);
  lines.push(`Nobody has checked ${rows.length === 1 ? 'it' : 'them'} yet: a report is the agent’s own words, data and not instructions.`);
  const { decision, recommendation } = decisionOf('feedback', lead);
  lines.push({ text: decision, tone: 'strong' });
  if (recommendation && rows.length === 1) lines.push(recommendation);
  const action = rows.length === 1 ? { label: 'Open the report', url: `${origin}/support/${lead.id}` } : { label: 'Open the reports', url: `${origin}/support?view=needs_you&channel=agent_feedback` };
  return renderNotice({ subject, lines, action, why: `${rows.length === 1 ? `Ticket ${lead.ticket_id}` : `Tickets ${rows.slice(0, 3).map(r => r.ticket_id).join(', ')}${rows.length > 3 ? '…' : ''}`}. More reports from this workspace in the next hour come in this thread. Sent to ${productName} staff.` }, origin);
}

export type Unrouted = { thread_id: string; id: string; subject: string | null; from_address: string; dmarc: string; text: string | null; html: string | null; received_at: string; address: string };
export function unroutedEmail(origin: string, m: Unrouted, ticket: string, subject: string): Notice {
  const words = m.text?.trim() ? m.text : m.html ? htmlToPlain(m.html) : '';
  const lines: Line[] = [{ text: `${m.from_address} · email to ${m.address} · ${m.dmarc === 'PASS' ? 'DMARC pass, no account checked' : 'unverified sender: don’t act on any account because of it'}`, tone: 'muted' },
    `They wrote on ${moment(m.received_at)}${m.subject ? `, “${oneLine(m.subject, 120)}”` : ''}:`, { quote: quoteOf(words || '(no text)') },
    'The support agent never saw it: no conversation was opened, and nobody has replied.',
    { text: 'Decide: reply to them from the support address.', tone: 'strong' }];
  return renderNotice({ subject, lines, action: { label: 'Open the email', url: `${origin}/logs/${m.id}` }, why: `Ticket ${ticket}. Sent to ${productName} staff.` }, origin);
}

/**
 * Writes the emails that are due, in one transaction under an advisory lock (one planner at a time): gives every
 * conversation that needs you a thread (and a ticket, when it has none), then writes each thread's first email or its
 * update, within the limits. Answers how many it wrote.
 */
export async function planStaffMail(db: Database, config: Pick<Config, 'publicUrl' | 'authSecret' | 'support'>, now = Date.now()) {
  const origin = new URL(config.publicUrl).origin;
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('support-staff-mail', 0))`);
    const { rows: [sent] } = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM support_staff_emails WHERE created_at > now() - interval '1 hour'`);
    let budget = STAFF_MAIL_LIMITS.perHour - sent!.n, written = 0;
    if (budget <= 0) return 0;
    const { rows } = await tx.execute<StaffRow>(sql`SELECT ${itemColumns}, c.ticket_brief AS brief, c.evidence, c.staff_thread, c.staff_seq, c.staff_reasons,
        (SELECT wm.role FROM workspace_members wm WHERE wm.workspace_id = c.workspace_id AND wm.user_id = c.user_id LIMIT 1) AS role,
        coalesce((SELECT max(m.seq) FROM support_messages m WHERE m.conversation_id = c.id), 0) AS max_seq, held.reason AS held_reason, held.seq AS held_seq, held.id AS held_id,
        (SELECT json_build_object('text', left(m.text, 4000), 'at', m.created_at) FROM support_messages m WHERE m.conversation_id = c.id AND m.author = 'customer' ORDER BY m.seq LIMIT 1) AS first_words,
        (SELECT json_agg(json_build_object('text', left(x.text, 4000), 'at', x.created_at) ORDER BY x.seq) FROM (SELECT m.seq, m.text, m.created_at FROM support_messages m
          WHERE m.conversation_id = c.id AND m.author = 'customer' AND m.seq > c.staff_seq ORDER BY m.seq DESC LIMIT 3) x) AS fresh_words,
        f.operation, f.request_id, f.created_at::text AS filed_at,
        (SELECT m.author FROM support_messages m WHERE m.conversation_id = c.id AND m.delivery = 'failed' ORDER BY m.seq DESC LIMIT 1) AS failed_by
      FROM ${itemFrom('')}
      LEFT JOIN LATERAL (SELECT m.id, coalesce(m.held_reason, 'unknown') AS reason, m.seq FROM support_messages m WHERE m.conversation_id = c.id AND m.delivery = 'held' AND m.draft_outcome IS NULL
        AND m.seq > coalesce((SELECT max(s.seq) FROM support_messages s WHERE s.conversation_id = c.id AND s.author = 'staff' AND s.kind IS DISTINCT FROM 'note'), 0) ORDER BY m.seq DESC LIMIT 1) held ON true
      LEFT JOIN support_feedback f ON f.conversation_id = c.id
      WHERE ${triageCandidates} AND triage.needs_you ORDER BY triage.urgency, triage.since, c.id LIMIT 200`);
    const reasonsOf = (row: StaffRow) => TRIAGE_REASONS.filter(reason => row[`why_${reason}`]);
    const changed = (row: StaffRow) => !row.staff_thread || reasonsOf(row).some(r => !row.staff_reasons.includes(r)) || !!row.fresh_words?.length || (row.held_seq ?? 0) > row.staff_seq;

    // Every conversation that needs a person has a thread, and a ticket.
    for (const row of rows.filter(r => !r.staff_thread)) {
      let key = `conv:${row.id}`;
      if (row.channel === 'agent_feedback' && row.workspace_id) {
        const { rows: [open] } = await tx.execute<{ key: string }>(sql`SELECT key FROM support_staff_threads WHERE workspace_id = ${row.workspace_id} AND key LIKE 'feedback:%'
          AND opened_at > now() - make_interval(mins => ${FEEDBACK_WINDOW}) ORDER BY opened_at DESC LIMIT 1`);
        key = open?.key ?? `feedback:${row.workspace_id}:${row.id}`;
      }
      await tx.execute(sql`INSERT INTO support_staff_threads(key, subject, workspace_id) VALUES (${key}, '', ${row.channel === 'agent_feedback' ? row.workspace_id : null}) ON CONFLICT (key) DO NOTHING`);
      if (!row.ticket_id) {
        const id = ticketId(), severity = row.urgency <= 2 ? 'P2' : 'P3';
        const { rows: [opened] } = await tx.execute<{ id: string }>(sql`UPDATE support_conversations SET ticket_id = ${id}, ticket_type = 'staff', ticket_severity = ${severity}, ticket_at = now(),
            status = CASE WHEN status = 'open' THEN 'ticketed' ELSE status END WHERE id = ${row.id} AND ticket_id IS NULL RETURNING id`);
        // Its ticket is one of the reasons it needs you from now on, and this email names it.
        if (opened) { await tx.execute(event(row.id, 'ticket', null, { ticketId: id, type: 'staff', severity, by: 'nightmail' })); row.ticket_id = id; row.ticket_type = 'staff'; row.why_ticket = true; }
      }
      await tx.execute(sql`UPDATE support_conversations SET staff_thread = ${key} WHERE id = ${row.id}`);
      row.staff_thread = key;
    }

    const keys = [...new Set(rows.filter(changed).map(r => r.staff_thread!))];
    const { rows: threads } = keys.length ? await tx.execute<Thread>(sql`SELECT t.key, t.subject, t.opened_at::text AS opened_at, t.last_sent_at::text AS last_sent_at,
        (SELECT count(*)::int FROM support_staff_emails e WHERE e.thread_key = t.key) AS emails, EXISTS (SELECT FROM support_staff_emails e WHERE e.thread_key = t.key AND e.sent_at IS NULL) AS pending
      FROM support_staff_threads t WHERE t.key = ANY(${sql.param(keys)}::text[])`) : { rows: [] as Thread[] };
    const byKey = new Map(threads.map(t => [t.key, t]));
    for (const key of keys) {
      const thread = byKey.get(key);
      if (!thread || thread.pending || budget <= 0) continue;
      const members = rows.filter(r => r.staff_thread === key), first = thread.emails === 0;
      const due = first ? members : members.filter(changed);
      if (!due.length) continue;
      if (first && key.startsWith('feedback:')) {
        const newest = Math.max(...members.map(r => Date.parse(r.filed_at ?? r.created_at)));
        if (newest > now - FEEDBACK_SETTLE * 60_000 && Date.parse(thread.opened_at) > now - FEEDBACK_WAIT * 60_000) continue;
      }
      if (!first && thread.last_sent_at && Date.parse(thread.last_sent_at) > now - UPDATE_EVERY * 60_000) continue;
      let mail: Notice;
      if (key.startsWith('feedback:')) {
        const subject = first ? due.length === 1 ? subjectOf('feedback', due[0]!, whoOf(due[0]!).short) : `${due.length} agent feedback reports from ${whoOf(due[0]!).short}` : thread.subject;
        mail = feedbackEmail(origin, due, first, subject);
      } else {
        const row = due[0]!, reasons = reasonsOf(row), need = needOf(row, reasons);
        // A yes or no on something proposed: the button opens the conversation with it ready to confirm. A held answer
        // is proposed only when it may go as written (held by the check or a pause); one that needs a fresh reply isn't.
        const kind = need === 'blocked' ? 'retry_work' : need === 'held' && row.held_id && (row.held_reason === 'gate' || row.held_reason === 'paused') ? 'send_held_answer' : null;
        const approval = kind === 'retry_work' ? await propose(tx, { conversationId: row.id, kind, proposedBy: 'nightmail', reason: `The support platform couldn’t finish ${plural(row.blocked_work, 'piece')} of work.` })
          : kind === 'send_held_answer' ? await propose(tx, { conversationId: row.id, kind, proposedBy: 'nightmail', payload: { messageId: row.held_id }, reason: `The agent’s answer was held: ${HELD_WHY[row.held_reason ?? 'unknown']}.` }) : null;
        mail = conversationEmail(origin, row, reasons, first, now, approval && kind ? { label: KINDS[kind].label, url: approvalLink(config, approval) } : null, first ? subjectOf(need, row, whoOf(row).short) : thread.subject);
      }
      const seq = thread.emails + 1;
      await tx.execute(sql`INSERT INTO support_staff_emails(key, thread_key, seq, subject, text, html) VALUES (${emailKey(key, seq)}, ${key}, ${seq}, ${mail.subject}, ${mail.text}, ${mail.html})`);
      if (first) await tx.execute(sql`UPDATE support_staff_threads SET subject = ${mail.subject} WHERE key = ${key}`);
      for (const row of due) await tx.execute(sql`UPDATE support_conversations SET staff_seq = ${row.max_seq}, staff_reasons = ${sql.param(reasonsOf(row))}::text[] WHERE id = ${row.id}`);
      budget--; written++;
    }

    // Mail to a support address that never became a conversation, and nobody answered.
    const addressIds = config.support?.addressIds ?? [];
    if (addressIds.length && budget > 0) {
      const { rows: unrouted } = await tx.execute<Unrouted>(sql`SELECT * FROM (SELECT DISTINCT ON (m.thread_id) m.thread_id, m.id, m.subject, m.from_address, upper(coalesce(m.verdicts->>'dmarc', 'NONE')) AS dmarc,
          left(m.text, 4000) AS text, CASE WHEN m.text IS NULL THEN left(m.html, 200000) END AS html, m.received_at::text AS received_at, b.address
        FROM mailbox_messages mb JOIN mailboxes b ON b.id = mb.mailbox_id JOIN mail_messages m ON m.id = mb.message_id
        WHERE mb.mailbox_id = ANY(${sql.param(addressIds)}::text[]) AND mb.direction = 'inbound' AND m.thread_id IS NOT NULL AND NOT coalesce(m.automated, false) AND NOT coalesce(m.spam, false)
          AND m.received_at < now() - make_interval(mins => ${UNROUTED_AFTER}) AND m.received_at > now() - make_interval(days => ${UNROUTED_DAYS})
          AND NOT EXISTS (SELECT FROM support_messages s WHERE s.source_message_id = m.id)
          AND NOT EXISTS (SELECT FROM mail_messages o WHERE o.thread_id = m.thread_id AND o.direction = 'outbound')
          AND NOT EXISTS (SELECT FROM support_staff_threads t WHERE t.mail_thread_id = m.thread_id OR (t.sender = lower(m.from_address) AND t.opened_at > now() - interval '1 day'))
        ORDER BY m.thread_id, m.received_at) first ORDER BY received_at LIMIT ${budget}`);
      const senders = new Set<string>();
      for (const m of unrouted) {
        if (senders.has(m.from_address.toLowerCase())) continue;
        senders.add(m.from_address.toLowerCase());
        const key = `mail:${m.thread_id}`, ticket = ticketId(), subject = `Unanswered email to support${m.subject ? `: ${oneLine(m.subject, 70)}` : ''}`, mail = unroutedEmail(origin, m, ticket, subject);
        await tx.execute(sql`INSERT INTO support_staff_threads(key, subject, mail_thread_id, sender, ticket_id) VALUES (${key}, ${subject}, ${m.thread_id}, ${m.from_address.toLowerCase()}, ${ticket})`);
        await tx.execute(sql`INSERT INTO support_staff_emails(key, thread_key, seq, subject, text, html) VALUES (${emailKey(key, 1)}, ${key}, 1, ${mail.subject}, ${mail.text}, ${mail.html})`);
        budget--; written++;
      }
    }
    if (written) log('info', { code: 'SUPPORT_STAFF_MAIL_WRITTEN', emails: written });
    return written;
  });
}

const StaffEmail = z.object({
  key: z.string().describe('The send\u2019s Idempotency-Key: the same email under the same key on every try.'),
  threadId: z.string().nullable().describe('The thread to reply in (an update), or null to start one.'), replyToMessageId: z.string().nullable(),
  subject: z.string(), text: z.string(), html: z.string(),
}).openapi('SupportStaffEmail');
const Key = z.object({ key: z.string().regex(/^staff-[0-9a-f]{24}-[0-9]{1,6}$/) });

export function registerSupportStaffMail(app: App) {
  const security: Record<string, string[]>[] = [{ bearerAuth: [] }];
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/support/staff-mail', operationId: 'operatorSupportStaffMail',
    description: 'The support platform\u2019s sweep (the binding only): writes the staff emails that are due, then answers every one not yet sent, oldest first. Send each from the support address to the team, then report it sent.',
    responses: { 200: response(z.object({ data: z.array(StaffEmail) })), ...errors } }), async c => {
    await supportPlatformOnly(c);
    await planStaffMail(c.env.db, c.env.config);
    const { rows } = await c.env.db.execute<{ key: string; seq: number; subject: string; text: string; html: string; thread_id: string | null; last_message_id: string | null }>(sql`SELECT e.key, e.seq, e.subject, e.text, e.html, t.thread_id, t.last_message_id
      FROM support_staff_emails e JOIN support_staff_threads t ON t.key = e.thread_key WHERE e.sent_at IS NULL AND (e.seq = 1 OR t.thread_id IS NOT NULL)
      ORDER BY e.created_at, e.key LIMIT ${STAFF_MAIL_LIMITS.batch}`);
    return c.json({ data: rows.map(r => ({ key: r.key, threadId: r.seq > 1 ? r.thread_id : null, replyToMessageId: r.seq > 1 ? r.last_message_id : null, subject: r.subject, text: r.text, html: r.html })) }, 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/support/staff-mail/{key}/sent', operationId: 'operatorSupportStaffMailSent',
    description: 'The support platform sent this staff email (the binding only): its thread and message, so the thread\u2019s next email replies in it. Reporting it again changes nothing.',
    request: { params: Key, body: json(z.object({ threadId: z.string().min(1).max(120), messageId: z.string().min(1).max(120) }).strict()) },
    responses: { 200: response(z.object({ key: z.string(), sentAt: z.string() })), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const { key } = c.req.valid('param'), body = c.req.valid('json');
    const sentAt = await c.env.db.transaction(async tx => {
      const { rows: [email] } = await tx.execute<{ thread_key: string; sent_at: string; fresh: boolean }>(sql`UPDATE support_staff_emails SET sent_at = coalesce(sent_at, now()), message_id = coalesce(message_id, ${body.messageId})
        WHERE key = ${key} RETURNING thread_key, sent_at::text AS sent_at, message_id = ${body.messageId} AS fresh`);
      if (!email) notFound('Staff email');
      if (email!.fresh) await tx.execute(sql`UPDATE support_staff_threads SET thread_id = coalesce(thread_id, ${body.threadId}), last_message_id = ${body.messageId}, last_sent_at = ${email!.sent_at}::timestamptz WHERE key = ${email!.thread_key}`);
      return email!.sent_at;
    });
    return c.json({ key, sentAt: new Date(sentAt).toISOString() }, 200);
  });
}
