import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { OpenAPIHono as Base } from '@hono/zod-openapi';
import { observePg, observeRequest } from '../src/adapters/roundtrips.mjs';
export * from '@hono/zod-openapi';
const dir = new URL('../migrations/', import.meta.url), relations = new Set();
for (const file of readdirSync(dir).filter(f => f.endsWith('.sql'))) {
  const sql = readFileSync(new URL(file, dir), 'utf8');
  for (const m of sql.matchAll(/\b(?:create\s+(?:unlogged\s+|materialized\s+)?(?:table|view)|alter\s+table\s+\w+\s+rename\s+to)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:public\.)?"?([a-z_][a-z_0-9]*)/gi)) relations.add(m[1].toLowerCase());
}
observePg(relations);
const source = process.argv[1].endsWith('/src/server.ts') ? 'http' : process.argv[1].endsWith('/roundtrips-fixture.mjs') ? 'scenario' : 'fixture';
export class OpenAPIHono extends Base {
  constructor(...args) {
    super(...args);
    this.use('*', (c, next) => observeRequest(c, next, row => appendFileSync(process.env.NIGHTMAIL_ROUNDTRIPS,
      JSON.stringify({ ...row, source })+'\n', { mode: 0o600 })));
  }
}
