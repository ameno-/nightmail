import { drizzle } from 'drizzle-orm/node-postgres';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { abuseSubject, userEntities, type Entity } from '../src/abuse.js';
import { postgresConnection } from '../src/adapters/node.js';
import { loadConfig } from '../src/config.js';
import { log } from '../src/core.js';

// What abuse monitoring (src/abuse.ts) holds about one user or workspace, for an access, objection or erasure request
// that privacy@ has verified. It shows kinds and counts, never values, and never another customer's data.
//   node --import tsx scripts/abuse-subject.ts --user USER_ID | --workspace WORKSPACE_ID [--erase | --exclude --reason "why" | --include]
// --user covers the user, the workspaces they own and their refused sign-ins. --erase deletes what is held. --exclude
// deletes it and stops recording (an upheld objection, or an agreement that rules monitoring out); --include undoes that.
// Needs DATABASE_URL and the installation's configuration (the root secret names a refused sign-in's entity).
export async function abuseSubjectCommand(db: Client, args: string[], env: Record<string, unknown> = process.env) {
  const { values } = parseArgs({ args, options: { user: { type: 'string' }, workspace: { type: 'string' }, erase: { type: 'boolean' }, exclude: { type: 'boolean' }, include: { type: 'boolean' }, reason: { type: 'string' } } });
  const actions = [values.erase && 'erase', values.exclude && 'exclude', values.include && 'include'].filter(Boolean) as ('erase' | 'exclude' | 'include')[], reason = values.reason?.trim();
  if (!values.user === !values.workspace || actions.length > 1 || (actions[0] === 'exclude' && (!reason || reason.length < 10)))
    throw new Error('Usage: abuse-subject.ts --user USER_ID | --workspace WORKSPACE_ID [--erase | --exclude --reason "why (at least 10 characters)" | --include]');
  const executor = drizzle(db), action = actions[0] ?? 'show';
  const entities: Entity[] = values.user ? await userEntities(executor, loadConfig(env), values.user) : [{ type: 'workspace', id: values.workspace! }];
  const result = await abuseSubject(executor, entities, action, reason);
  log('info', { code: 'ABUSE_SUBJECT', action, entities: entities.length, kinds: result.held.length, excluded: result.excluded });
  return result;
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { console.log(JSON.stringify(await abuseSubjectCommand(db, process.argv.slice(2)), null, 2)); } finally { await db.end(); }
}
