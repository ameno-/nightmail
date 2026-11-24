// Operator-only: queues the sign-ups list's backfill (src/signups.ts). Every address on the waitlist or with a sign-up
// becomes, or is brought up to date as, a contact of NIGHTMAIL_SIGNUPS_LIST_ID. The installation's own runner does the
// work, 100 addresses a turn; this only queues the job.
//
//   node --import tsx scripts/sync-signups-list.ts WORKSPACE_ID
//
// Env: DATABASE_URL. WORKSPACE_ID is NIGHTMAIL_PLATFORM_DOMAIN_WORKSPACE: the job writes nothing unless the installation
// has that workspace and NIGHTMAIL_SIGNUPS_LIST_ID set. Safe to run again: while the backfill runs, queuing it changes
// nothing, and once it has finished a new run writes the same contacts again. It prints counts, never addresses.
import pg from 'pg';
import { postgresConnection } from '../src/adapters/node.js';

export async function queueSignupsBackfill(db: pg.Client | pg.Pool, workspaceId: string) {
  const { rowCount } = await db.query(`INSERT INTO jobs(id,type,workspace_id,payload) VALUES('signups.backfill:'||$1,'signups.backfill',$1,'{}')
    ON CONFLICT(id) DO UPDATE SET payload='{}',status='pending',attempts=0,lease_until=NULL,last_error=NULL,available_at=now() WHERE jobs.status IN ('completed','failed')`, [workspaceId]);
  const { rows: [count] } = await db.query<{ waitlist: number; signups: number }>(`SELECT (SELECT count(*)::int FROM nightmail_waitlist) AS waitlist,
    (SELECT count(*)::int FROM nightmail_signups s JOIN nightmail_users u ON u.id=s.user_id WHERE u.email_verified) AS signups`);
  return { queued: !!rowCount, ...count! };
}

if (import.meta.main) {
  const workspaceId = process.argv[2] ?? '';
  if (process.argv.length !== 3 || !/^ws_[0-9a-f]{32}$/.test(workspaceId)) throw new Error('Usage: sync-signups-list.ts WORKSPACE_ID (the platform workspace, ws_…)');
  const db = new pg.Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try {
    const { queued, waitlist, signups } = await queueSignupsBackfill(db, workspaceId);
    console.log(`${queued ? 'Queued the backfill' : 'The backfill is already queued or running'}: ${waitlist} waitlist addresses and ${signups} sign-ups.`);
  } finally { await db.end(); }
}
