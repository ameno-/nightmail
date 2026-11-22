import { sql } from 'drizzle-orm';
import { log, type DbExecutor, type Runtime } from './core.js';

// The sign-up limit (hosted, migration 403): how many accounts may sign up on their own, set by an operator at
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
 * The addresses a raise just let in, once it has committed: each may now sign in. The email that tells them so comes
 * with the customer notices (emails/customer-notices) and is sent from here; until then nothing is sent.
 */
export async function placesOpened(_runtime: Runtime, emails: string[]) {
  if (emails.length) log('info', { code: 'SIGNUP_PLACES_HELD', count: emails.length });
}
