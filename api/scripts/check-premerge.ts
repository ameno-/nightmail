// Pre-merge invariants that broke dev only after merge. Fast and offline except the open-PR scan.
//   node --import tsx scripts/check-premerge.ts [--base <sha>]
// --base is the commit this change lands on (the PR's base tip, the merge group's base, or the previous dev tip).
// Locally it defaults to the merge-base with dev. Set GH_TOKEN, GITHUB_REPOSITORY and PR_NUMBER to also compare
// migration numbers with other open pull requests. docs/ci.md explains each failure and how to fix it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';

const api = new URL('../', import.meta.url), root = new URL('../', api);
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const tryGit = (...args: string[]) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const argBase = process.argv.indexOf('--base');
const base = argBase > 0 ? git('rev-parse', '--verify', `${process.argv[argBase + 1]}^{commit}`)
  : ['origin/dev', 'bane/dev', 'dev'].map(ref => tryGit('merge-base', 'HEAD', ref)).find(Boolean) ?? null;
const atBase = (path: string) => base ? tryGit('show', `${base}:${path}`) : null;
let failed = 0;
// GitHub annotations: the message shows on the PR's Files tab and in the job summary.
function fail(check: string, message: string, file?: string, line?: number) {
  failed++;
  const where = file ? ` file=${file}${line ? `,line=${line}` : ''}` : '';
  console.log(`::error${where},title=${check}::${message.replaceAll('\n', '%0A')}`);
}
const warn = (check: string, message: string, file?: string) => console.log(`::warning${file ? ` file=${file}` : ''},title=${check}::${message}`);

// 1. Every OpenAPI operation is called or explicitly skipped in the live E2E (dev deploys broke twice on this).
// The live run enforces it again at the end; this catches it before merge. A string literal ('op'), an object
// key (op: 'reason') or SKIP.op in scripts/e2e.ts counts; comments do not.
{
  const spec = JSON.parse(readFileSync(new URL('openapi.json', api), 'utf8')) as { paths: Record<string, Record<string, { operationId?: string }>> };
  const operations = Object.values(spec.paths).flatMap(item => Object.values(item)).map(op => op.operationId).filter((id): id is string => !!id);
  const file = 'api/scripts/e2e.ts', source = ts.createSourceFile(file, readFileSync(new URL('scripts/e2e.ts', api), 'utf8'), ts.ScriptTarget.Latest, true);
  const named = new Set<string>(), called = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) named.add(node.text);
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'api' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) called.add(node.arguments[0].text);
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) named.add(node.name.text);
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === 'SKIP') named.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const missing = operations.filter(op => !named.has(op));
  for (const op of missing) fail('E2E coverage', `${op} is in openapi.json but neither called nor skipped in the live dev E2E, which fails the dev deploy after merge. Call it in a step with api('${op}', …), or add it to SKIP with the reason it cannot run against dev.`, file);
  // Behaviour a release has to prove live, where a skip doesn't count: these are called with api('…') in a dev step.
  // Every address is an inbox (#362): a temporary address's mail and folders through the inbox routes, by its address ID.
  const live = ['listInboxMessages', 'getInboxMessage', 'listInboxFolders', 'getInboxChanges', 'updateInboxMessage', 'copyInboxMessage', 'moveInboxMessage', 'deleteInboxMessage', 'expungeInboxFolder'];
  for (const op of live.filter(op => !called.has(op))) fail('E2E coverage', `${op} must run in the live dev E2E, not only be skipped: an address's mail through the inbox routes is proven there. Call it with api('${op}', …) in a dev step.`, file);
  console.log(`E2E coverage: ${operations.length - missing.length}/${operations.length} operations called or skipped in ${file}; ${live.filter(op => called.has(op)).length}/${live.length} required live operations called.`);
}

// 2. Cloudflare routing. Workers Assets answers any path outside run_worker_first itself (405 for POST, the SPA's
// index.html for GET), so a route missing there is unreachable on Cloudflare while the Node server still serves it.
// The Worker's own fetch also hands GET/HEAD outside its API prefixes to the assets binding.
{
  const before = failed, { createOpenApiApp } = await import('../src/app.js');
  const glob = (p: string) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*') + '$');
  const routes = (await createOpenApiApp()).routes.filter(r => r.path !== '*' && r.path !== '/*');
  const paths = [...new Set(routes.map(r => r.path.replace(/:[^/]+/g, 'x').replaceAll('*', 'x')))];
  if (!paths.includes('/internal/v1/mail') || !paths.includes('/v1/emails')) fail('Worker routes', 'The route inventory from createOpenApiApp() is incomplete; this check needs updating.');
  const configs: Record<string, { assets: { run_worker_first: string[] } }> = {};
  for (const name of ['wrangler.dev.jsonc', 'wrangler.prod.jsonc']) {
    const parsed = ts.parseConfigFileTextToJson(name, readFileSync(new URL(name, api), 'utf8'));
    if (parsed.error) { fail('Worker routes', `api/${name} does not parse: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, ' ')}`, `api/${name}`); continue; }
    const rules: string[] = (configs[name] = parsed.config).assets.run_worker_first;
    const first = (path: string) => rules.some(r => !r.startsWith('!') && glob(r).test(path)) && !rules.some(r => r.startsWith('!') && glob(r.slice(1)).test(path));
    for (const path of paths.filter(p => !first(p))) fail('Worker routes', `${path} is an API route but api/${name} assets.run_worker_first does not match it, so Cloudflare answers it from static assets (405 or the dashboard HTML). Add its prefix (for example "/${path.split('/')[1]}/*") to run_worker_first in both wrangler configs.`, `api/${name}`);
  }
  const [dev, prod] = [configs['wrangler.dev.jsonc'], configs['wrangler.prod.jsonc']];
  if (dev && prod && !isDeepStrictEqual(dev.assets, prod.assets)) fail('Worker routes', 'The assets block differs between api/wrangler.dev.jsonc and api/wrangler.prod.jsonc. dev is the only place production routing is tested before release: keep them identical.', 'api/wrangler.prod.jsonc');
  // The Worker module imports cloudflare:workers for its Durable Object and the SupportPlatform entrypoint; give Node empty stand-ins.
  register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s,c,n){return s==='cloudflare:workers'?{url:'data:text/javascript,export class DurableObject{};export class WorkerEntrypoint{}',shortCircuit:true}:n(s,c)}`));
  const worker = (await import('../src/worker.js')).default as { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };
  const env = { ASSETS: { fetch: async () => new Response('static asset', { headers: { 'x-premerge-asset': '1' } }) }, ADMISSION: { limit: async () => ({ success: false }) } };
  // An API path ends at admission (refused here, so nothing else loads); only the outcome matters, not its log line.
  const quiet = { log: console.log, warn: console.warn, info: console.info, error: console.error }, served: string[] = [];
  Object.assign(console, { log() {}, warn() {}, info() {}, error() {} });
  try {
    for (const path of paths) {
      const response = await worker.fetch(new Request(`https://premerge.invalid${path}`), env, { waitUntil() {}, passThroughOnException() {} });
      if (response.headers.get('x-premerge-asset')) served.push(path);
    }
  } finally { Object.assign(console, quiet); }
  for (const path of served) fail('Worker routes', `GET ${path} is an API route, but src/worker.ts hands it to the static assets binding. Add its prefix to the API path pattern in the Worker's fetch handler.`, 'api/src/worker.ts');
  if (failed === before) console.log(`Worker routes: ${paths.length} API paths reach the Worker in both wrangler configs and src/worker.ts.`);
}

// 3. Migrations. src/migrate.ts applies every /^\d+_[a-z_]+\.sql$/ file once, in name order, and refuses a changed one.
// A migration that sorts before one dev already applied runs in a different order on a fresh database than on dev,
// and two open PRs picking the same next number collide when the second one merges.
{
  const dir = 'api/migrations', applied = /^\d+_[a-z_]+\.sql$/, numbered = /^(\d{3})_[a-z_]+\.sql$/;
  // Pairs that shipped before this check, ordered by name everywhere since. Never add to this list.
  const grandfathered = new Set(['038', '093', '095', '098', '104', '105', '106', '120', '133', '140', '153', '154', '155', '158']);
  const head = readdirSync(new URL('migrations/', api)).filter(n => !n.startsWith('.')).sort();
  const number = (name: string) => numbered.exec(name)?.[1];
  for (const name of head) {
    if (!applied.test(name)) fail('Migrations', `${name} does not match ${applied} and src/migrate.ts would silently skip it. Name it NNN_lower_snake_case.sql (letters and underscores only after the number).`, `${dir}/${name}`);
    else if (!numbered.test(name)) fail('Migrations', `${name} must start with a three-digit number.`, `${dir}/${name}`);
  }
  const byNumber = new Map<string, string[]>();
  for (const name of head) { const n = number(name); if (n) byNumber.set(n, [...byNumber.get(n) ?? [], name]); }
  const baseList = base ? (tryGit('ls-tree', '--name-only', `${base}:${dir}`) ?? '').split('\n').filter(Boolean) : [];
  const baseMax = baseList.map(number).filter(Boolean).sort().at(-1) ?? '000';
  const added = head.filter(n => !baseList.includes(n));
  // A new file that reuses a dev number is reported below with the number to use instead.
  for (const [n, names] of byNumber) if (names.length > 1 && !grandfathered.has(n) && (n > baseMax || !names.some(name => added.includes(name)))) fail('Migrations', `Migration number ${n} is used by ${names.join(' and ')}. Renumber the newer one to the next free number.`, `${dir}/${names.find(name => added.includes(name)) ?? names.at(-1)}`);
  for (const name of baseList) {
    if (!head.includes(name)) fail('Migrations', `${name} is on the base branch and was deleted or renamed. Applied migrations are permanent: restore it and add a new migration.`, `${dir}/${name}`);
    else if (atBase(`${dir}/${name}`) !== readFileSync(new URL(`migrations/${name}`, api), 'utf8').trim()) fail('Migrations', `${name} is already on the base branch, and dev has applied it. Editing it fails every upgraded database with MIGRATION_CHANGED: revert the edit and add a new migration.`, `${dir}/${name}`);
  }
  let next = Number(baseMax) + 1;
  const claimed = new Map<string, number>();
  const token = process.env.GH_TOKEN, repo = process.env.GITHUB_REPOSITORY, pr = Number(process.env.PR_NUMBER);
  if (added.length && token && repo && pr) {
    // Other open PRs into dev that add a migration. An older PR keeps its number; this one renumbers.
    const get = async (path: string) => {
      const response = await fetch(`https://api.github.com/${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
      if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
      return response.json() as Promise<{ number: number; filename: string; status: string; sha: string }[]>;
    };
    // A stacked PR (one built on this one) carries this PR's migration files unchanged: the same blob is the same
    // migration, not a second PR claiming its number.
    const blob = (name: string) => { const bytes = readFileSync(new URL(`migrations/${name}`, api)); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); };
    const ours = new Map(added.map(name => [name, blob(name)]));
    const pulls: { number: number }[] = [];
    for (let page = 1; ; page++) { const rows = await get(`repos/${repo}/pulls?state=open&base=dev&per_page=100&page=${page}`); pulls.push(...rows); if (rows.length < 100) break; }
    await Promise.all(pulls.filter(p => p.number !== pr).map(async p => {
      for (let page = 1; page <= 30; page++) {
        const files = await get(`repos/${repo}/pulls/${p.number}/files?per_page=100&page=${page}`);
        for (const f of files) {
          const name = f.filename.slice(dir.length + 1), n = f.status === 'added' && f.filename.startsWith(`${dir}/`) ? number(name) : undefined;
          if (n && ours.get(name) !== f.sha && (!claimed.has(n) || claimed.get(n)! > p.number)) claimed.set(n, p.number);
        }
        if (files.length < 100) break;
      }
    }));
    next = Math.max(next, ...[...claimed.keys()].map(n => Number(n) + 1));
  }
  const free = () => String(next++).padStart(3, '0');
  for (const name of added) {
    const n = number(name);
    if (!n) continue;
    const other = claimed.get(n);
    const taken = baseList.find(b => number(b) === n);
    if (n <= baseMax) fail('Migrations', `${name} ${taken ? `reuses number ${n} (${taken} on dev)` : `sorts before ${baseMax}, the newest migration on dev`}, so a fresh database applies it in a different order than dev did. Renumber it to ${free()}.`, `${dir}/${name}`);
    else if (other !== undefined && other < pr) fail('Migrations', `Open PR #${other} already adds migration ${n}. The older PR keeps the number: renumber ${name} to ${free()}.`, `${dir}/${name}`);
    else if (other !== undefined) warn('Migrations', `Newer open PR #${other} also adds migration ${n}; it will be asked to renumber.`, `${dir}/${name}`);
  }
  console.log(`Migrations: ${head.length} files, ${added.length} new on top of ${baseMax}${base ? ` (base ${base.slice(0, 12)})` : ' (no base: order not checked)'}.`);
}

// 4. Phone layout: below 640 px every DataTable renders cards from each column's `card` slot (AGENTS.md). A column
// defined without one falls back to a guessed slot. Existing columns are grandfathered; a new one must say where it goes.
{
  const columns = (file: string, text: string) => {
    const found: { key: string; line: number }[] = [];
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node) && !node.properties.some(ts.isSpreadAssignment)) {
        const props = new Map(node.properties.flatMap(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [[p.name.text, p] as const] : []));
        if (props.has('key') && props.has('label') && props.has('render') && !props.has('card')) {
          const key = props.get('key')!;
          found.push({ key: ts.isPropertyAssignment(key) ? key.initializer.getText(source) : 'key', line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };
  const files = git('ls-files', '--', 'app/src/*.tsx', 'app/src/*.ts').split('\n').filter(Boolean);
  let total = 0, added = 0;
  for (const file of files) {
    const now = columns(file, readFileSync(new URL(file, root), 'utf8'));
    total += now.length;
    if (!now.length) continue;
    const before = new Set(columns(file, atBase(file) ?? '').map(c => c.key));
    for (const column of now.filter(c => !before.has(c.key))) added++, fail('Card slots', `Table column ${column.key} has no card slot. Below 640 px DataTable renders each row as a card: set card to 'title', 'aside', 'line', 'inline', 'field', 'end' or 'hide' (see Column in app/src/components/ui/primitives.tsx).`, file, column.line);
  }
  console.log(`Card slots: ${total - added} grandfathered columns without a card slot, ${added} new.`);
}

// 5. Flake quarantine: an acceptance test named with [flaky #N] is skipped by the required job and run by the nightly.
// It must name its tracking issue, and that issue must still be open (closing it means the flake was fixed).
{
  const file = 'api/api.acceptance.test.ts', text = readFileSync(new URL('api.acceptance.test.ts', api), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const tagged: { name: string; issue?: number; line: number }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['test', 'it', 'describe'].includes(node.expression.text)) {
      const title = node.arguments[0];
      if (title && ts.isStringLiteralLike(title) && /flaky/i.test(title.text)) {
        tagged.push({ name: title.text, issue: Number(/\[flaky #(\d+)\]/.exec(title.text)?.[1]) || undefined, line: source.getLineAndCharacterOfPosition(title.getStart(source)).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const token = process.env.GH_TOKEN, repo = process.env.GITHUB_REPOSITORY;
  for (const test of tagged) {
    if (!test.issue) { fail('Quarantine', `"${test.name}" mentions flaky but has no [flaky #<issue>] tag. Quarantine a test with the exact tag and its open issue, or rename it.`, file, test.line); continue; }
    if (!token || !repo) continue;
    const response = await fetch(`https://api.github.com/repos/${repo}/issues/${test.issue}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
    const issue = response.ok ? await response.json() as { state: string } : null;
    if (!issue) fail('Quarantine', `"${test.name}" is quarantined under #${test.issue}, which does not exist. Open an issue for the flake and use its number.`, file, test.line);
    else if (issue.state !== 'open') fail('Quarantine', `#${test.issue} is closed but "${test.name}" is still quarantined. Remove the [flaky #${test.issue}] tag so the test blocks again, or reopen the issue.`, file, test.line);
  }
  console.log(`Quarantine: ${tagged.length} acceptance test${tagged.length === 1 ? '' : 's'} quarantined${tagged.length ? ` (${tagged.map(t => `#${t.issue ?? '?'}`).join(', ')}); the nightly runs them` : ''}.`);
}

// 6. Identity is (issuer, subject). An issuer can assert a verified address that the sign-in method never vouched for
// (a GitHub-made account that links a personal Google account signs in with acr=google and its GitHub-verified work
// address), so nothing may admit, link or authorize a person by email. These names belonged to the removed email
// paths; one in the API sources, scripts or OIDC migrations means such a path came back. A line that must name one
// (the startup refusal of the removed settings) carries `premerge-identity: allowed`.
{
  const forbidden: [RegExp, string][] = [
    [/\bclaim_bane_legacy_user\b|\bbane_legacy_claims?\b/, 'links a subject to an existing user by email'],
    [/\bAUTH_ALLOWED_(?:EMAILS|DOMAINS)\b|\ballowed(?:Emails|Domains)\b|\bsignupApproved\b|\bgoogle_hosted_domain\b/, 'admits or authorizes by email address or domain'],
  ];
  const files = (dir: string, keep: (name: string) => boolean): string[] => readdirSync(new URL(dir, api), { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? files(`${dir}${e.name}/`, keep) : keep(e.name) ? [`${dir}${e.name}`] : []);
  const scanned = [...files('src/', n => n.endsWith('.ts')), ...files('scripts/', n => n.endsWith('.ts') && n !== 'check-premerge.ts'),
    ...files('migrations/', n => Number(n.slice(0, 3)) >= 270)];
  let hits = 0;
  for (const path of scanned) readFileSync(new URL(path, api), 'utf8').split('\n').forEach((text, i) => {
    if (text.includes('premerge-identity: allowed')) return;
    for (const [pattern, why] of forbidden) if (pattern.test(text)) hits++, fail('Identity', `${text.match(pattern)![0]} ${why}. Identity is (issuer, subject): admit or link a person by subject (see api/src/account-policy.ts), never by address.`, `api/${path}`, i + 1);
  });
  if (!hits) console.log(`Identity: ${scanned.length} API, script and OIDC migration files admit and link people by subject only.`);
}

// 7. Every operation states the permission it needs: x-nightmail-permission in openapi.json, from the table in
// src/operation-permissions.ts, which the acceptance test "permission table" checks against what REST enforces.
{
  const before = failed, file = 'api/src/operation-permissions.ts';
  const { OPERATION_PERMISSIONS, permissionExtension } = await import('../src/operation-permissions.js'), { PERMISSIONS } = await import('../src/core.js');
  const spec = JSON.parse(readFileSync(new URL('openapi.json', api), 'utf8')) as { paths: Record<string, Record<string, Record<string, unknown> & { operationId?: string }>> };
  const operations = Object.values(spec.paths).flatMap(item => Object.values(item)).filter(op => op.operationId);
  const valid = (row: Record<string, unknown> | undefined) => !!row && (row.access ? ['public', 'staff', 'any'].includes(String(row.access)) && Object.keys(row).every(k => ['access', 'text'].includes(k))
    : row.permission ? Object.hasOwn(PERMISSIONS, String(row.permission)) && (row.permission === 'sendEmail' ? row.level === 'on' : ['read', 'write'].includes(String(row.level)))
    : ['any', 'admin', 'owner'].includes(String(row.person)) && (row.level === undefined || ['read', 'write'].includes(String(row.level))) && !row.scope);
  for (const op of operations) {
    const row = op[permissionExtension] as Record<string, unknown> | undefined;
    if (!row) fail('Permissions', `${op.operationId} states no permission: it has no ${permissionExtension} in api/openapi.json. Add its row to ${file} with what its guards enforce (a permission and level, a person, or public), run bun run sdk in api/, and run the acceptance test "permission table".`, file);
    else if (!valid(row)) fail('Permissions', `${op.operationId}'s ${permissionExtension} is not a valid row: ${JSON.stringify(row)}. See OperationPermission in ${file}.`, file);
  }
  const ids = new Set(operations.map(op => op.operationId));
  for (const id of Object.keys(OPERATION_PERMISSIONS).filter(id => !ids.has(id))) fail('Permissions', `${file} has a row for ${id}, which is not an operation in api/openapi.json. Remove the row, or run bun run sdk in api/ if the operation is new.`, file);
  if (failed === before) console.log(`Permissions: all ${operations.length} operations state the permission they need.`);
}

// 8. Published BYO role templates. Customers' stacks run byo/<version>.yaml from S3, and Nightmail keeps working with
// every supported version, so a published file never changes or disappears: a change is a new, higher version. The
// acceptance test "BYO contract" checks every session the code asks for against each of them.
{
  const before = failed, dir = 'api/byo-templates', named = /^(\d+)\.(\d+)\.yaml$/;
  const head = (() => { try { return readdirSync(new URL('byo-templates/', api)).filter(n => !n.startsWith('.')).sort(); } catch { return []; } })();
  for (const name of head) if (!named.test(name)) fail('BYO templates', `${name} must be named <major>.<minor>.yaml, the version its stack reports.`, `${dir}/${name}`);
  const baseList = base ? (tryGit('ls-tree', '--name-only', `${base}:${dir}`) ?? '').split('\n').filter(Boolean) : [];
  for (const name of baseList) {
    if (!head.includes(name)) fail('BYO templates', `${name} is published and connected accounts may run it. Restore it; publish changes as a new version.`, `${dir}/${name}`);
    else if (atBase(`${dir}/${name}`) !== readFileSync(new URL(`byo-templates/${name}`, api), 'utf8').trim()) fail('BYO templates', `${name} is published and connected accounts may run it. Revert the edit and publish the change as a new version.`, `${dir}/${name}`);
  }
  const version = (name: string) => { const m = named.exec(name); return m ? Number(m[1]) * 1e6 + Number(m[2]) : -1; };
  const newest = Math.max(-1, ...baseList.map(version));
  for (const name of head.filter(n => !baseList.includes(n))) if (version(name) <= newest) fail('BYO templates', `${name} isn't newer than the newest published version. Use a higher version.`, `${dir}/${name}`);
  if (failed === before) console.log(`BYO templates: ${head.length} published, ${head.filter(n => !baseList.includes(n)).length} new.`);
}

// 9. Price pages (app/src/features/pricing). Every Nightmail figure the pages show must be what the billing rates
// (src/billing/rates.ts) charge for the usage beside it, and every competitor figure in the pages' data must name the
// vendor's page it was read on, the day and the text. The pages are rendered as React renders them for a browser (in a
// child process with the app's JSX settings), at their own sizes and at inputs a visitor might type.
{
  const before = failed, file = 'app/src/features/pricing/prices.ts'
  const { RATES, CREDIT, STORAGE_AFTER_DAYS, perThousandUsd } = await import('../src/billing/rates.js')
  const n = (value: number) => value.toLocaleString('en-US')
  // Written again here, apart from the pages' own code: micro-cents to dollars, half up, four places under a cent, and
  // no cents on a whole-dollar amount (the pages print "$19", "$26.50", "$0").
  const dollarsOf = (uc: bigint) => { const places = uc > 0n && uc < 1_000_000n ? 4 : 2, unit = 10n ** BigInt(8 - places), v = ((uc + unit / 2n) / unit).toString().padStart(places + 1, '0'); return '$' + n(Number(v.slice(0, -places))) + (v.slice(-places) === '00' ? '' : '.' + v.slice(-places)) }
  const charged = (sent: number, received: number) => BigInt(Math.max(0, sent - RATES.freeSentEmails) + Math.max(0, received - RATES.freeReceivedEmails)) * RATES.emailUc
  // What a typed value means: its digits, at most a billion.
  const typed = (value: string) => { const digits = value.replace(/\D/g, ''); return digits ? Math.min(Number(digits.slice(0, 10)), 1e9) : 0 }
  const inputs: Record<string, string>[] = [
    {}, { sent: '20000', received: '0', contacts: '5000', teammates: '3' }, { sent: '400000', received: '0', contacts: '100000', teammates: '3' },
    { sent: '4999', received: '5000', contacts: '0', teammates: '1' }, { sent: '5001', received: '5001', contacts: '250', teammates: '1' },
    { sent: '6000', received: '0', contacts: '12000', teammates: '4' }, { sent: '55000', received: '100', contacts: '5000', teammates: '3' },
    { sent: '101000', received: '9000', contacts: '1000', teammates: '6' }, { sent: '3000001', received: '0', contacts: '150000', teammates: '2' },
    { sent: 'abc', received: '-5', contacts: '1e9', teammates: '' }, { sent: '99999999999999', received: '1,234,567', contacts: '0.5', teammates: '99999999999' },
  ]
  const script = [
    "import { createElement as h } from 'react'", "import { renderToStaticMarkup } from 'react-dom/server'", "import { MemoryRouter } from 'react-router'",
    "const content = await import('./src/features/pricing/content.tsx'), prices = await import('./src/features/pricing/prices.ts')",
    'const at = (path, element) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, element))',
    `const calculator = ${JSON.stringify(inputs)}.map(input => { const path = '/pricing?' + new URLSearchParams(input); return { input, path, html: at(path, h(content.Calculator)) } })`,
    "const compare = ['resend'].map(id => ({ id, html: at('/compare/' + id, h(content.Compare, { comparison: prices.comparisons[id] })) }))",
    // The Mailchimp page is a chart of its own (mailchimp.tsx), and three compositions of it wait for a choice (mailchimp-takes.tsx).
    "const sizes = prices.comparisons.mailchimp.sizes.length, takes = await import('./src/features/pricing/mailchimp-takes.tsx')",
    "const chart = [{ id: 'mailchimp', sizes, html: at('/compare/mailchimp', h((await import('./src/features/pricing/mailchimp.tsx')).MailchimpComparison)) }, ...['1', '2', '3'].map(take => ({ id: 'mailchimp (take ' + take + ')', sizes, html: at('/compare/mailchimp?take=' + take, h(takes.MailchimpTake, { take })) }))]",
    'const { OFFERS, comparisons, resendOverage, resendReceived } = prices',
    "process.stdout.write(JSON.stringify({ calculator, compare, chart, data: { OFFERS, comparisons, resendOverage, resendReceived } }, (_k, v) => typeof v === 'bigint' ? String(v) : v))",
  ].join('\n')
  type Rendered = { calculator: { input: Record<string, string>; path: string; html: string }[]; compare: { id: string; html: string }[]; chart: { id: string; sizes: number; html: string }[]; data: unknown }
  let out: Rendered | null = null
  try {
    out = JSON.parse(execFileSync('node', ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], { cwd: new URL('app/', root), encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] })) as Rendered
  } catch (error) {
    if (/Cannot find (module|package) '(react|react-dom|react-router|lucide-react)/.test(String((error as { stderr?: string }).stderr))) warn('Price pages', 'Skipped: run bun install in app/ to render the price pages.')
    else fail('Price pages', `Rendering the price pages failed: ${String((error as { stderr?: string }).stderr ?? error).slice(0, 600)}`, file)
  }
  if (out) {
    const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')
    const figures = (html: string) => [...html.matchAll(/data-nightmail-sent="(\d+)" data-nightmail-received="(\d+)">([^<]*)</g)].map(m => ({ sent: Number(m[1]), received: Number(m[2]), shown: m[3]! }))
    const checkFigures = (where: string, html: string, least: number) => {
      const found = figures(html)
      if (found.length < least) fail('Price pages', `${where} shows ${found.length} Nightmail figures marked with the usage they price, not at least ${least}: mark each with data-nightmail-sent and data-nightmail-received (content.tsx, Ours).`, file)
      for (const f of found) if (f.shown !== dollarsOf(charged(f.sent, f.received))) fail('Price pages', `${where} shows ${f.shown} for ${n(f.sent)} sent and ${n(f.received)} received; src/billing/rates.ts charges ${dollarsOf(charged(f.sent, f.received))}.`, file)
    }
    // The rates and terms the pages quote, as the billing code has them.
    const minTopUp = '$' + n(CREDIT.minTopUpCents / 100)
    const terms = ['$' + perThousandUsd(RATES.emailUc) + ' per 1,000', n(RATES.freeSentEmails) + ' of each free', dollarsOf(RATES.storageUcPerGbMonth) + ' per GB a month after ' + Number(RATES.freeStorageBytes / 1_000_000_000n) + ' GB free',
      'past ' + STORAGE_AFTER_DAYS + ' days', 'Top-ups start at ' + minTopUp + ' and expire ' + CREDIT.expiresAfterMonths + ' months after purchase']
    for (const { input, path, html } of out.calculator) {
      const page = text(html), want = { sent: typed(input.sent ?? '100000'), received: typed(input.received ?? '0') }
      checkFigures(`The calculator at ${path}`, html, 4)
      const total = figures(html)[0]
      if (total && (total.sent !== want.sent || total.received !== want.received)) fail('Price pages', `The calculator at ${path} priced ${n(total.sent)} sent and ${n(total.received)} received, not the ${n(want.sent)} and ${n(want.received)} typed.`, file)
      for (const term of terms) if (!page.includes(term)) fail('Price pages', `The calculator at ${path} doesn't say “${term}”, as src/billing/rates.ts has it.`, file)
      const monthly = charged(want.sent, want.received), floor = monthly > 0n && monthly * 12n < BigInt(CREDIT.minTopUpCents) * 1_000_000n
      if (floor !== page.includes(`at least ${minTopUp} a year`)) fail('Price pages', `The calculator at ${path} ${floor ? 'doesn’t say' : 'says'} that a year costs at least the smallest top-up, at ${dollarsOf(monthly)} a month.`, file)
      if (/\bNaN\b|undefined|Infinity/.test(page)) fail('Price pages', `The calculator at ${path} shows NaN, undefined or Infinity.`, file)
      if (/Not (published|checked)/.test(page)) fail('Price pages', `The calculator at ${path} lists a vendor without a price that was read: list only vendors priced at the size.`, file)
    }
    for (const { id, html } of out.compare) {
      checkFigures(`Nightmail vs ${id}`, html, 3)
      for (const term of terms.slice(2)) if (!text(html).includes(term)) fail('Price pages', `Nightmail vs ${id} doesn't say “${term}”, as src/billing/rates.ts has it.`, file)
      if (/Not (published|checked)/.test(text(html))) fail('Price pages', `Nightmail vs ${id} has a size without a verified competitor price: compare only at sizes the data has.`, file)
    }
    // Every competitor figure (a tier, a per-email rate, a fact that names a price) and its source: the vendor's page
    // (https), the day it was read (not in the future) and the text it was read from. Facts without a source are
    // Nightmail's own (a comparison's \`ours\`).
    const sources: [string, Record<string, unknown>][] = []
    const walk = (value: unknown, at: string) => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) return value.forEach((item, i) => walk(item, `${at}[${i}]`))
      const record = value as Record<string, unknown>, cited = Object.keys(record).some(key => key === 'source' || key.endsWith('Source'))
      const price = 'cents' in record || 'ucPerEmail' in record || ('text' in record && /\$\d/.test(String(record.text)) && !/\.ours\[\d+\]$/.test(at))
      if (price && !cited) fail('Price pages', `${at} is a competitor price with no source.`, file)
      for (const [key, item] of Object.entries(record)) {
        if (key === 'source' || key.endsWith('Source') || key === 'resendOverage' || key === 'resendReceived') sources.push([`${at}.${key}`, (item ?? {}) as Record<string, unknown>])
        walk(item, `${at}.${key}`)
      }
    }
    walk(out.data, 'prices')
    const today = new Date().toISOString().slice(0, 10)
    for (const [at, source] of sources) {
      let url: URL | null = null
      try { url = new URL(String(source.url)) } catch { url = null }
      if (url?.protocol !== 'https:') fail('Price pages', `${at} has no https link to the vendor's page.`, file)
      if (typeof source.checked !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(source.checked) || Number.isNaN(Date.parse(source.checked)) || source.checked > today) fail('Price pages', `${at} has no valid day it was checked (YYYY-MM-DD, not in the future).`, file)
      if (typeof source.quote !== 'string' || source.quote.trim().length < 8) fail('Price pages', `${at} doesn't quote the text it was read from.`, file)
    }
    // On the pages: each competitor row with a price names the day it was checked and links the vendor's page (a row with
    // none links it); a comparison table says it under the table.
    const dated = /Checked \d{1,2} \w{3} \d{4} on <a href="https:\/\//
    for (const { path, html } of out.calculator) for (const row of html.split(/(?=<li [^>]*data-offer=)/).slice(1).map(part => part.split('</li>')[0]!))
      if (!(/Not checked/.test(row) ? /See <a href="https:\/\//.test(row) : dated.test(row))) fail('Price pages', `A competitor row on the calculator at ${path} has no date and link to the vendor's page: ${text(row).slice(0, 80)}`, file)
    for (const { id, html } of out.compare) if (!dated.test(html.split('</table>')[1] ?? '')) fail('Price pages', `Nightmail vs ${id} doesn't give the day its prices were checked and a link to the vendor's page under the table.`, file)
    // A comparison drawn as a chart: one Nightmail figure for each of its sizes (a size without a read price would be
    // missing), each for the emails a month written beside it; the competitor's prices dated and linked; and the terms
    // on the page (in its small print).
    for (const { id, sizes, html } of out.chart) {
      const page = text(html), where = `Nightmail vs ${id}`, found = figures(html)
      checkFigures(where, html, sizes)
      if (new Set(found.map(f => f.sent)).size !== sizes) fail('Price pages', `${where} shows ${new Set(found.map(f => f.sent)).size} sizes, not the ${sizes} it compares: every size must be one the vendor's page prices (prices.ts).`, file)
      for (const f of found) if (!page.includes(`${n(f.sent)} emails a month`) || f.received) fail('Price pages', `${where} prices ${n(f.sent)} sent and ${n(f.received)} received without saying so beside the figure.`, file)
      for (const term of terms.slice(2)) if (!page.includes(term)) fail('Price pages', `${where} doesn't say “${term}”, as src/billing/rates.ts has it.`, file)
      if (/Not (published|checked)|\bNaN\b|undefined/.test(page)) fail('Price pages', `${where} has a size without a verified competitor price: compare only at sizes the data has.`, file)
      if (!dated.test(html)) fail('Price pages', `${where} doesn't give the day its prices were checked and a link to the vendor's page.`, file)
    }
    if (failed === before) console.log(`Price pages: ${out.calculator.length} calculator inputs and ${out.compare.length + out.chart.length} renderings of the comparisons match src/billing/rates.ts; ${sources.length} competitor sources have a link, a day and a quote.`)
  }
}

if (failed) {
  console.log(`\n${failed} pre-merge check${failed === 1 ? '' : 's'} failed. docs/ci.md explains each one and how to fix it.`);
  process.exitCode = 1;
}
