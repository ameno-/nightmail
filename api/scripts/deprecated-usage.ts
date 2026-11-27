// DATABASE_URL=<read replica> bun scripts/deprecated-usage.ts production  (or dev).
// Calls and distinct workspaces in the last 30 completed UTC days. The nightly report checks
// the independent, unsampled loss log before its retention expires. A missing day is unknown.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { retiringOperations } from '../src/deprecation.js';

const stage = process.argv[2];
if (stage !== 'production' && stage !== 'dev') throw new Error('Usage: bun scripts/deprecated-usage.ts production|dev');
const dir = process.env.NIGHTLY_REPORT_DIR ?? join(homedir(), '.config/opensend-mx/reports');
const dayMs = 86_400_000;
const end = Math.floor(Date.now() / dayMs) * dayMs, start = end - 30 * dayMs;
const date = (time: number) => new Date(time).toISOString().slice(0, 10);
const unverified: string[] = [];
let loggedLostWrites = 0;
const expected = new Map<string, number>();
for (let at = start; at < end; at += dayMs) {
  const day = date(at);
  try {
    const audit = JSON.parse(await readFile(join(dir, 'deprecated-usage', stage, day + '.json'), 'utf8'));
    if (audit.stage !== stage || audit.day !== day || !Number.isSafeInteger(audit.lostWrites) || audit.lostWrites < 0 || !Number.isSafeInteger(audit.attempts) || audit.attempts < 0) throw new Error('Invalid loss audit');
    loggedLostWrites += audit.lostWrites;
    expected.set(day, audit.attempts);
  } catch { unverified.push(day); }
}
const db = new Client(postgresConnection(process.env.DATABASE_URL));
await db.connect();
try {
  const tracked = await db.query("SELECT applied_at FROM nightmail_migrations WHERE name='584_deprecated_call_days.sql'");
  const predatesCounter = !tracked.rows[0] || new Date(tracked.rows[0].applied_at).getTime() > start;
  const days = await db.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, sum(calls)::text AS calls
    FROM deprecated_call_days WHERE day >= $1 AND day < $2 GROUP BY day`, [date(start), date(end)]);
  // An isolate can disappear before its failed write logs. Its original request line also
  // records the attempt, independently of Postgres. Never promote a disagreement to an exact total.
  const mismatches = [...expected].filter(([day, attempts]) => BigInt(attempts) !== BigInt(days.rows.find(r => r.day === day)?.calls ?? 0))
    .map(([day, attempts]) => ({ day, attempts, recordedCalls: days.rows.find(r => r.day === day)?.calls ?? '0' }));
  const counts = await db.query(`SELECT operation, sum(calls)::text AS calls, count(DISTINCT NULLIF(workspace_id,''))::int AS workspaces
    FROM deprecated_call_days WHERE day >= $1 AND day < $2 GROUP BY operation`, [date(start), date(end)]);
  const operations = Array.from(retiringOperations.keys(), operation => {
    const row = counts.rows.find(row => row.operation === operation);
    return { operation, recordedCalls: row?.calls ?? '0', distinctRecordedWorkspaces: row?.workspaces ?? 0 };
  });
  console.log(JSON.stringify({ from: date(start), toExclusive: date(end), timezone: 'UTC',
    status: loggedLostWrites || mismatches.length || unverified.length || predatesCounter ? 'incomplete' : 'complete',
    loggedLostWrites, mismatches, unverifiedDays: unverified, predatesCounter, operations }, null, 2));
} finally { await db.end(); }
