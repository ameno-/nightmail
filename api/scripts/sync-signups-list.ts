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
  const waitlist = (await db.query('UPDATE nightmail_waitlist SET list_synced_at=NULL WHERE list_synced_at IS NOT NULL')).rowCount ?? 0;
  const signups = (await db.query('UPDATE nightmail_signups SET list_synced_at=NULL WHERE list_synced_at IS NOT NULL AND email IS NOT NULL')).rowCount ?? 0;
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
