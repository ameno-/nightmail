import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { postgresConnection } from '../src/adapters/node.js';
import { revokeBuiltinDomain } from '../src/builtin-domain.js';

// No API endpoint. Turns a workspace's built-in domain off for good (abuse): its sending and receiving stop at once, its
// label is never given out again, and the domain.builtin job removes the parent identity from the workspace's SES tenant.
// The workspace's own domains, its mail and its inboxes stay. A dry run shows the domain; --apply needs a reason, which is
// written to hosted_operator_audit with the signed-in operator.
//   node --import tsx scripts/builtin-domain.ts revoke WORKSPACE_ID [--apply --reason "why"]
if (import.meta.main) {
  const { positionals: [command, wid, ...rest], values: v } = parseArgs({ allowPositionals: true, options: { apply: { type: 'boolean' }, reason: { type: 'string' } } });
  if (command !== 'revoke' || !wid || rest.length || !/^ws_[0-9a-f]{32}$/.test(wid)) throw new Error('Usage: builtin-domain.ts revoke WORKSPACE_ID [--apply --reason "why"]');
  const reason = v.reason?.trim();
  if (v.apply && (!reason || reason.length < 10)) throw new Error('--apply needs --reason "why (at least 10 characters)"; it is written to hosted_operator_audit.');
  const db = new Client(postgresConnection(process.env.DATABASE_URL)); await db.connect();
  const sts = new STSClient({ ignoreConfiguredEndpointUrls: true, maxAttempts: 1 });
  try {
    const row = (await db.query('SELECT name,revoked_at FROM builtin_domains WHERE workspace_id=$1', [wid])).rows[0];
    if (!row) throw new Error('This workspace has no built-in domain.');
    if (!v.apply) { console.log(JSON.stringify({ workspace: wid, domain: row.name, revokedAt: row.revoked_at, action: row.revoked_at ? 'nothing (already revoked)' : 'revoke' }, null, 2)); process.exit(0); }
    const operator = (await sts.send(new GetCallerIdentityCommand({}))).Arn;
    if (!operator) throw new Error('No signed-in operator.');
    await db.query('BEGIN');
    const name = await revokeBuiltinDomain(drizzle(db), wid, reason!, operator);
    await db.query('COMMIT');
    console.log(JSON.stringify({ workspace: wid, domain: row.name, revoked: !!name }, null, 2));
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
  finally { await db.end(); sts.destroy(); }
}
