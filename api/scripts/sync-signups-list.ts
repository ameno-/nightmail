// Operator-only: writes the sign-ups list (src/signups.ts) again from the start. Every waitlist row and every sign-up
// recorded with its mailbox is marked due, and the installation's runner writes them within minutes, 100 at a time. The
// first sync needs none of this: rows start due. Use it after pointing NIGHTMAIL_SIGNUPS_LIST_ID at another list.
//
//   node --import tsx scripts/sync-signups-list.ts
//
// Env: DATABASE_URL. Safe to run again: each run writes the same contacts. It prints counts, never addresses.
import pg from 'pg';
import { postgresConnection } from '../src/adapters/node.js';

export async function resyncSignupsList(db: pg.Client | pg.Pool) {
  // Page by immutable source key. A busy row is retried alone after the page commits:
  // never hold locks on other admissions while waiting for a sign-in on one address.
  async function reset(table: 'nightmail_waitlist' | 'nightmail_signups', key: 'email' | 'user_id') {
    let after = '', marked = 0;
    for (;;) {
      const { rows } = await db.query<{ id: string; reset: boolean }>(`WITH page AS MATERIALIZED (
        SELECT ${key} AS id FROM ${table} WHERE ${key}>$1 AND list_synced_at IS NOT NULL ORDER BY ${key} LIMIT 250
      ), locked AS (SELECT s.${key} AS id FROM ${table} s JOIN page p ON p.id=s.${key}
        WHERE s.list_synced_at IS NOT NULL ORDER BY s.${key} FOR UPDATE OF s SKIP LOCKED
      ), done AS (UPDATE ${table} s SET list_synced_at=NULL FROM locked l WHERE s.${key}=l.id RETURNING s.${key} AS id)
      SELECT p.id, d.id IS NOT NULL AS reset FROM page p LEFT JOIN done d USING(id) ORDER BY p.id`, [after]);
      for (const row of rows) marked += row.reset ? 1 : (await db.query(`UPDATE ${table} SET list_synced_at=NULL WHERE ${key}=$1 AND list_synced_at IS NOT NULL`, [row.id])).rowCount ?? 0;
      if (rows.length < 250) return marked;
      after = rows[rows.length - 1]!.id;
    }
  }
  const waitlist = await reset('nightmail_waitlist','email'), signups = await reset('nightmail_signups','user_id');
  const { rows: [due] } = await db.query<{ waitlist: number; signups: number }>(`SELECT (SELECT count(*)::int FROM nightmail_waitlist WHERE list_synced_at IS NULL) AS waitlist,
    (SELECT count(*)::int FROM nightmail_signups WHERE list_synced_at IS NULL AND email IS NOT NULL) AS signups`);
  return { marked: { waitlist, signups }, due: due! };
}

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error('Usage: sync-signups-list.ts');
  const db = new pg.Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try {
    const { due } = await resyncSignupsList(db);
    console.log(`Due for the sign-ups list: ${due.waitlist} waitlist addresses and ${due.signups} sign-ups. The runner writes them within minutes.`);
  } finally { await db.end(); }
}
