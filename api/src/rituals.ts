import { receivingPolicy } from './mailbox-ingest-input.js';
import {registerInboxConnection} from './inbox-connection.js';
import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { actor, ApiError, errors, json, receivingAdmin, response, security, type App, type Ctx, type DbExecutor } from './core.js';
import { recordAudit } from './audit.js';
import { mailMessages, mailAttachments, retainedMail } from './db/mailbox.js';
import { lockMailboxLane } from './mailbox-store.js';
import { rolledBack } from './routing.js';
import {
  asRules,
  bindingsFrom,
  compileConfig,
  configFrom,
  formatDiagnostic,
  ritualPipeline,
  RitualConfig,
  RitualConfigError,
  Ritual,
  Rule,
  RuleBindingInput,
  RuleConfig,
  RuleConfigInput,
  RecipeRef,
  RuleRecipeRef,
  projectEmail,
  type Config,
  type Programs,
} from './ritual-pipeline.js';
import { compileRitual, type Diagnostic } from './ritual-engine.js';
import { buildRecipe, closest, endpointCall, endpointPayloads, recipeGroups, recipeWrote, ritualCompletions, ritualRecipes, ritualTemplates, ritualTypings, type EndpointType, type RecipeParams } from './ritual-schema.js';
import { RATES } from './billing/money.js';
import type { RoutingInput } from './routing-match.js';
import { registerEndpoints } from './endpoints.js';
import { registerRitualVersion } from './ritual-version.js';
import { LEGACY_RULE_OPERATIONS, LEGACY_RULES_PATH, RULES_PATH, type RuleOperation } from './rule-names.js';

/** rules: the operations and shapes since the rename. rituals: the deprecated aliases, which answer exactly as before. */
export type Family = 'rules' | 'rituals';
const path = RULES_PATH,
  meta = { security, tags: ['Rules'] },
  state = z.object({ version: z.number().int(), config: RuleConfig }),
  legacyState = z.object({ version: z.number().int(), config: RitualConfig }),
  ok = { 200: response(state), ...errors },
  legacyOk = { 200: response(legacyState), ...errors };
/** A saved version as each family returns it. */
const stateOf = (family: Family, s: { version: number; config: Config }) => family === 'rules' ? { version: s.version, config: asRules(s.config) } : s;
/** Error codes from before the rename, which the aliases keep returning. */
const LEGACY_CODES: Record<string, string> = { RULE_INVALID: 'RITUAL_INVALID', RULE_BINDING_NOT_OWNED: 'RITUAL_BINDING_NOT_OWNED', RULE_EXISTS: 'RITUAL_EXISTS' };
function legacyError(e: unknown) {
  if (!(e instanceof ApiError)) return e;
  e.code = LEGACY_CODES[e.code] ?? e.code;
  if (e.field === 'rules') e.field = 'rituals';
  if (e.details) e.details = e.details.map(({ rule, ...d }) => rule === undefined ? d : { ritual: rule, ...d });
  return e;
}
/**
 * Registers a rule operation and its deprecated alias at the earlier name and path: the same handler, told which family
 * answers so the alias keeps its earlier shapes (`legacy` overrides its request or responses where they differ).
 */
function both(app: App, route: RouteConfig & { operationId: RuleOperation }, handler: (c: Ctx, family: Family) => Promise<Response> | Response, legacy: Partial<Pick<RouteConfig, 'request' | 'responses'>> = {}, legacyPath = route.path.replace(RULES_PATH, LEGACY_RULES_PATH)) {
  app.openapi(createRoute(route), ((c: Ctx) => handler(c, 'rules')) as never);
  const id = route.operationId;
  app.openapi(createRoute({ ...route, ...legacy, operationId: LEGACY_RULE_OPERATIONS[id], path: legacyPath, deprecated: true,
    summary: `${route.summary} (deprecated: use ${id})`, description: `Deprecated: use ${id}, the same operation under its current name.` }),
  (async (c: Ctx) => { try { return await handler(c, 'rituals'); } catch (e) { throw legacyError(e); } }) as never);
}
const Line = z.number().int().min(1);
const timeline = (scores: 'decisions' | 'omens') => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('condition'), line: Line, column: Line, endLine: Line, endColumn: Line, result: z.boolean().describe('What the condition evaluated to.') }),
  z.object({ kind: z.literal(scores), line: Line, scores: z.record(z.string(), z.union([z.number(), z.boolean()])).describe('Decision name → the answer the rule read: the scores passed in, recorded answers or each decision’s onError value.') }),
  z.object({ kind: z.literal('action'), line: Line, op: z.string().describe('label, junk, block, drop, allow, inbox.deliver or endpoint.'), ref: z.string().optional().describe('endpoint:<name> or inbox:<key>.'), value: z.string().optional() }),
  z.object({ kind: z.literal('return'), line: Line }),
]);
const traceRow = (step: ReturnType<typeof timeline>) => z.object({
  recipient: z.string(), kind: z.string().describe('rule.'), key: z.string().describe('Rule key.'),
  scores: z.record(z.string(), z.union([z.number(), z.boolean()])), steps: z.number().int(), lines: z.array(z.number().int()).describe('Statement lines run, in order (at most 128).'),
  error: z.string().nullable(), actions: z.array(z.object({ op: z.string(), ref: z.string().optional(), body: z.unknown().optional(), value: z.string().optional() })),
  timeline: z.array(step).describe('The evaluation in order: each condition and its result, decision answers read, actions taken and the return (at most 128 steps). For stepping through a dry run.'),
});
const TraceRow = traceRow(timeline('decisions').openapi('RuleTimelineStep')).openapi('RuleTraceRow'),
  LegacyTraceRow = traceRow(timeline('omens').openapi('RitualTimelineStep')).openapi('RitualTraceRow');
/** A receiving write by an approval, or by a key it created, holds the approval (shared lock) for the rest of the
 * transaction. It is read again here, not only when the request was authenticated: a removal under way finishes first
 * and the write is refused, and one that starts later waits for the transaction and then disables what it recorded.
 * Take it before any row a removal disables (endpoints, routes, keys), the order a removal takes them in. */
export async function holdReceiving(tx:DbExecutor,c:Ctx){
  const a=c.get('actor');if(!a.grantId)return;
  if(!a.receivingConsent||!a.permissions.includes('manage'))throw new ApiError(403,'ADMIN_REQUIRED','Explicit manage and receiving consent required.');
  const grant=await (await import('./mcp-auth.js')).getMcpGrantActor(c.env,'mcp_'+a.grantId,a.workspaceId,tx);
  if(grant?.workspaceId!==a.workspaceId||!grant.receivingConsent||!grant.permissions.includes('manage'))throw new ApiError(401,'AUTH_INVALID','The MCP approval behind this request was revoked while it ran. Nothing was changed.');
}
export async function ownReceiving(tx:DbExecutor,c:Ctx,kind:'endpoint'|'rituals'|'key'|'route',resource:string|string[]){
  const a=c.get('actor');if(!a.grantId)return;
  await holdReceiving(tx,c);
  for(const r of Array.isArray(resource)?resource:[resource])await tx.execute(sql`INSERT INTO mail_grant_objects VALUES(${a.grantId},${a.workspaceId},${kind},${r}) ON CONFLICT DO NOTHING`);
}
/** Removing an approval holds the endpoints it created or changed. An endpoint URL is write-only, so nothing is posted
 * to a held endpoint, a test included, until its URL is sent again. */
export const resumeNeedsUrl = () => new ApiError(409, 'ENDPOINT_URL_REQUIRED', 'Deliveries were held when the approval that created or changed this endpoint was removed, and its URL is write-only. Send the URL again to resume.', 'url');
async function current(tx: DbExecutor, w: string) {
  const r = (
    await tx.execute<{ version: number; config: Config | null }>(
      sql`SELECT coalesce(s.version,0) AS version,h.config FROM (SELECT 1) one LEFT JOIN mail_routing_state s ON s.workspace_id=${w} LEFT JOIN mail_ritual_configs h ON h.workspace_id=${w}`,
    )
  ).rows[0];
  return { version: r.version, config: r.config ?? RitualConfig.parse({}) };
}
type Resolved = { ref: string; id: string; type: EndpointType | 'inbox'; ready: boolean };
/** Resolves endpoint and inbox names to IDs and checks every call against its endpoint's type. */
async function analyze(tx: DbExecutor, w: string, c: Config, unchanged: ReadonlySet<string> = new Set()): Promise<{ programs: Programs | null; diagnostics: Diagnostic[]; code: string }> {
  let p: Programs;
  try {
    p = compileConfig(c);
  } catch (e) {
    if (e instanceof RitualConfigError) return { programs: null, diagnostics: e.diagnostics, code: 'RULE_INVALID' };
    throw e;
  }
  const refs = [...new Set(Object.values(p.rituals).flatMap(ir => ir.refs))];
  const found = refs.length ? (await tx.execute<Resolved>(sql`WITH refs AS (SELECT ref,split_part(ref,':',2) AS key FROM jsonb_array_elements_text(${JSON.stringify(refs)}::jsonb) ref)
    SELECT ref,b.id,'inbox' AS type,true AS ready FROM refs JOIN mailboxes b ON b.workspace_id=${w} AND b.key=refs.key WHERE starts_with(ref,'inbox:')
    UNION ALL SELECT ref,h.id,h.type,h.verified AND h.declined_at IS NULL FROM refs JOIN mailbox_webhooks h ON h.workspace_id=${w} AND h.key=refs.key WHERE starts_with(ref,'endpoint:')`)).rows : [];
  const byRef = new Map(found.map(r => [r.ref, r])), diagnostics: Diagnostic[] = [];
  let names: { endpoints: string[]; inboxes: string[] } | null = null;
  const known = async () => names ??= {
    endpoints: (await tx.execute<{ name: string }>(sql`SELECT key AS name FROM mailbox_webhooks WHERE workspace_id=${w} AND key IS NOT NULL LIMIT 1000`)).rows.map(r => r.name),
    inboxes: (await tx.execute<{ key: string }>(sql`SELECT key FROM mailboxes WHERE workspace_id=${w} AND key IS NOT NULL LIMIT 1000`)).rows.map(r => r.key),
  };
  for (const [ritual, ir] of Object.entries(p.rituals))
    for (const site of ir.sites ?? []) {
      const r = byRef.get(site.ref), name = site.ref.slice(site.ref.indexOf(':') + 1), inbox = site.ref.startsWith('inbox:');
      const report = (message: string, hint?: string) => diagnostics.push({ ritual, line: site.line, column: site.column, endLine: site.line, endColumn: site.column, message, ...(hint ? { hint } : {}) });
      if (!r) {
        const options = (await known())[inbox ? 'inboxes' : 'endpoints'], guess = closest(name, options);
        if (inbox) report(`No inbox has the key ${name}.`, guess ? `Did you mean inbox.deliver("${guess}")?` : 'Give the inbox a key with updateInboundAddress, or use one listed by listInboundAddresses.');
        else report(`No endpoint named ${name}.`, guess ? `Did you mean ${endpointCall(guess)}?` : 'Create it first with createEndpoint (type slack, discord, webhook or forward).');
        continue;
      }
      // A rule saved while its forward was confirmed keeps it when the recipient later stops forwards: the delivery
      // refuses unconfirmed forwards, and a decline must not block every other save in the workspace.
      if (!r.ready) { if (!unchanged.has(ritual)) report(`${endpointCall(name)} is a forward waiting for its recipient to confirm.`, 'Rules can call it once they choose Allow in the emailed link; getEndpoint shows its status.'); continue; }
      if (r.type === 'inbox' || r.type === 'webhook') continue;
      const shape = endpointPayloads[r.type], k = shape.fields?.[0];
      if (site.args < shape.args[0] || site.args > shape.args[1] || (k && site.fields && (site.fields.length !== 1 || site.fields[0] !== k)))
        report(`${endpointCall(name)} is a ${r.type} endpoint: call it as ${shape.signature(name).replace(/^endpoints\.[^(]+/, endpointCall(name))}.`, r.type === 'forward' ? 'A forward sends this message itself; it takes no payload.' : `Pass one record with a ${k} field.`);
    }
  p.refs = Object.fromEntries(found.map(r => [r.ref, r.id]));
  p.types = Object.fromEntries(found.map(r => [r.ref, r.type]));
  return { programs: p, diagnostics, code: diagnostics.length ? 'UNKNOWN_ENDPOINT' : '' };
}
/** A diagnostic as the rule operations return it: named by its rule. */
const ruleDiagnostic = ({ ritual, ...d }: Diagnostic) => ritual === undefined ? d : { rule: ritual, ...d };
function invalidRules(code: string, diagnostics: Diagnostic[]) {
  const error = new ApiError(422, code, `${formatDiagnostic(diagnostics[0]!)}${diagnostics.length > 1 ? ` (and ${diagnostics.length - 1} more in error.details)` : ''}`, 'rules');
  error.details = diagnostics.map(ruleDiagnostic);
  return error;
}
async function prepare(tx: DbExecutor, w: string, c: Config, unchanged?: ReadonlySet<string>) {
  const { programs, diagnostics, code } = await analyze(tx, w, c, unchanged);
  if (!programs || diagnostics.length) throw invalidRules(code, diagnostics);
  const invalid = (
    await tx.execute<{ t: string }>(
      sql`SELECT t FROM jsonb_array_elements_text(${JSON.stringify(c.attachments.map((a) => a.target))}::jsonb) t WHERE NOT EXISTS(SELECT FROM mailbox_addresses a WHERE a.workspace_id=${w} AND (a.address=t OR a.mailbox_id=t)) LIMIT 1`,
    )
  ).rows[0];
  if (invalid) throw new ApiError(422, 'UNKNOWN_TARGET', `No receiving inbox or address ${invalid.t} in this workspace.`, 'attachments');
  return programs;
}
/** Endpoint name → type in this workspace: what a recipe's endpoint fields may name. */
async function endpointKinds(tx: DbExecutor, w: string) {
  const rows = (await tx.execute<{ name: string; type: EndpointType }>(sql`SELECT key AS name,type FROM mailbox_webhooks WHERE workspace_id=${w} AND key IS NOT NULL`)).rows;
  const kinds = new Map(rows.map(r => [r.name, r.type]));
  return (name: string) => kinds.get(name);
}
/** A rule keeps its recipe only while its source is what the recipe writes; enabled is stored only when false. */
async function normalize(tx: DbExecutor, w: string, config: Config): Promise<Config> {
  const kind = config.rituals.some(r => r.recipe) ? await endpointKinds(tx, w) : null;
  return { ...config, rituals: config.rituals.map(({ recipe, enabled, ...r }) => {
    const built = recipe && kind ? buildRecipe(recipe.id, recipe.params, kind) : null;
    return { ...r, ...(built?.ok && recipeWrote(built, r.source) ? { recipe: { id: built.recipe.id, params: built.params } } : {}), ...(enabled === false ? { enabled } : {}) };
  }) };
}
async function save(tx: DbExecutor, c: Ctx, w: string, input: Config, version: number,preview=false) {
  const prior=(await tx.execute<{config:Config;owners:Record<string,string|null>}>(sql`SELECT config,owners FROM mail_ritual_configs WHERE workspace_id=${w} FOR UPDATE`)).rows[0];
  const config = await normalize(tx, w, input);
  const unchanged = new Set((prior?.config.rituals ?? []).filter(r => config.rituals.some(x => x.key === r.key && x.source === r.source)).map(r => r.key));
  const p = await prepare(tx, w, config, unchanged),
    next = version + 1;
  const bindingKey=(b:Config['attachments'][number])=>'attachment:'+b.target+':'+b.ritual;
  const parts=(cfg:Config)=>new Map<string,string>([
    ...cfg.rituals.map(r=>['ritual:'+r.key,r.source] as const),
    ...cfg.attachments.map(b=>[bindingKey(b),String(b.continue)] as const),
    ...Object.entries(cfg.senderLists).map(([k,v])=>['list:'+k,JSON.stringify(v)] as const),
    ...cfg.evaluateDomains.map(k=>['domain:'+k,k] as const),...cfg.evaluateRoutes.map(k=>['route:'+k,k] as const),
  ]);
  const before=prior&&parts(prior.config), grant=c.get('actor').grantId??null;
  if (prior && grant && !preview) {
    // Ignore additions and this approval's own bindings. What remains must be the
    // same chain, including continue flags: the first action can stop later guards.
    const protectedBindings=prior.config.attachments.filter(b=>prior.owners[bindingKey(b)]!==grant);
    const protectedKeys=new Set(protectedBindings.map(bindingKey));
    const retained=config.attachments.filter(b=>protectedKeys.has(bindingKey(b)));
    if (retained.length!==protectedBindings.length || retained.some((b,i)=>bindingKey(b)!==bindingKey(protectedBindings[i]) || b.continue!==protectedBindings[i].continue))
      throw new ApiError(403,'RULE_BINDING_NOT_OWNED','This approval cannot remove, change, or reorder another owner’s rule attachments.','attachments');
    // Turning a rule off stops its attachments like removing them would.
    const off=(cfg:Config)=>new Set(cfg.rituals.filter(r=>r.enabled===false).map(r=>r.key)),was=off(prior.config),now=off(config);
    if (protectedBindings.some(b=>now.has(b.ritual)&&!was.has(b.ritual)))
      throw new ApiError(403,'RULE_BINDING_NOT_OWNED','This approval cannot turn off another owner’s rule.','enabled');
  }
  p.owners=Object.fromEntries([...parts(config)].map(([k,v])=>[k,before?.get(k)===v?prior?.owners[k]??null:preview?null:grant]));
  await tx.execute(
    sql`INSERT INTO mail_routing_state(workspace_id,version) VALUES(${w},${next}) ON CONFLICT(workspace_id) DO UPDATE SET version=excluded.version`,
  );
  await tx.execute(
    sql`INSERT INTO mail_ritual_configs(workspace_id,version,config,programs,owners) VALUES(${w},${next},${JSON.stringify(config)}::jsonb,${p.attachments.length ? JSON.stringify(p) : null}::jsonb,${JSON.stringify(p.owners)}::jsonb) ON CONFLICT(workspace_id) DO UPDATE SET version=excluded.version,config=excluded.config,programs=excluded.programs,owners=excluded.owners`,
  );
  const who = c.get('actor');
  await tx.execute(
    sql`INSERT INTO mail_routing_versions(workspace_id,version,route_ids,changed_ids,actor_type,actor_id,note) VALUES(${w},${next},ARRAY(SELECT id FROM mail_routes WHERE workspace_id=${w} ORDER BY match),ARRAY[]::text[],${who.credential ?? 'apiKey'},${who.keyId},'Rule configuration')`,
  );
  await tx.execute(
    sql`INSERT INTO mail_ritual_versions(workspace_id,version,config,actor) VALUES(${w},${next},${JSON.stringify(config)}::jsonb,${who.keyId})`,
  );
  await tx.execute(
    sql`DELETE FROM mail_ritual_versions WHERE workspace_id=${w} AND (version<=${next - 256} OR created_at<now()-interval '1 year');`,
  );
  await tx.execute(sql`DELETE FROM mail_routing_versions WHERE workspace_id=${w} AND version<=${next - 256}`);
  return { version: next, config };
}
const versionHeader = z.object({ 'if-match': z.string().max(32).optional() });
// Every saved version is audited with its version and what changed, never a rule's source.
type EditAudit = { action: string; target?: { type: string; id: string }; after?: (config: Config) => Record<string, unknown> };
const counts = (x: Config) => ({ rituals: x.rituals.length, attachments: x.attachments.length, senderLists: Object.keys(x.senderLists).length });
async function edit(c: Ctx, change: (config: Config, tx: DbExecutor) => Config | Promise<Config>, audit: EditAudit) {
  const w = receivingAdmin(c, 'change rules').workspaceId;
  return c.env.db.transaction(async (tx) => {
    await lockMailboxLane(tx, w, 'address');
    const s = await current(tx, w),
      expected = c.req.header('if-match')?.replace(/^"|"$/g, '');
    if (expected !== undefined && expected !== String(s.version))
      throw new ApiError(409, 'VERSION_CONFLICT', `Routing is now at version ${s.version}. Reload before saving.`);
    const result = await save(tx, c, w, RitualConfig.parse(await change(s.config, tx)), s.version);
    await recordAudit(tx, c, { action: audit.action, workspaceId: w, target: audit.target ?? { type: 'rituals', id: w }, before: { version: s.version }, after: { version: result.version, ...audit.after?.(result.config) } });
    c.header('ETag', `"${result.version}"`);
    return result;
  });
}
export function registerRituals(app: App) {
  both(app, {...meta,method:'get',path:path+'/history',operationId:'listRuleVersions',summary:'List saved rule versions, newest first',request:{query:z.object({cursor:z.coerce.number().int().positive().optional(),limit:z.coerce.number().int().min(1).max(100).default(25)})},responses:{200:response(z.object({data:z.array(z.object({version:z.number(),actor:z.string()})),nextCursor:z.number().nullable()})),...errors}},async c=>{const w=receivingAdmin(c).workspaceId,q=c.req.valid('query' as never) as {cursor?:number;limit:number},rows=(await c.env.db.execute<{version:number;actor:string}>(sql`SELECT version,actor FROM mail_ritual_versions WHERE workspace_id=${w} AND version<${Math.min(q.cursor??2147483647,2147483647)} ORDER BY version DESC LIMIT ${q.limit+1}`)).rows;return c.json({data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].version:null},200)});
  both(app, {...meta,method:'post',path:path+'/restore',operationId:'restoreRuleVersion',summary:'Recompile a retained version and restore it as a new version',request:{headers:versionHeader,body:json(z.object({version:z.number().int().positive()}))},responses:ok},async (c,family)=>{const w=receivingAdmin(c, 'change rules').workspaceId,v=(c.req.valid('json' as never) as {version:number}).version,row=v>2147483647?undefined:(await c.env.db.execute<{config:Config}>(sql`SELECT config FROM mail_ritual_versions WHERE workspace_id=${w} AND version=${v}`)).rows[0];if(!row)throw new ApiError(404,'NOT_FOUND','Version no longer retained.');return c.json(stateOf(family,await edit(c,()=>row.config,{action:'ritual.restore',after:x=>({restoredVersion:v,...counts(x)})})),200)},{responses:legacyOk});
  const evalSettings=RitualConfig.pick({evaluateDomains:true,evaluateRoutes:true});
  both(app, {...meta,method:'put',path:path+'/decisions',operationId:'setDecisionOptIns',summary:'Set the domains and routes whose mail the AI may read for decisions',request:{headers:versionHeader,body:json(evalSettings)},responses:ok},async (c,family)=>c.json(stateOf(family,await edit(c,x=>({...x,...(c.req.valid('json' as never) as z.infer<typeof evalSettings>)}),{action:'ritual.omens',after:x=>({evaluateDomains:x.evaluateDomains,evaluateRoutes:x.evaluateRoutes})})),200),{responses:legacyOk},LEGACY_RULES_PATH+'/omens');
  registerEndpoints(app);
  registerInboxConnection(app);
  registerRitualVersion(app);
  const diagnostic = (family: Family) => z.object({ [family === 'rules' ? 'rule' : 'ritual']: z.string().optional().describe('The rule the problem is in.'), line: z.number().int(), column: z.number().int(), endLine: z.number().int(), endColumn: z.number().int(), message: z.string(), hint: z.string().optional() }).openapi(family === 'rules' ? 'RuleDiagnostic' : 'RitualDiagnostic');
  const check = (family: Family) => z.object({ ok: z.boolean(), diagnostics: z.array(diagnostic(family)), calls: z.array(z.string()).describe('Endpoints and inboxes the rule calls.'), [family === 'rules' ? 'decisions' : 'omens']: z.array(z.string()).describe('The names of the AI decisions it asks for.'), questions: z.record(z.string(), z.string()).describe('Decision name → its question. testRules takes scores keyed by question.'), lists: z.array(z.string()) }).openapi(family === 'rules' ? 'RuleCheck' : 'RitualCheck');
  both(app, {
    ...meta, method: 'post', path: path + '/check', operationId: 'checkRule',
    summary: 'Compile one rule source against this workspace without saving',
    description: 'Returns every problem with its line, column and a hint, and what the rule calls. Use it while editing; nothing is saved, delivered or sent to the AI.',
    request: { body: json(z.object({ source: z.string().max(65536), key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default('draft'), senderLists: RitualConfig.shape.senderLists.optional().describe('Lists to check against. Defaults to the saved sender lists.') }).strict()) },
    responses: { 200: response(check('rules')), ...errors },
  }, async (c, family) => {
    const w = receivingAdmin(c).workspaceId, q = c.req.valid('json' as never) as { source: string; key: string; senderLists?: Config['senderLists'] }, saved = await current(c.env.db, w);
    const config = RitualConfig.parse({ rituals: [{ key: q.key, source: q.source }], senderLists: q.senderLists ?? saved.config.senderLists });
    const { programs, diagnostics } = await analyze(c.env.db, w, config);
    let ir = programs?.rituals[q.key];
    if (!ir) try { ir = compileRitual(q.source); } catch { /* reported in diagnostics */ }
    const asked = Object.keys(ir?.omens ?? {});
    return c.json({ ok: !diagnostics.length, diagnostics: family === 'rules' ? diagnostics.map(ruleDiagnostic) : diagnostics, calls: ir?.refs.map(r => r.startsWith('inbox:') ? `inbox.deliver("${r.slice(6)}")` : endpointCall(r.slice(9))) ?? [], ...(family === 'rules' ? { decisions: asked } : { omens: asked }), questions: Object.fromEntries(Object.entries(ir?.omens ?? {}).map(([name, d]) => [name, d.prompt])), lists: [...new Set(ir?.lists?.map(l => l.name) ?? [])] }, 200);
  }, { responses: { 200: response(check('rituals')), ...errors } });
  const workspaceSymbols = async (c: Ctx) => {
    const w = receivingAdmin(c).workspaceId;
    const [endpoints, inboxes, saved] = await Promise.all([
      c.env.db.execute<{ name: string; type: EndpointType; status: string }>(sql`SELECT key AS name,type,CASE WHEN declined_at IS NOT NULL THEN 'declined' WHEN verified THEN 'ready' ELSE 'pending' END AS status FROM mailbox_webhooks
        WHERE workspace_id=${w} AND key IS NOT NULL ORDER BY key LIMIT 1000`),
      c.env.db.execute<{ key: string }>(sql`SELECT key FROM mailboxes WHERE workspace_id=${w} AND key IS NOT NULL ORDER BY key LIMIT 1000`),
      current(c.env.db, w),
    ]);
    return { endpoints: endpoints.rows, inboxes: inboxes.rows.map(r => r.key), lists: Object.keys(saved.config.senderLists) };
  };
  const typings = z.object({ typescript: z.string(), completions: z.array(z.object({ label: z.string(), type: z.enum(['function', 'property', 'variable', 'keyword']), detail: z.string(), info: z.string(), apply: z.string().optional() })), endpoints: z.array(z.object({ name: z.string(), type: z.enum(['slack', 'discord', 'webhook', 'forward']), status: z.string() })), inboxes: z.array(z.string()), lists: z.array(z.string()) });
  both(app, {
    ...meta, method: 'get', path: path + '/typings', operationId: 'getRuleTypings',
    summary: 'TypeScript declarations and editor completions for this workspace',
    description: 'Generated from the workspace’s endpoints, inbox keys and sender lists. Load typescript into an editor as a .d.ts, or read it to learn exactly what a rule can call.',
    responses: { 200: response(typings.openapi('RuleTypings')), ...errors },
  }, async (c, family) => {
    const symbols = await workspaceSymbols(c), earlierNames = family === 'rituals';
    c.header('Cache-Control', 'no-store');
    return c.json({ typescript: ritualTypings(symbols, earlierNames), completions: ritualCompletions(symbols, earlierNames), ...symbols }, 200);
  }, { responses: { 200: response(typings.openapi('RitualTypings')), ...errors } });
  const templates = z.object({ data: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), needs: z.enum(['slack', 'discord', 'webhook', 'forward']).nullable(), endpoint: z.string().nullable(), source: z.string() })) });
  both(app, {
    ...meta, method: 'get', path: path + '/templates', operationId: 'listRuleTemplates',
    summary: 'Starting points for common rules, filled in with this workspace’s endpoints',
    description: 'Each template compiles. An endpoint template uses the first endpoint of the type it needs; endpoint is null when there is none yet, and source then uses a placeholder name to replace.',
    responses: { 200: response(templates.openapi('RuleTemplates')), ...errors },
  }, async (c, family) => {
    const { endpoints } = await workspaceSymbols(c);
    return c.json({ data: ritualTemplates.map(t => {
      const endpoint = t.needs ? endpoints.find(e => e.type === t.needs && e.status === 'ready')?.name ?? null : null;
      const shown = family === 'rituals' && t.before ? { ...t, ...t.before } : t;
      return { id: shown.id, name: t.name, description: shown.description, needs: t.needs ?? null, endpoint, source: shown.source(endpoint ?? undefined) };
    }) }, 200);
  }, { responses: { 200: response(templates.openapi('RitualTemplates')), ...errors } });
  const params=z.object({key:z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)}),item=path+'/scripts/{key}';
  registerRecipes(app, item, params);
  both(app, {...meta,method:'get',path:item,operationId:'getRule',summary:'Read one rule',request:{params},responses:{200:response(Rule),...errors}},async c=>{const {key}=c.req.valid('param' as never) as {key:string},s=await current(c.env.db,receivingAdmin(c).workspaceId),r=s.config.rituals.find(x=>x.key===key);if(!r)throw new ApiError(404,'NOT_FOUND','Rule not found.');return c.json(r,200)},{responses:{200:response(Ritual),...errors}});
  both(app, {...meta,method:'put',path:item,operationId:'saveRule',summary:'Create or update one rule',request:{params,headers:versionHeader,body:json(Rule)},responses:ok},async (c,family)=>{const {key}=c.req.valid('param' as never) as {key:string},r=c.req.valid('json' as never) as z.infer<typeof Rule>;if(key!==r.key)throw new ApiError(422,'INVALID_KEY','The rule key must match the URL.');return c.json(stateOf(family,await edit(c,s=>{const prev=s.rituals.find(h=>h.key===key);return {...s,rituals:[...s.rituals.filter(h=>h.key!==key),{...r,recipe:r.recipe??prev?.recipe,enabled:r.enabled??prev?.enabled}]};},{action:'ritual.save',target:{type:'ritual',id:key},after:()=>({key})})),200)},{request:{params,headers:versionHeader,body:json(Ritual)},responses:legacyOk});
  both(app, {...meta,method:'delete',path:item,operationId:'deleteRule',summary:'Remove a rule and detach it everywhere',request:{params,headers:versionHeader},responses:ok},async (c,family)=>{const {key}=c.req.valid('param' as never) as {key:string};return c.json(stateOf(family,await edit(c,s=>({...s,rituals:s.rituals.filter(h=>h.key!==key),attachments:s.attachments.filter(h=>h.ritual!==key)}),{action:'ritual.delete',target:{type:'ritual',id:key},after:()=>({key})})),200)},{responses:legacyOk});
  both(app, {
    ...meta, method: 'put', path: path + '/attachments', operationId: 'attachRules',
    summary: 'Attach, reorder and detach rules by replacing the ordered attachment list',
    request: { headers: versionHeader, body: json(z.object({ attachments: z.array(RuleBindingInput).max(256) })) },
    responses: ok,
  }, async (c, family) => {
    const { attachments } = c.req.valid('json' as never) as { attachments: z.infer<typeof RuleBindingInput>[] };
    return c.json(stateOf(family, await edit(c, (config) => ({ ...config, attachments: bindingsFrom(attachments) }), { action: 'ritual.attach', after: (x) => ({ attachments: x.attachments.length, rituals: [...new Set(x.attachments.map((b) => b.ritual))] }) })), 200);
  }, { responses: legacyOk });
  both(app, {
    ...meta, method: 'get', path, operationId: 'getRules',
    summary: 'Read rules, ordered attachments, and sender lists',
    request: { query: z.object({ version: z.coerce.number().int().positive().optional() }) },
    responses: ok,
  }, async (c, family) => {
    const w = receivingAdmin(c).workspaceId, v = (c.req.valid('query' as never) as { version?: number }).version;
    // Versions are Postgres integers: a larger one cannot exist (and would fail the cast with a 500).
    const r = v
      ? v > 2147483647 ? undefined : (await c.env.db.execute<{ config: Config; version: number }>(sql`SELECT config,version FROM mail_ritual_versions WHERE workspace_id=${w} AND version=${v}`)).rows[0]
      : await current(c.env.db, w);
    if (!r) throw new ApiError(404, 'NOT_FOUND', 'Rule version not found.');
    c.header('ETag', `"${r.version}"`);
    return c.json(stateOf(family, r), 200);
  }, { responses: legacyOk });
  both(app, {
    ...meta, method: 'put', path, operationId: 'applyRules',
    summary: 'Create, replace or remove rules and ordered attachments in one version',
    request: { headers: versionHeader, body: json(RuleConfigInput) },
    responses: ok,
  }, async (c, family) => c.json(stateOf(family, await edit(c, () => configFrom(c.req.valid('json' as never)), { action: 'ritual.apply', after: counts })), 200), { responses: legacyOk });
  const dry = z
    .object({
      config: RuleConfigInput.optional(),
      messageId: z.string().max(128).optional(),
      mime: z.string().max(256 * 1024).optional(),
      to: z.array(z.email()).min(1).max(100).optional(),
      scores: z.record(z.string().max(500), z.number().min(0).max(1)).optional(),
    })
    .strict();
  const tested = (row: typeof TraceRow | typeof LegacyTraceRow) => z.object({ version: z.number(), recipients: z.array(z.record(z.string(), z.unknown())), trace: z.array(row), steps: z.number() });
  both(app, {
    ...meta, method: 'post', path: path + '/test', operationId: 'testRules',
    summary: 'Trace saved or proposed rules on a stored message or pasted MIME; never asks the AI or delivers mail',
    request: { body: json(dry) },
    responses: { 200: response(tested(TraceRow)), ...errors },
  }, async (c, family) => {
    const w = receivingAdmin(c).workspaceId, q = c.req.valid('json' as never) as z.infer<typeof dry>;
    if (!!q.messageId === !!q.mime) throw new ApiError(422, 'INVALID_TEST', 'Supply messageId or mime.');
    let email: ReturnType<typeof projectEmail>,
      scores = q.scores;
    if (q.messageId) {
      actor(c,'manage');
      const [m] = await c.env.db.select().from(mailMessages).where(and(eq(mailMessages.workspaceId, w), eq(mailMessages.id, q.messageId), eq(mailMessages.direction, 'inbound'), retainedMail()));
      if (!m) throw new ApiError(404, 'NOT_FOUND', 'Stored inbound message not found.');
      const files = await c.env.db.select().from(mailAttachments).where(and(eq(mailAttachments.workspaceId, w), eq(mailAttachments.messageId, m.id)));
      const v = m.verdicts as typeof m.verdicts & { ritualVerified?: boolean; ritualScores?: Record<string, number> };
      email = projectEmail(m, files, v.ritualVerified === true);
      scores ??= v.ritualScores;
    } else {
      const { parseInboundMime, flatten, headersOf } = await import('./mailbox-ingest.js');
      const bytes = Buffer.from(q.mime!),
        m = await parseInboundMime(bytes);
      if (!m) throw new ApiError(422, 'INVALID_MIME', 'Paste a MIME message within the parser limits.');
      const to = flatten(m.to),
        cc = flatten(m.cc);
      email = projectEmail(
        {
          id: 'msg_preview',
          workspaceId: w,
          direction: 'inbound',
          fromAddress: flatten(m.from)[0]?.address,
          fromName: flatten(m.from)[0]?.name,
          subject: m.subject,
          text: m.text,
          html: m.html,
          headers: headersOf(m),
          to,
          cc,
          replyTo: flatten(m.replyTo),
          envelopeTo: q.to ?? [...to, ...cc].map((a) => a.address),
          receivedAt: new Date().toISOString(),
          sizeBytes: bytes.length,
          verdicts: {},
          status: 'received',
        },
        m.attachments.map((a, i) => ({
          id: 'preview_' + i,
          filename: a.filename ?? `attachment-${i + 1}`,
          contentType: a.mimeType,
          sizeBytes: typeof a.content === 'string' ? Buffer.byteLength(a.content) : a.content.byteLength,
          contentId: a.contentId,
        })),
        false,
      );
    }
    if (q.to) email.envelope.to = q.to;
    if (!email.envelope.to.length || email.envelope.to.length > 100)
      throw new ApiError(422, 'INVALID_TEST', 'Supply 1–100 envelope recipients.');
    const { input, version } = await rolledBack(c.env.db, async (tx) => {
      await lockMailboxLane(tx, w, 'address');
      const s = await current(tx, w);
      if (q.config) await save(tx, c, w, configFrom(q.config), s.version,true);
      const input = (
        await tx.execute<{ p: RoutingInput }>(
          sql`SELECT mail_route_input(${w},${JSON.stringify(email.envelope.to)}::jsonb,true,${receivingPolicy(c.env.config)}::jsonb) AS p`,
        )
      ).rows[0].p;
      input.programs ??= compileConfig(RitualConfig.parse({}));
      return { input, version: s.version };
    });
    const { plan, trace, steps } = await ritualPipeline(c.env, w, input, email, scores, true);
    if (family === 'rituals') return c.json({ version, recipients: plan.recipients, trace: trace.map(row => ({ ...row, timeline: row.timeline.map(step => step.kind === 'decisions' ? { ...step, kind: 'omens' as const } : step) })), steps }, 200);
    // The rule operations name each endpoint call's stable action ID actionId, and each trace row's kind rule.
    const recipients = plan.recipients.map(r => 'actions' in r && r.actions ? { ...r, actions: Object.fromEntries(Object.entries(r.actions).map(([id, list]) => [id, list.map(({ ritualAction, ...a }) => ({ actionId: ritualAction, ...a }))])) } : r);
    return c.json({ version, recipients, trace: trace.map(row => ({ ...row, kind: row.kind === 'ritual' ? 'rule' : row.kind })), steps }, 200);
  }, { responses: { 200: response(tested(LegacyTraceRow)), ...errors } });
}

// ---------------------------------------------------------------- recipes: ready-made rules
const recipeField = z.object({
  name: z.string(), type: z.enum(['slack', 'discord', 'chat', 'forward', 'webhook', 'meaning', 'label', 'senders']).describe('slack, discord, chat (Slack or Discord), forward and webhook take the name of an endpoint of that type (createEndpoint); meaning is what the AI looks for, like "a refund request"; label is one label; senders is a list of addresses and @domains.'),
  label: z.string(), placeholder: z.string().nullable(), hint: z.string().nullable(),
});
/** The recipe catalog: the rule operations say decisions, the aliases omens, its name before the rename. */
const recipeCatalog = (family: Family) => {
  const [asks, price, name] = family === 'rules' ? ['decisions', 'decisionPricePerThousand', 'Rule'] : ['omens', 'omenPricePerThousand', 'Ritual'];
  return z.object({
    groups: z.array(z.object({ id: z.string(), title: z.string() })).describe('The order recipes are grouped in.'),
    data: z.array(z.object({
      id: z.string(), group: z.string(), name: z.string(), description: z.string(),
      sentence: z.string().describe('What a rule made from it does, with {field} where each parameter goes.'),
      fields: z.array(recipeField.openapi(`${name}RecipeField`)),
      [asks]: z.boolean().describe('Asks the AI about each email (an AI decision), billed per email checked. Saving one lets the AI read mail at those addresses’ domains.'),
    }).openapi(`${name}Recipe`)),
    [price]: z.string().describe('USD per 1,000 emails an AI decision checks.'),
  }).openapi(`${name}Recipes`);
};
const RecipeInputParams = RuleRecipeRef.shape.params;
const RecipeAddresses = z.array(z.string().min(1).max(254)).min(1).max(10).describe('Inbox IDs (mbx_…) or receiving addresses it runs on.');
type TargetRow = { address: string; mailbox_id: string; kind: string };
const targetRows = async (tx: DbExecutor, w: string, targets: string[]) => {
  const list = JSON.stringify([...new Set(targets)]);
  return (await tx.execute<TargetRow>(sql`SELECT address,mailbox_id,kind FROM mailbox_addresses WHERE workspace_id=${w}
    AND (address IN (SELECT jsonb_array_elements_text(${list}::jsonb)) OR mailbox_id IN (SELECT jsonb_array_elements_text(${list}::jsonb)))`)).rows;
};
/** The address each attachment target names (its primary address for an inbox ID); an unknown target is refused. */
async function targetAddresses(tx: DbExecutor, w: string, targets: string[]) {
  const rows = await targetRows(tx, w, targets);
  return targets.map(t => {
    const row = rows.find(r => r.address === t) ?? rows.find(r => r.mailbox_id === t && r.kind === 'primary') ?? rows.find(r => r.mailbox_id === t);
    if (!row) throw new ApiError(422, 'UNKNOWN_TARGET', `No receiving inbox or address ${t} in this workspace.`, 'addresses');
    return row.address;
  });
}
/** The inbox an attachment target reaches: an address and its inbox's ID run on the same mail, in config order. */
async function targetInboxes(tx: DbExecutor, w: string, targets: string[]) {
  const rows = await targetRows(tx, w, targets), inbox = new Map(rows.map(r => [r.address, r.mailbox_id]));
  return (target: string) => inbox.get(target) ?? target;
}
const stageOf = (config: Config, key: string) => { const r = config.rituals.find(x => x.key === key); return r?.recipe ? ritualRecipes.find(x => x.id === r.recipe!.id)?.stage ?? 2 : 3; };
/** Attaches `key` to each target it isn't on yet: after the address's recipes of its stage and before any later stage
 *  or script, so recipes act independently (continue) and a script's "stop the rest" never silences one. Attachments
 *  on targets no longer listed are removed; the rest keep their place. */
function placeRecipe(config: Config, key: string, targets: string[], inbox: (target: string) => string): Config['attachments'] {
  const stage = stageOf(config, key);
  let list = config.attachments.filter(a => a.ritual !== key || targets.includes(a.target));
  for (const target of targets) {
    if (list.some(a => a.ritual === key && a.target === target)) continue;
    const at = list.findIndex(a => inbox(a.target) === inbox(target) && stageOf(config, a.ritual) > stage);
    const entry = { ritual: key, target, continue: true };
    list = at < 0 ? [...list, entry] : [...list.slice(0, at), entry, ...list.slice(at)];
  }
  return list;
}
const freeKey = (config: Config, base: string) => {
  const stem = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'rule';
  for (let n = 1; ; n++) { const key = n === 1 ? stem : `${stem}-${n}`; if (!config.rituals.some(r => r.key === key)) return key; }
};
function registerRecipes(app: App, item: string, keyParams: z.ZodObject<{ key: z.ZodString }>) {
  both(app, {
    ...meta, method: 'get', path: path + '/recipes', operationId: 'listRuleRecipes',
    summary: 'Ready-made rules and the fields each one takes',
    description: 'Each recipe writes an ordinary rule from one or two fields. Create one with createRuleFromRecipe; endpoint fields name an endpoint of the right type, created first with createEndpoint.',
    responses: { 200: response(recipeCatalog('rules')), ...errors },
  }, async (c, family) => {
    receivingAdmin(c);
    c.header('Cache-Control', 'no-store');
    const [asks, price] = family === 'rules' ? ['decisions', 'decisionPricePerThousand'] : ['omens', 'omenPricePerThousand'];
    return c.json({
      groups: recipeGroups,
      data: ritualRecipes.map(r => ({ id: r.id, group: r.group, name: r.name, description: r.description, sentence: r.sentence, [asks]: r.decisions, fields: r.fields.map(f => ({ name: f.name, type: f.type, label: f.label, placeholder: f.placeholder ?? null, hint: f.hint ?? null })) })),
      [price]: (Number(RATES.omenUc) * 1000 / 1e8).toFixed(2),
    }, 200);
  }, { responses: { 200: response(recipeCatalog('rituals')), ...errors } });
  // Writes a recipe's rule into the config: its source, its recipe, where it runs and, for an AI recipe, the decision
  // opt-in for the domains of those addresses.
  async function apply(config: Config, tx: DbExecutor, w: string, key: string, recipeId: string, input: RecipeParams, addresses: string[] | undefined, enabled: boolean | undefined) {
    const built = buildRecipe(recipeId, input, await endpointKinds(tx, w));
    if (!built.ok) throw new ApiError(422, built.field === 'recipe' ? 'UNKNOWN_RECIPE' : 'INVALID_RECIPE', built.message, built.field);
    const prev = config.rituals.find(r => r.key === key);
    const rule = { key, source: built.source, recipe: { id: built.recipe.id, params: built.params }, ...((enabled ?? prev?.enabled) === false ? { enabled: false } : {}) };
    const next: Config = { ...config, rituals: prev ? config.rituals.map(r => r.key === key ? rule : r) : [...config.rituals, rule] };
    const targets = addresses ? [...new Set(addresses)] : config.attachments.filter(a => a.ritual === key).map(a => a.target);
    const named = addresses || built.recipe.decisions ? await targetAddresses(tx, w, targets) : [];
    const hosts = built.recipe.decisions ? named.map(a => a.split('@')[1]!.toLowerCase()) : [];
    const inbox = await targetInboxes(tx, w, [...targets, ...next.attachments.map(a => a.target)]);
    return { ...next, attachments: placeRecipe(next, key, targets, inbox), evaluateDomains: [...new Set([...next.evaluateDomains, ...hosts])] };
  }
  const created = (s: typeof state | typeof legacyState) => s.extend({ key: z.string().describe('The new rule’s key.') });
  both(app, {
    ...meta, method: 'post', path: path + '/recipes', operationId: 'createRuleFromRecipe',
    summary: 'Create a rule from a recipe and attach it to addresses',
    description: 'Writes the recipe’s script, saves it as a new rule (key from the recipe and address unless given) and attaches it to each address, after their other recipes and before their own scripts. An AI recipe lets the AI read mail at those addresses’ domains. Returns the new version and key.',
    request: { headers: versionHeader, body: json(z.object({ recipe: z.string().max(40), params: RecipeInputParams, addresses: RecipeAddresses, key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(), enabled: z.boolean().optional() }).strict()) },
    responses: { 201: response(created(state)), ...errors },
  }, async (c, family) => {
    const q = c.req.valid('json' as never) as { recipe: string; params: RecipeParams; addresses: string[]; key?: string; enabled?: boolean }, w = receivingAdmin(c, 'change rules').workspaceId;
    let key = '';
    const result = await edit(c, async (config, tx) => {
      if (q.key && config.rituals.some(r => r.key === q.key)) throw new ApiError(409, 'RULE_EXISTS', `A rule named ${q.key} exists. Change it with updateRuleFromRecipe.`, 'key');
      // Named after the recipe and its first address unless a key is given: slack-support, slack-support-2.
      key = q.key ?? freeKey(config, `${q.recipe}-${(await targetAddresses(tx, w, [q.addresses[0]!]))[0]!.split('@')[0]}`);
      return apply(config, tx, w, key, q.recipe, q.params, q.addresses, q.enabled);
    }, { action: 'ritual.recipe', get target() { return { type: 'ritual', id: key }; }, after: () => ({ key, recipe: q.recipe }) });
    return c.json({ ...stateOf(family, result), key }, 201);
  }, { responses: { 201: response(created(legacyState)), ...errors } });
  both(app, {
    ...meta, method: 'put', path: item + '/recipe', operationId: 'updateRuleFromRecipe',
    summary: 'Change a rule’s recipe fields and addresses',
    description: 'Rewrites the rule from its recipe with these fields. addresses, when given, replaces where it runs (kept addresses keep their place). Passing recipe turns a script into that recipe.',
    request: { params: keyParams, headers: versionHeader, body: json(z.object({ recipe: z.string().max(40).optional(), params: RecipeInputParams, addresses: RecipeAddresses.optional(), enabled: z.boolean().optional() }).strict()) },
    responses: ok,
  }, async (c, family) => {
    const { key } = c.req.valid('param' as never) as { key: string }, q = c.req.valid('json' as never) as { recipe?: string; params: RecipeParams; addresses?: string[]; enabled?: boolean }, w = receivingAdmin(c, 'change rules').workspaceId;
    return c.json(stateOf(family, await edit(c, async (config, tx) => {
      const prev = config.rituals.find(r => r.key === key);
      if (!prev) throw new ApiError(404, 'NOT_FOUND', 'Rule not found.');
      const recipe = q.recipe ?? prev.recipe?.id;
      if (!recipe) throw new ApiError(422, 'NOT_A_RECIPE', `${key} is a script. Pass recipe to rewrite it from one, or edit it with saveRule.`, 'recipe');
      return apply(config, tx, w, key, recipe, q.params, q.addresses, q.enabled);
    }, { action: 'ritual.recipe', target: { type: 'ritual', id: key }, after: () => ({ key }) })), 200);
  }, { responses: legacyOk });
  both(app, {
    ...meta, method: 'patch', path: item, operationId: 'updateRule',
    summary: 'Turn a rule on or off',
    description: 'Off keeps the rule and where it runs, and stops it running until it is turned on again.',
    request: { params: keyParams, headers: versionHeader, body: json(z.object({ enabled: z.boolean() }).strict()) },
    responses: ok,
  }, async (c, family) => {
    const { key } = c.req.valid('param' as never) as { key: string }, { enabled } = c.req.valid('json' as never) as { enabled: boolean };
    return c.json(stateOf(family, await edit(c, config => {
      if (!config.rituals.some(r => r.key === key)) throw new ApiError(404, 'NOT_FOUND', 'Rule not found.');
      return { ...config, rituals: config.rituals.map(r => r.key === key ? { ...r, enabled } : r) };
    }, { action: enabled ? 'ritual.enable' : 'ritual.disable', target: { type: 'ritual', id: key }, after: () => ({ key, enabled }) })), 200);
  }, { responses: legacyOk });
}
