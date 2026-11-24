// On a disposable acceptance fixture: NIGHTMAIL_ROUNDTRIPS=/private/output.ndjson
// NODE_OPTIONS="--import=/absolute/worktree/api/scripts/roundtrips-preload.mjs" lab acc …
// Install only in the server and test processes, never the runner, issuer, migration or subprocesses.
import { registerHooks } from 'node:module';
const out = process.env.NIGHTMAIL_ROUNDTRIPS;
if (out && /\/(?:(?:src\/server|api\.acceptance\.test)\.ts|scripts\/roundtrips-fixture\.mjs)$/.test(process.argv[1] ?? '')) {
  const db = new URL(process.env.DATABASE_URL);
  if (process.env.ENABLE_LIVE_SES !== 'false' || !['127.0.0.1','localhost','[::1]'].includes(db.hostname) ||
      db.search || db.hash || !/^\/fixture(?:_sim)?$/.test(db.pathname) || !out.startsWith('/')) throw Error('SQL tracing requires an isolated loopback acceptance fixture');
  const shim = new URL('./roundtrips-hono.mjs', import.meta.url).href;
  // Add an outer middleware to the real app, including in-process acceptance fixtures. Production
  // never imports either the observer or this Node loader; no request header enables it.
  registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@hono/zod-openapi' && /\/src\/app\.[jt]s(?:\?|$)/.test(context.parentURL ?? '')) return { url: shim, shortCircuit: true };
    return next(specifier, context);
  } });
}
