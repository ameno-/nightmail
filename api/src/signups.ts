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

type Waited = { name: string | null; attempts: number; first_at: string; let_in_at: string | null };
export type Place = { via: 'waitlist' | 'open'; mailbox: string; waited: Waited | null };
/**
 * Whether a new account may sign up on its own, decided in the transaction that creates it (account-login.ts) from the
 * mailbox its sign-in proves (account-policy.ts provenMailbox), never an asserted address. A place held for that address
 * is taken; otherwise an open one is. Either way the address leaves the waitlist here, and what its row said comes back
 * for recordSignup; a sign-in refused after all rolls the transaction back with the row. An address that is already a
 * verified user's takes none: one place per person. The caller records the place once the user row exists.
 */
export async function takePlace(db: DbExecutor, mailbox: string): Promise<Place | null> {
  await lockLimit(db);
  const address = mailbox.toLowerCase();
  if ((await db.execute(sql`SELECT FROM nightmail_users WHERE email_verified AND lower(email)=${address}`)).rowCount) return null;
  const { rows: [waited] } = await db.execute<Waited>(sql`DELETE FROM nightmail_waitlist WHERE email=${address} RETURNING name,attempts,first_at::text,let_in_at::text`);
  if (waited?.let_in_at) return { via: 'waitlist', mailbox: address, waited };
  return (await readPlaces(db)).open > 0 ? { via: 'open', mailbox: address, waited: waited ?? null } : null;
}
/**
 * The sign-up, with what the sign-ups list may say of it ever after: the mailbox this sign-in proved, the name it gave,
 * and the waitlist row it consumed (when it first asked, how often, when a raise let it in). Never read from the account
 * later: a changed address or name isn't the one that signed up.
 */
export const recordSignup = (db: DbExecutor, userId: string, place: Place, name: string | null) =>
  db.execute(sql`INSERT INTO nightmail_signups(user_id,via,email,name,joined_at,attempts,let_in_at) VALUES(${userId},${place.via},${place.mailbox},
    ${place.waited?.name ?? (name?.trim().slice(0, 200) || null)},${place.waited?.first_at ?? null}::timestamptz,${place.waited?.attempts ?? null},${place.waited?.let_in_at ?? null}::timestamptz)`);

/**
 * Sets the limit. A raise holds the places it opens for the oldest waiting addresses (first attempt first); places
 * left over go to whoever signs in next. Lowering it removes nobody and keeps every held place.
 */
export async function setLimit(db: DbExecutor, limit: number) {
  await lockLimit(db);
  const before = await readPlaces(db);
  await db.execute(sql`UPDATE nightmail_signup_limit SET places=${limit} WHERE singleton`);
  const free = Math.max(0, limit - before.signedUp - before.held);
  const { rows } = free ? await db.execute<{ email: string }>(sql`UPDATE nightmail_waitlist w SET let_in_at=now() FROM (
      SELECT q.email FROM nightmail_waitlist q WHERE q.let_in_at IS NULL AND NOT EXISTS (SELECT FROM nightmail_users u WHERE u.email_verified AND lower(u.email)=q.email)
      ORDER BY q.first_at,q.email LIMIT ${free} FOR UPDATE OF q) oldest WHERE w.email=oldest.email RETURNING w.email`) : { rows: [] };
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
//   status         waiting, let_in (a raise holds a place for it), signed_up (it took a place) or admitted (an
//                  invitation or staff let it in after it joined; nothing new is consented)
//   joined_at      its first attempt; let_in_at and signed_up_at: ISO 8601 in UTC, which sorts in time order
//   attempts       its sign-in attempts while it waited
//   email_domain   its address's domain, and mailbox: free (gmail.com, …) or company
// Nothing on the sign-in or raise path writes for it. A waitlist row is due when it changed since it was last written
// (last_at or let_in_at after list_synced_at), a sign-up until it has been written once; every minute signupsTick queues
// one signups.sync job while anything is due, and the job writes each due address and marks the version it wrote. The
// contact is written from the waitlist row or the sign-up record alone (recordSignup), never the account's profile,
// through the audience code (audience.ts upsertListContact): an opt-out stays an opt-out, suppression is never touched
// and a deleted contact stays deleted. Hourly, signups.reconcile marks admitted the contacts still waiting whose address
// got in another way. Jobs carry no address. Without the list or the platform workspace nothing is queued.
export type SignupsList = { workspaceId: string; listId: string };
export const signupsList = (config: Pick<Config, 'multiTenant' | 'platformDomainWorkspace' | 'signupsListId'>): SignupsList | null =>
  config.multiTenant && config.platformDomainWorkspace && config.signupsListId ? { workspaceId: config.platformDomainWorkspace, listId: config.signupsListId } : null;
const waitlistDue = sql`(list_synced_at IS NULL OR list_synced_at < greatest(last_at,let_in_at))`;
const signupDue = sql`(list_synced_at IS NULL AND email IS NOT NULL)`;
// One job per kind and workspace: queued again only once the last run has finished.
const queueRun = (list: SignupsList, kind: 'sync' | 'reconcile', when = sql`true`) => sql`INSERT INTO jobs(id,type,workspace_id,payload)
  SELECT ${`signups.${kind}:${list.workspaceId}`},${`signups.${kind}`},${list.workspaceId},'{}'::jsonb WHERE ${when}
  ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,lease_until=NULL,last_error=NULL,available_at=now() WHERE jobs.status IN ('completed','failed')`;
/** Every minute (worker cron, Node runner): a signups.sync run while any waitlist row or sign-up is due. Never throws. */
export async function signupsTick(runtime: Runtime) {
  const list = signupsList(runtime.config);
  if (!list) return;
  try { await runtime.db.execute(queueRun(list, 'sync', sql`EXISTS (SELECT FROM nightmail_waitlist WHERE ${waitlistDue}) OR EXISTS (SELECT FROM nightmail_signups WHERE ${signupDue})`)); }
  catch { log('warn', { code: 'SIGNUPS_LIST_NOT_QUEUED' }); }
}
/** Hourly (maintenance.ts): a signups.reconcile run. */
export async function queueSignupsReconcile(runtime: Runtime) {
  const list = signupsList(runtime.config);
  if (list) await runtime.db.execute(queueRun(list, 'reconcile'));
}

const iso = (at: string) => new Date(at).toISOString();
/** A name as a contact's: one line of visible text with a letter, no address or link, at most 200 characters; else none. */
function contactName(raw: string | null | undefined) {
  const name = (raw ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  return /\p{L}/u.test(name) && !/@|:\/\/|www\./i.test(name) && name !== `${productName} user` ? name : null;
}
const addressProperties = async (address: string) => {
  const domain = address.slice(address.lastIndexOf('@') + 1), { FREE_MAIL } = await import('./deliverability.js');
  return { email_domain: domain, mailbox: FREE_MAIL.includes(domain) ? 'free' : 'company' };
};
type Standing = { waiting: { name: string | null; attempts: number; joinedAt: string; letInAt: string | null; version: string } | null;
  signup: { name: string | null; joinedAt: string | null; attempts: number | null; letInAt: string | null; at: string } | null };
// One address at a time: what a run reads is at least as new as what an earlier one wrote. A transaction lock, so
// nothing is held on the waitlist or sign-up rows while the contact is written.
const lockAddress = (tx: DbExecutor, list: SignupsList, address: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${list.listId}:${address}`},40420))`);
/**
 * One address's contact, from where it stands now: a sign-up's own record, else its waitlist row. Returns the waitlist
 * row's version it saw (null: none) for the caller to mark once the contact has committed.
 */
async function syncAddress(db: Database, list: SignupsList, address: string): Promise<{ result: ListContactResult; version: string | null }> {
  const { upsertListContact } = await import('./audience.js'), byAddress = await addressProperties(address);
  return db.transaction(async tx => {
    await lockAddress(tx, list, address);
    const { rows: [standing] } = await tx.execute<Standing>(sql`SELECT
      (SELECT json_build_object('name',w.name,'attempts',w.attempts,'joinedAt',w.first_at,'letInAt',w.let_in_at,'version',greatest(w.last_at,w.let_in_at)) FROM nightmail_waitlist w WHERE w.email=${address}) AS waiting,
      (SELECT json_build_object('name',s.name,'joinedAt',s.joined_at,'attempts',s.attempts,'letInAt',s.let_in_at,'at',s.at) FROM nightmail_signups s WHERE s.email=${address} ORDER BY s.at LIMIT 1) AS signup`);
    const { waiting, signup } = standing!;
    if (signup) {
      // They asked on the waitlist first when the sign-up consumed a row; else signing up was the asking.
      const result = await upsertListContact(tx, list, list.listId, { email: address, name: contactName(signup.name),
        properties: { status: 'signed_up', ...byAddress, signed_up_at: iso(signup.at), ...signup.joinedAt ? { joined_at: iso(signup.joinedAt) } : {},
          ...signup.attempts !== null ? { attempts: signup.attempts } : {}, ...signup.letInAt ? { let_in_at: iso(signup.letInAt) } : {} },
        consent: signup.joinedAt ? waitlistConsent(signup.joinedAt) : { source: `${productName} sign-up`, evidence: 'Signed up for an account with this verified address.', occurredAt: iso(signup.at) } });
      return { result, version: waiting?.version ?? null };
    }
    if (!waiting) return { result: 'gone' as const, version: null };
    const result = await upsertListContact(tx, list, list.listId, { email: address, name: contactName(waiting.name),
      properties: { status: waiting.letInAt ? 'let_in' : 'waiting', ...byAddress, joined_at: iso(waiting.joinedAt), attempts: waiting.attempts, ...waiting.letInAt ? { let_in_at: iso(waiting.letInAt) } : {} },
      consent: waitlistConsent(waiting.joinedAt) });
    return { result, version: waiting.version };
  });
}
// They asked for access: subscribed from when they first asked, unless they decided otherwise since.
const waitlistConsent = (joinedAt: string) => ({ source: `${productName} waitlist`, evidence: 'Asked for access by signing in with this verified address while sign-ups were closed, and joined the waitlist.', occurredAt: iso(joinedAt) });

const BATCH = 100, RUN_MS = 10_000;
type Counts = Partial<Record<ListContactResult, number>>;
const count = (counts: Counts, result: ListContactResult) => { counts[result] = (counts[result] ?? 0) + 1; };
/** Counts only: addresses never reach a log. A missing list stops the run; the next one tries again. */
function logRun(list: SignupsList, kind: string, counts: Counts) {
  if (counts.no_list) log('warn', { code: 'SIGNUPS_LIST_MISSING', workspaceId: list.workspaceId, listId: list.listId });
  else log('info', { code: 'SIGNUPS_LIST_SYNCED', workspaceId: list.workspaceId, kind, ...counts });
}
// A run queued under a list that has since been turned off or moved changes nothing.
const listOf = (runtime: Runtime, workspaceId: string) => { const list = signupsList(runtime.config); return list?.workspaceId === workspaceId ? list : null; };
const more = () => new JobDeferred(new Date().toISOString());
export const signupJobs: Record<string, JobHandler> = {
  // Due sign-ups, then due waitlist rows, 100 at a time, for up to ten seconds a run; it comes back while more are due.
  'signups.sync': retryDatabaseFailures(async (runtime, _payload, job) => {
    const list = listOf(runtime, job.workspaceId), until = Date.now() + RUN_MS, counts: Counts = {};
    if (!list) return;
    try {
      for (;;) {
        const { rows: signups } = await runtime.db.execute<{ user_id: string; email: string }>(sql`SELECT user_id,email FROM nightmail_signups WHERE ${signupDue} ORDER BY at LIMIT ${BATCH}`);
        const { rows: waiting } = signups.length ? { rows: [] } : await runtime.db.execute<{ email: string }>(sql`SELECT email FROM nightmail_waitlist WHERE ${waitlistDue} ORDER BY first_at,email LIMIT ${BATCH}`);
        if (!signups.length && !waiting.length) return;
        for (const row of signups) {
          const { result } = await syncAddress(runtime.db, list, row.email);
          if (result === 'no_list') return;
          count(counts, result);
          await runtime.db.execute(sql`UPDATE nightmail_signups SET list_synced_at=now() WHERE user_id=${row.user_id}`);
        }
        for (const row of waiting) {
          const { result, version } = await syncAddress(runtime.db, list, row.email);
          if (result === 'no_list') return;
          count(counts, result);
          // The version written: a row changed meanwhile stays due.
          if (version) await runtime.db.execute(sql`UPDATE nightmail_waitlist SET list_synced_at=${version}::timestamptz WHERE email=${row.email} AND (list_synced_at IS NULL OR list_synced_at<${version}::timestamptz)`);
        }
        if (Date.now() > until) throw more();
      }
    } finally { if (Object.keys(counts).length) logRun(list, 'sync', counts); }
  }),
  // Contacts still waiting or let in whose address left the waitlist without a sign-up, because an invitation, staff or
  // an operator's binding let its account in: status admitted, and nothing else about them changes.
  'signups.reconcile': retryDatabaseFailures(async (runtime, _payload, job) => {
    const list = listOf(runtime, job.workspaceId), until = Date.now() + RUN_MS, counts: Counts = {};
    if (!list) return;
    const { upsertListContact } = await import('./audience.js');
    const admitted = (address: SQL) => sql`NOT EXISTS (SELECT FROM nightmail_waitlist w WHERE w.email=${address}) AND NOT EXISTS (SELECT FROM nightmail_signups s WHERE s.email=${address})
      AND EXISTS (SELECT FROM nightmail_users u WHERE u.email_verified AND lower(u.email)=${address})`;
    try {
      for (;;) {
        const { rows } = await runtime.db.execute<{ email: string }>(sql`SELECT c.email FROM audience_list_members m JOIN audience_contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
          WHERE m.workspace_id=${list.workspaceId} AND m.list_id=${list.listId} AND c.deleted_at IS NULL AND c.properties->>'status' IN ('waiting','let_in') AND ${admitted(sql`c.email`)}
          ORDER BY c.email LIMIT ${BATCH}`);
        let changed = 0;
        for (const { email } of rows) {
          const result = await runtime.db.transaction(async tx => {
            await lockAddress(tx, list, email);
            if (!(await tx.execute(sql`SELECT WHERE ${admitted(sql`${email}`)}`)).rowCount) return 'gone' as const;
            return upsertListContact(tx, list, list.listId, { email, name: null, properties: { status: 'admitted' } });
          });
          if (result === 'no_list') return;
          count(counts, result);
          if (result === 'updated') changed++;
        }
        if (rows.length < BATCH || !changed) return;
        if (Date.now() > until) throw more();
      }
    } finally { if (Object.keys(counts).length) logRun(list, 'reconcile', counts); }
  }),
};
