import { sql } from 'drizzle-orm';
import { log, type DbExecutor, type Runtime } from './core.js';

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
