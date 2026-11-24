import { sql, type SQL } from 'drizzle-orm';
import { log, type Config, type Database, type DbExecutor, type JobHandler, type Runtime } from './core.js';
import { productName } from './brand.js';
import { JobDeferred, retryDatabaseFailures } from './jobs.js';
import type { ListContactResult } from './audience.js';

// The sign-up limit (hosted, migration 404): how many accounts may sign up on their own, set by an operator at
// Operator → Sign-ups (src/operator.ts). A place is taken by an account that signed up (nightmail_signups, one row per
// account, written in the transaction that creates it) or held for a waiting address an operator's raise let in
// (nightmail_waitlist.let_in_at). The sign-in gate, the operator's count and a raise all read `places` below, so the
// number an operator sees is the number the gate keeps. Staff, invitations and subjects an operator bound take none.

export type Places = { limit: number; signedUp: number; held: number; waiting: number; open: number };
/** The limit and what fills it, in one statement. Open: places left for anyone, after those held for the waitlist. */
export async function readPlaces(db: DbExecutor): Promise<Places> {
  const { rows: [row] } = await db.execute<Omit<Places, 'open'>>(sql`SELECT l.places AS "limit",(SELECT count(*)::int FROM nightmail_signups) AS "signedUp",
    (SELECT count(*)::int FROM nightmail_waitlist WHERE let_in_at IS NOT NULL) AS held,(SELECT count(*)::int FROM nightmail_waitlist WHERE let_in_at IS NULL) AS waiting
    FROM nightmail_signup_limit l WHERE l.singleton`);
  return { ...row!, open: Math.max(0, row!.limit - row!.signedUp - row!.held) };
}
// One sign-up or one change of the limit at a time. Read the places in a later statement: under READ COMMITTED each
// statement sees what the previous holder committed.
const lockLimit = (db: DbExecutor) => db.execute(sql`SELECT FROM nightmail_signup_limit WHERE singleton FOR UPDATE`);

/**
 * Whether a new account may sign up on its own, decided in the transaction that creates it (account-login.ts) from the
 * mailbox its sign-in proves (account-policy.ts provenMailbox), never an asserted address. A place held for that address
 * is taken (its waitlist row leaves); otherwise an open one is. An address that is already a verified user's takes none:
 * one place per person. The caller records the place with recordSignup once the user row exists.
 */
export async function takePlace(db: DbExecutor, mailbox: string): Promise<'waitlist' | 'open' | null> {
  await lockLimit(db);
  const address = mailbox.toLowerCase();
  if ((await db.execute(sql`SELECT FROM nightmail_users WHERE email_verified AND lower(email)=${address}`)).rowCount) return null;
  if ((await db.execute(sql`DELETE FROM nightmail_waitlist WHERE email=${address} AND let_in_at IS NOT NULL`)).rowCount) return 'waitlist';
  return (await readPlaces(db)).open > 0 ? 'open' : null;
}
export const recordSignup = (db: DbExecutor, userId: string, via: 'waitlist' | 'open') =>
  db.execute(sql`INSERT INTO nightmail_signups(user_id,via) VALUES(${userId},${via})`);

/**
 * Sets the limit. A raise holds the places it opens for the oldest waiting addresses (first attempt first); places
 * left over go to whoever signs in next. Lowering it removes nobody and keeps every held place. With the sign-ups list
 * on, the addresses let in are queued for it in the same statement.
 */
export async function setLimit(db: DbExecutor, limit: number, list: SignupsList | null = null) {
  await lockLimit(db);
  const before = await readPlaces(db);
  await db.execute(sql`UPDATE nightmail_signup_limit SET places=${limit} WHERE singleton`);
  const free = Math.max(0, limit - before.signedUp - before.held);
  const letIn = sql`UPDATE nightmail_waitlist w SET let_in_at=now() FROM (
      SELECT q.email FROM nightmail_waitlist q WHERE q.let_in_at IS NULL AND NOT EXISTS (SELECT FROM nightmail_users u WHERE u.email_verified AND lower(u.email)=q.email)
      ORDER BY q.first_at,q.email LIMIT ${free} FOR UPDATE OF q) oldest WHERE w.email=oldest.email RETURNING w.email`;
  const { rows } = free ? await db.execute<{ email: string }>(list ? sql`WITH let_in AS (${letIn}), queued AS (${queueSignupContacts(list, sql`SELECT email FROM let_in`)}) SELECT email FROM let_in` : letIn) : { rows: [] };
  return { before, after: await readPlaces(db), letIn: rows.map(row => row.email) };
}

/**
 * Whether a sign-in that proved no mailbox (GitHub, a password) could take a place by proving it: one is held for its
 * address, or one is open. Read without the lock: it only decides what the refusal says.
 */
export async function placeReady(db: DbExecutor, address: string) {
  if ((await db.execute(sql`SELECT FROM nightmail_waitlist WHERE email=${address.toLowerCase()} AND let_in_at IS NOT NULL`)).rowCount) return true;
  return (await readPlaces(db)).open > 0;
}

/**
 * Emails every held address not yet told that it can sign in (account-notices.ts waitlistAdmitted, one email per
 * address ever). Called after a change of the limit commits, never inside it, so an email can't undo or hold up a
 * raise, and it never throws. A second raise tells only the addresses it newly let in; saving the limit again tells
 * any a failure missed. emailed: queued now. notEmailed: held addresses still without one (null when unknown).
 */
export async function placesOpened(runtime: Runtime): Promise<{ emailed: number; notEmailed: number | null }> {
  let emailed = 0;
  try {
    const { waitlistAdmitted, waitlistNoticeStatus } = await import('./account-notices.js');
    const untold = sql`FROM nightmail_waitlist w WHERE w.let_in_at IS NOT NULL AND ${waitlistNoticeStatus(sql`w.email`)} IS NULL`;
    const { rows } = await runtime.db.execute<{ email: string }>(sql`SELECT w.email ${untold} ORDER BY w.let_in_at,w.first_at,w.email`);
    for (const { email } of rows) if (await waitlistAdmitted(runtime, runtime.db, email)) emailed++;
    const { rows: [left] } = await runtime.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n ${untold}`);
    if (emailed) log('info', { code: 'SIGNUP_PLACES_EMAILED', count: emailed });
    if (left!.n) log('warn', { code: 'SIGNUP_PLACES_NOT_EMAILED', count: left!.n });
    return { emailed, notEmailed: left!.n };
  } catch (error) {
    log('warn', { code: 'SIGNUP_PLACES_NOT_EMAILED', emailed, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    return { emailed, notEmailed: null };
  }
}

// The sign-ups list (hosted, NIGHTMAIL_SIGNUPS_LIST_ID): everyone who joins the waitlist or signs up is a contact of one
// list in the platform workspace, subscribed because they asked for access, with properties to segment by:
//   status         waiting, let_in (a raise holds a place for it) or signed_up (it has an account)
//   joined_at      its first attempt; let_in_at and signed_up_at: ISO 8601 in UTC, which sorts in time order
//   attempts       its sign-in attempts while it waited
//   email_domain   its address's domain, and mailbox: free (gmail.com, …) or company
// A sign-in, a raise and the backfill only queue a signups.contact job, in the statement that commits what changed or
// just after it, so a write that fails or is slow never reaches a sign-in. The job reads where each address stands then
// and writes its contact through the audience code (audience.ts upsertListContact): an opt-out stays an opt-out,
// suppression is never touched and a deleted contact stays deleted. A job reads a state at least as new as any earlier
// job's, so the last one leaves the contact right. Without the list or the platform workspace nothing is queued.
export type SignupsList = { workspaceId: string; listId: string };
export const signupsList = (config: Pick<Config, 'multiTenant' | 'platformDomainWorkspace' | 'signupsListId'>): SignupsList | null =>
  config.multiTenant && config.platformDomainWorkspace && config.signupsListId ? { workspaceId: config.platformDomainWorkspace, listId: config.signupsListId } : null;
/** An INSERT of the jobs that bring these addresses' contacts up to date; `emails` selects lowercased `email`s. 100 to a job. */
export const queueSignupContacts = (list: SignupsList, emails: SQL) => sql`INSERT INTO jobs(id,type,workspace_id,payload)
  SELECT public.row_id('job'),'signups.contact',${list.workspaceId},jsonb_build_object('emails',jsonb_agg(email ORDER BY email))
  FROM (SELECT email,(row_number() OVER (ORDER BY email)-1)/100 AS batch FROM (${emails}) e) b GROUP BY batch`;

const iso = (at: string) => new Date(at).toISOString();
/** A name as a contact's: one line of visible text with a letter, no address or link, at most 200 characters; else none. */
function contactName(raw: string | null | undefined) {
  const name = (raw ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  return /\p{L}/u.test(name) && !/@|:\/\/|www\./i.test(name) && name !== `${productName} user` ? name : null;
}
type Standing = { waiting: { name: string | null; attempts: number; joinedAt: string; letInAt: string | null } | null; account: { name: string; signedUpAt: string } | null };
/** One address's contact, from where it stands now: on the waitlist, let in, or with an account. Gone: neither. */
async function syncAddress(db: Database, list: SignupsList, address: string): Promise<ListContactResult | 'gone'> {
  const [{ upsertListContact }, { FREE_MAIL }] = await Promise.all([import('./audience.js'), import('./deliverability.js')]);
  return db.transaction(async tx => {
    // One job per address at a time, so what this one reads is at least as new as what an earlier one wrote.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${list.listId}:${address}`},40420))`);
    const { rows: [standing] } = await tx.execute<Standing>(sql`SELECT
      (SELECT json_build_object('name',w.name,'attempts',w.attempts,'joinedAt',w.first_at,'letInAt',w.let_in_at) FROM nightmail_waitlist w WHERE w.email=${address}) AS waiting,
      (SELECT json_build_object('name',u.name,'signedUpAt',coalesce(s.at,u.created_at)) FROM nightmail_users u LEFT JOIN nightmail_signups s ON s.user_id=u.id
        WHERE u.email_verified AND lower(u.email)=${address}) AS account`);
    const { waiting, account } = standing!;
    if (!waiting && !account) return 'gone';
    const domain = address.slice(address.lastIndexOf('@') + 1);
    return upsertListContact(tx, list, list.listId, {
      email: address, name: contactName(waiting?.name) ?? contactName(account?.name),
      properties: { status: account ? 'signed_up' : waiting!.letInAt ? 'let_in' : 'waiting', email_domain: domain, mailbox: FREE_MAIL.includes(domain) ? 'free' : 'company',
        ...waiting ? { joined_at: iso(waiting.joinedAt), attempts: waiting.attempts } : {}, ...waiting?.letInAt ? { let_in_at: iso(waiting.letInAt) } : {},
        ...account ? { signed_up_at: iso(account.signedUpAt) } : {} },
      // They asked for access: subscribed from when they first asked, unless they decided otherwise since.
      consent: waiting ? { source: `${productName} waitlist`, evidence: 'Asked for access by signing in with this verified address while sign-ups were closed, and joined the waitlist.', occurredAt: iso(waiting.joinedAt) }
        : { source: `${productName} sign-up`, evidence: 'Signed up for an account with this verified address.', occurredAt: iso(account!.signedUpAt) },
    });
  });
}
/** Counts only: addresses never reach a log. */
async function syncAddresses(runtime: Runtime, list: SignupsList, emails: string[]) {
  const counts: Partial<Record<ListContactResult | 'gone', number>> = {};
  for (const email of emails) {
    const result = await syncAddress(runtime.db, list, email);
    counts[result] = (counts[result] ?? 0) + 1;
    if (result === 'no_list') break;
  }
  if (counts.no_list) log('warn', { code: 'SIGNUPS_LIST_MISSING', workspaceId: list.workspaceId, listId: list.listId });
  else log('info', { code: 'SIGNUPS_LIST_SYNCED', workspaceId: list.workspaceId, ...counts });
}
// A job queued under a list that has since been turned off or moved changes nothing.
const listOf = (runtime: Runtime, workspaceId: string) => { const list = signupsList(runtime.config); return list?.workspaceId === workspaceId ? list : null; };
export const signupJobs: Record<string, JobHandler> = {
  'signups.contact': retryDatabaseFailures(async (runtime, payload, job) => {
    const list = listOf(runtime, job.workspaceId), emails = Array.isArray(payload.emails) ? payload.emails.filter((email): email is string => typeof email === 'string').slice(0, 100) : [];
    if (list) await syncAddresses(runtime, list, emails);
  }),
  // The backfill (scripts/sync-signups-list.ts): every address on the waitlist or with a sign-up, 100 a turn in address
  // order, the job coming back for the next 100. Running it again writes the same contacts again.
  'signups.backfill': retryDatabaseFailures(async (runtime, payload, job) => {
    const list = listOf(runtime, job.workspaceId), after = typeof payload.after === 'string' ? payload.after : '';
    if (!list) return;
    const { rows } = await runtime.db.execute<{ email: string }>(sql`SELECT email FROM (SELECT email FROM nightmail_waitlist WHERE email>${after} ORDER BY email LIMIT 100) w
      UNION SELECT email FROM (SELECT lower(u.email) AS email FROM nightmail_signups s JOIN nightmail_users u ON u.id=s.user_id WHERE u.email_verified AND lower(u.email)>${after}) s
      ORDER BY email LIMIT 100`);
    await syncAddresses(runtime, list, rows.map(row => row.email));
    if (rows.length === 100) throw new JobDeferred(new Date().toISOString(), { after: rows.at(-1)!.email });
  }),
};
