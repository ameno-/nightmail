import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { postgresConnection } from '../src/adapters/node.js';
import { resetBuiltinBreaker, revokeBuiltinDomain } from '../src/builtin-domain.js';

// No API endpoint. Two operator actions on built-in domains; a dry run shows what would change, --apply needs a reason,
// which is written to hosted_operator_audit with the signed-in operator.
//
// revoke: turns a workspace's built-in domain off for good (abuse): its sending and receiving stop at once, its label is
// never given out again, and the domain.builtin job removes the parent identity from the workspace's SES tenant. The
// workspace's own domains, its mail and its inboxes stay.
//   node --import tsx scripts/builtin-domain.ts revoke WORKSPACE_ID [--apply --reason "why"]
//
// reset-breaker: turns built-in sending back on for every workspace after the parent's circuit breaker tripped (too many
// bounces or complaints across all built-in domains, builtin-domain.ts builtinBreaker). Find and revoke the senders behind
// it first. The next sweep checks the parent identity and verifies the domains again; the breaker counts only mail sent
// from the reset on. --parent defaults to NIGHTMAIL_BUILTIN_DOMAIN.
//   node --import tsx scripts/builtin-domain.ts reset-breaker [--parent nightmail.email] [--apply --reason "why"]
const usage = 'Usage: builtin-domain.ts revoke WORKSPACE_ID [--apply --reason "why"] | reset-breaker [--parent NAME] [--apply --reason "why"]';
if (import.meta.main) {
  const { positionals: [command, wid, ...rest], values: v } = parseArgs({ allowPositionals: true, options: { apply: { type: 'boolean' }, reason: { type: 'string' }, parent: { type: 'string' } } });
  const parent = (v.parent ?? process.env.NIGHTMAIL_BUILTIN_DOMAIN ?? '').trim().toLowerCase();
  if (command === 'revoke' ? !wid || rest.length || !/^ws_[0-9a-f]{32}$/.test(wid) || v.parent : command !== 'reset-breaker' || wid || !parent) throw new Error(usage);
  const reason = v.reason?.trim();
  if (v.apply && (!reason || reason.length < 10)) throw new Error('--apply needs --reason "why (at least 10 characters)"; it is written to hosted_operator_audit.');
  const db = new Client(postgresConnection(process.env.DATABASE_URL)); await db.connect();
  const sts = new STSClient({ ignoreConfiguredEndpointUrls: true, maxAttempts: 1 });
  try {
    const row = command === 'revoke'
      ? (await db.query('SELECT name,revoked_at FROM builtin_domains WHERE workspace_id=$1', [wid])).rows[0]
      : (await db.query('SELECT name,ok,problem,tripped_at,trip,reset_at FROM builtin_parent WHERE name=$1', [parent])).rows[0];
    if (!row) throw new Error(command === 'revoke' ? 'This workspace has no built-in domain.' : `No built-in domain parent ${parent} is recorded.`);
    if (!v.apply) {
      console.log(JSON.stringify(command === 'revoke' ? { workspace: wid, domain: row.name, revokedAt: row.revoked_at, action: row.revoked_at ? 'nothing (already revoked)' : 'revoke' }
        : { parent, trippedAt: row.tripped_at, trip: row.trip, lastReset: row.reset_at, action: row.tripped_at ? 'reset' : 'nothing (not tripped)' }, null, 2));
      process.exit(0);
    }
    const operator = (await sts.send(new GetCallerIdentityCommand({}))).Arn;
    if (!operator) throw new Error('No signed-in operator.');
    await db.query('BEGIN');
    if (command === 'revoke') {
      const name = await revokeBuiltinDomain(drizzle(db), wid!, reason!, operator);
      await db.query('COMMIT');
      console.log(JSON.stringify({ workspace: wid, domain: row.name, revoked: !!name }, null, 2));
    } else {
      const trip = await resetBuiltinBreaker(drizzle(db), parent, reason!, operator);
      await db.query('COMMIT');
      console.log(JSON.stringify({ parent, reset: !!trip, trip }, null, 2));
    }
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
  finally { await db.end(); sts.destroy(); }
}
