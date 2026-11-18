import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { actorMailAccess, ApiError, errors, id, isoTime, json, log, memberRefused, notFound, response, webhookUrlHint, wrapModuleLoad, type Actor, type App, type Ctx, type DbExecutor, type Runtime } from './core.js';
import { auditContext, auditInsert, type AuditContext } from './audit.js';
import { productName } from './brand.js';

// Support actions (api/README.md "Support integration"). A support conversation proposes one of a few fixed changes for
// its person; only that person, signed in to the dashboard, confirms it, and confirming runs the same function as the
// change's public route. Nightmail writes what the person approves from its own rows, so neither the support platform
// nor its model chooses the words. A DNS re-check needs no confirmation: it changes nothing but the stored status.

const KINDS = {
  retry_webhook_delivery: { route: '/v1/webhooks/{id}/deliveries/{deliveryId}/retry', access: 'webhooks', target: 'Delivery' },
  test_webhook: { route: '/v1/webhooks/{id}/test', access: 'webhooks', target: 'Webhook' },
  retry_inbound_delivery: { route: '/v1/inbound/webhooks/{id}/deliveries/{deliveryId}/retry', access: 'receiving', target: 'Delivery' },
  test_inbound_webhook: { route: '/v1/inbound/webhooks/{id}/test', access: 'receiving', target: 'Webhook' },
  redeliver_message: { route: '/v1/inbound/messages/{messageId}/redeliver', access: 'receiving', target: 'Message' },
  pause_campaign: { route: '/v1/campaigns/{id}/pause', access: 'campaigns', target: 'Campaign' },
} as const;
type Kind = keyof typeof KINDS;
/** Open proposals per conversation, and how long one stays open. */
export const OPEN_ACTIONS = 3, ACTION_HOURS = 24;

/** A person's dashboard actor in a workspace, as a signed-in session gets it (account-login.ts accountSessionActor). */
const personActor = (keyId: string, workspaceId: string, role: string, credential: 'dashboard' | 'support'): Actor =>
  ({ keyId, workspaceId, role, permissions: role === 'member' ? ['read', 'send'] : ['manage'], domains: [], credential });
/** Why the change's public route refuses this actor, or null: its path guard (app.ts memberRefused), then its own check. */
function refusal(kind: Kind, a: Actor) {
  const { route, access } = KINDS[kind];
  const allowed = !memberRefused(a, 'POST', route) && (access === 'webhooks' ? a.permissions.includes('manage') && !a.domains.length
    : access === 'receiving' ? actorMailAccess(a)?.admin === true : a.permissions.includes('manage') || a.permissions.includes('send'));
  return allowed ? null : new ApiError(403, 'PERMISSION_DENIED', 'This operation requires a workspace owner or admin.');
}

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const Proposal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retry_webhook_delivery'), webhookId: Id, deliveryId: Id }).strict(),
  z.object({ kind: z.literal('test_webhook'), webhookId: Id }).strict(),
  z.object({ kind: z.literal('retry_inbound_delivery'), webhookId: Id, deliveryId: Id }).strict(),
  z.object({ kind: z.literal('test_inbound_webhook'), webhookId: Id }).strict(),
  z.object({ kind: z.literal('redeliver_message'), messageId: Id, webhookId: Id.optional().describe('Only this endpoint; omit for every route webhook that finished with the message.') }).strict(),
  z.object({ kind: z.literal('pause_campaign'), campaignId: Id }).strict(),
]).openapi('SupportActionProposal');
type Target = Omit<z.infer<typeof Proposal>, 'kind'>;
type Targets = Partial<Record<'webhookId' | 'deliveryId' | 'messageId' | 'campaignId', string>>;
const Status = z.enum(['proposed', 'running', 'done', 'failed', 'declined', 'expired']);
const Action = z.object({
  id: z.string(), kind: z.enum(Object.keys(KINDS) as [Kind, ...Kind[]]),
  status: Status.describe('proposed: waiting for the customer; running: a test is posting; done or failed: what the public route answered; declined; expired after 24 hours.'),
  summary: z.string().describe(`What the customer approves, written by ${productName} from its own records.`),
  workspaceId: z.string(), target: z.record(z.string(), z.string()),
  url: z.string().describe('Where the customer confirms or declines it, signed in.'),
  result: z.record(z.string(), z.unknown()).nullable().describe('The public route’s answer when it ran.'),
  error: z.object({ code: z.string(), message: z.string() }).nullable().describe('The public route’s error when it refused.'),
  createdAt: z.string(), expiresAt: z.string(), resolvedAt: z.string().nullable(),
}).openapi('SupportAction');
type Row = { id: string; conversation_id: string; user_id: string; workspace_id: string; kind: Kind; target: Targets; summary: string; status: 'proposed' | 'running' | 'done' | 'failed' | 'declined';
  result: { body?: Record<string, unknown>; error?: { code: string; message: string } } | null; created_at: string; expires_at: string; resolved_at: string | null; expired: boolean };
const columns = sql`id, conversation_id, user_id, workspace_id, kind, target, summary, status, result, created_at::text, expires_at::text, resolved_at::text, expires_at <= now() AS expired`;
const view = (c: Ctx, row: Row): z.infer<typeof Action> => ({
  id: row.id, kind: row.kind, status: row.status === 'proposed' && row.expired ? 'expired' : row.status, summary: row.summary, workspaceId: row.workspace_id, target: row.target as Record<string, string>,
  url: `${new URL(c.env.config.publicUrl).origin}/support/actions/${row.id}`, result: row.result?.body ?? null, error: row.result?.error ?? null,
  createdAt: isoTime(row.created_at)!, expiresAt: isoTime(row.expires_at)!, resolvedAt: isoTime(row.resolved_at),
});

// ---------- the summary, from Nightmail's own rows ----------

type Facts = { workspace_id: string; workspace: string; url?: string | null; status?: string; attempts?: number; event?: string | null; at?: string; campaign?: string; expanded?: number; total?: number };
/** The target's row in one of these workspaces, with what its summary names. */
function factsOf(kind: Kind, t: Targets, ids: string[]): SQL {
  const scope = sql`${sql.param(ids)}::text[]`;
  switch (kind) {
    case 'retry_webhook_delivery': return sql`SELECT d.workspace_id, w.name AS workspace, h.url, d.status, d.attempt_count AS attempts, d.payload->>'type' AS event
      FROM operation_deliveries d JOIN operation_webhooks h ON h.id = d.webhook_id AND h.workspace_id = d.workspace_id JOIN workspaces w ON w.id = d.workspace_id
      WHERE d.id = ${t.deliveryId} AND d.webhook_id = ${t.webhookId} AND d.workspace_id = ANY(${scope})`;
    case 'test_webhook': return sql`SELECT h.workspace_id, w.name AS workspace, h.url FROM operation_webhooks h JOIN workspaces w ON w.id = h.workspace_id
      WHERE h.id = ${t.webhookId} AND h.workspace_id = ANY(${scope})`;
    case 'retry_inbound_delivery': return sql`SELECT d.workspace_id, w.name AS workspace, h.url, d.status, d.attempt_count AS attempts
      FROM mailbox_webhook_deliveries d JOIN mailbox_webhooks h ON h.id = d.webhook_id AND h.workspace_id = d.workspace_id AND h.type = 'webhook' JOIN workspaces w ON w.id = d.workspace_id
      WHERE d.id = ${t.deliveryId} AND d.webhook_id = ${t.webhookId} AND d.workspace_id = ANY(${scope})`;
    case 'test_inbound_webhook': return sql`SELECT h.workspace_id, w.name AS workspace, h.url FROM mailbox_webhooks h JOIN workspaces w ON w.id = h.workspace_id
      WHERE h.id = ${t.webhookId} AND h.type = 'webhook' AND h.workspace_id = ANY(${scope})`;
    case 'redeliver_message': return sql`SELECT m.workspace_id, w.name AS workspace, m.received_at::text AS at, h.url, h.id IS NOT NULL OR ${t.webhookId ?? null}::text IS NULL AS found
      FROM mail_messages m JOIN workspaces w ON w.id = m.workspace_id LEFT JOIN mailbox_webhooks h ON h.id = ${t.webhookId ?? null} AND h.workspace_id = m.workspace_id
      WHERE m.id = ${t.messageId} AND m.direction = 'inbound' AND m.workspace_id = ANY(${scope})`;
    case 'pause_campaign': return sql`SELECT c.workspace_id, w.name AS workspace, c.draft->>'name' AS campaign, c.state AS status, c.expanded, c.total
      FROM sending_campaigns c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ${t.campaignId} AND c.workspace_id = ANY(${scope})`;
  }
}
/** A name someone typed, as one short line. */
const named = (value: string | null | undefined) => `“${(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, 80)}”`;
const tries = (n = 0) => `${n} attempt${n === 1 ? '' : 's'}`;
function summaryOf(kind: Kind, t: Targets, f: Facts) {
  const where = `in the workspace ${named(f.workspace)}`, endpoint = f.url ? `ending ${webhookUrlHint(f.url)}` : t.webhookId;
  switch (kind) {
    case 'retry_webhook_delivery': return `Retry the ${f.event ?? 'event'} webhook delivery ${t.deliveryId} to your sending webhook ${endpoint}, ${where}. It is ${f.status} after ${tries(f.attempts)}.`;
    case 'test_webhook': return `Send a test email.delivered event to your sending webhook ${endpoint}, ${where}. No email is sent.`;
    case 'retry_inbound_delivery': return `Retry delivery ${t.deliveryId} of received mail to your inbound webhook ${endpoint}, ${where}. It is ${f.status} after ${tries(f.attempts)}.`;
    case 'test_inbound_webhook': return `Send a test message.received event for an example message to your inbound webhook ${endpoint}, ${where}.`;
    case 'redeliver_message': return `Redeliver the message ${t.messageId}, received ${isoTime(f.at)}, to ${t.webhookId ? `your endpoint ${endpoint}` : 'every route webhook that already finished with it'}, ${where}.`;
    case 'pause_campaign': return `Pause the campaign ${named(f.campaign)} (${t.campaignId}) ${where}. It stops releasing new recipients (${f.expanded} of ${f.total} released so far); resuming continues from the same place.`;
  }
}

// ---------- confirming: the public route's own function, once ----------

/** Runs a confirmed action's change in the caller's transaction (a test posts after it). Returns the public route's body. */
async function perform(runtime: Runtime, tx: DbExecutor, row: Row, a: Actor, audit: AuditContext): Promise<Record<string, unknown>> {
  const t = row.target as Required<Targets>;
  switch (row.kind) {
    case 'retry_webhook_delivery': return (await wrapModuleLoad(() => import('./operations.js'))).retrySendingDelivery(runtime, tx, a, t.webhookId, t.deliveryId);
    case 'test_webhook': return (await wrapModuleLoad(() => import('./operations.js'))).testSendingWebhook(runtime, tx, a, t.webhookId);
    case 'retry_inbound_delivery': await (await wrapModuleLoad(() => import('./endpoints.js'))).retryInboundDelivery(tx, a.workspaceId, t.webhookId, t.deliveryId); return { ok: true };
    case 'redeliver_message': return { queued: await (await wrapModuleLoad(() => import('./endpoints.js'))).redeliverMessage(tx, a.workspaceId, t.messageId, row.target.webhookId) };
    case 'test_inbound_webhook': return (await wrapModuleLoad(() => import('./endpoints.js'))).testInboundWebhook(runtime, a.workspaceId, t.webhookId);
    case 'pause_campaign': await (await wrapModuleLoad(() => import('./sending.js'))).pauseSendingCampaign(runtime, tx, a, t.campaignId, audit); return { id: t.campaignId, state: 'paused' };
  }
}
/** What the request wakes once it commits, as the public route would (app.ts wakes after the response). */
function woken(row: Row, a: Actor, body: Record<string, unknown>) {
  if (row.kind === 'retry_inbound_delivery') a.wakeJobs = 1;
  if (row.kind === 'redeliver_message') a.wakeJobs = Number(body.queued) || 0;
  if (row.kind !== 'redeliver_message' && row.kind !== 'pause_campaign') a.wakeJobPool = 'webhook';
}
/** A refusal of the public route, as the action records it; anything else is a server failure. */
const refusedBy = (error: unknown) => error instanceof ApiError ? { error: { code: error.code, message: error.message } } : null;
/** The internal trail of a confirmed or declined action: the person who decided, from their dashboard session. */
const decided = (context: AuditContext, row: Row, details: Record<string, unknown>) => auditInsert(context, { action: 'support.action', workspaceId: row.workspace_id, target: { type: 'support_action', id: row.id },
  details: { kind: row.kind, target: row.target, ...details }, ticketRef: row.conversation_id, internal: true });

export function registerSupportActions(app: App) {
  const tags = ['Support (internal)'], security: Record<string, string[]>[] = [{ bearerAuth: [] }];
  const describe = (text: string) => `${text} Internal: for ${productName} support, for one support conversation, never for customers.`;
  const conversationOf = (c: Ctx) => {
    const support = c.get('support'), conversation = support?.conversation;
    if (!support || !conversation) throw new ApiError(403, 'SUPPORT_CONVERSATION_REQUIRED', 'Only a support conversation proposes actions.');
    const filter = c.req.query('workspaceId');
    // supportGate kept the workspaces where the person's role may make these changes (SUPPORT_CEILINGS).
    return { id: conversation.id, userId: support.userId, workspaces: support.workspaces.filter(w => !filter || w.id === filter) };
  };

  // A proposal needs a workspace where the person may act: with none, nothing in any body could be one.
  app.use('/v1/support/actions', async (c, next) => {
    if (c.req.method === 'POST' && c.get('support')?.conversation && !c.get('support')!.workspaces.length) notFound('Workspace');
    await next();
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/support/actions', operationId: 'proposeSupportAction', tags, security,
    description: describe(`Propose a change the customer confirms signed in: retry or redeliver webhook mail, test a webhook, or pause a campaign. ${productName} checks the target is in the conversation’s scope and that the customer’s role may make it there, writes the summary from its own records, and keeps it open 24 hours. At most ${OPEN_ACTIONS} are open per conversation; proposing the same change again answers the open one.`),
    request: { body: json(Proposal) }, responses: { 200: response(Action), 201: response(Action), ...errors } }), async c => {
    const conversation = conversationOf(c), { kind, ...target } = c.req.valid('json') as { kind: Kind } & Target, targets = target as Targets;
    const proposed = await c.env.db.transaction(async tx => {
      // Proposals for one conversation take turns: the count below sees every one proposed before it.
      await tx.execute(sql`SELECT id FROM support_conversations WHERE id = ${conversation.id} FOR UPDATE`);
      const { rows: [facts] } = await tx.execute<Facts & { found?: boolean }>(factsOf(kind, targets, conversation.workspaces.map(w => w.id)));
      if (!facts) notFound(KINDS[kind].target);
      if (facts.found === false) notFound('Webhook');
      const role = conversation.workspaces.find(w => w.id === facts.workspace_id)!.role, refused = refusal(kind, personActor(`user_${conversation.userId}`, facts.workspace_id, role, 'dashboard'));
      if (refused) throw refused;
      const { rows: [open] } = await tx.execute<Row>(sql`SELECT ${columns} FROM support_actions WHERE conversation_id = ${conversation.id} AND kind = ${kind} AND target = ${JSON.stringify(targets)}::jsonb
        AND status = 'proposed' AND expires_at > now() LIMIT 1`);
      if (open) return { row: open, created: false };
      const { rows: [count] } = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM support_actions WHERE conversation_id = ${conversation.id} AND status = 'proposed' AND expires_at > now()`);
      if (count!.n >= OPEN_ACTIONS) throw new ApiError(409, 'SUPPORT_ACTIONS_OPEN', `This conversation already has ${OPEN_ACTIONS} open proposals. Wait until the customer confirms or declines one, or it expires.`);
      const { rows: [row] } = await tx.execute<Row>(sql`INSERT INTO support_actions(id, conversation_id, user_id, workspace_id, kind, target, summary, expires_at)
        VALUES (${id('sac')}, ${conversation.id}, ${conversation.userId}, ${facts.workspace_id}, ${kind}, ${JSON.stringify(targets)}::jsonb, ${summaryOf(kind, targets, facts)}, now() + ${`${ACTION_HOURS} hours`}::interval)
        RETURNING ${columns}`);
      return { row: row!, created: true };
    });
    if (proposed.created) log('info', { code: 'SUPPORT_ACTION_PROPOSED', conversationId: conversation.id, actionId: proposed.row.id, kind });
    return c.json(view(c, proposed.row), proposed.created ? 201 : 200);
  });

  const ActionParam = z.object({ id: z.string().regex(/^sac_[0-9a-f]{32}$/) });
  app.openapi(createRoute({ method: 'get', path: '/v1/support/actions/{id}', operationId: 'getSupportAction', tags, security,
    description: describe('One of this conversation’s proposals and what came of it: the state the customer left it in, and the public route’s answer. Read it after the customer acts; never take the outcome from anywhere else.'),
    request: { params: ActionParam }, responses: { 200: response(Action), ...errors } }), async c => {
    const conversation = conversationOf(c);
    const { rows: [row] } = await c.env.db.execute<Row>(sql`SELECT ${columns} FROM support_actions WHERE id = ${c.req.valid('param').id} AND conversation_id = ${conversation.id}
      AND workspace_id = ANY(${sql.param(conversation.workspaces.map(w => w.id))}::text[])`);
    if (!row) notFound('Support action');
    return c.json(view(c, row!), 200);
  });

  const Recheck = z.object({ id: z.string(), workspaceId: z.string(), name: z.string(), verificationStatus: z.string(), verified: z.boolean(), dkimStatus: z.string(), sending: z.string(), receiving: z.string(),
    mailFromStatus: z.string().nullable(), recheckQueued: z.boolean().describe('False when a re-check was already due: read the domain’s health again shortly.') }).openapi('SupportDomainRecheck');
  app.openapi(createRoute({ method: 'post', path: '/v1/support/domains/{id}/verify', operationId: 'recheckSupportDomain', tags, security,
    description: describe('Re-check a domain’s DNS now, as the customer’s own “Verify” does (an owner or admin’s domain only): queues a background verification and answers the stored status. Needs no confirmation.'),
    request: { params: z.object({ id: Id }) }, responses: { 200: response(Recheck), ...errors } }), async c => {
    const conversation = conversationOf(c), domainId = c.req.valid('param').id;
    const { rows: [domain] } = await c.env.db.execute<{ workspace_id: string; name: string }>(sql`SELECT workspace_id, name FROM operation_domains
      WHERE id = ${domainId} AND workspace_id = ANY(${sql.param(conversation.workspaces.map(w => w.id))}::text[])`);
    if (!domain) notFound('Domain');
    const a = personActor(conversation.id, domain!.workspace_id, conversation.workspaces.find(w => w.id === domain!.workspace_id)!.role, 'support');
    if (memberRefused(a, 'POST', '/v1/domains/{id}/verify') || !a.permissions.includes('manage')) throw new ApiError(403, 'PERMISSION_DENIED', 'This operation requires a workspace owner or admin.');
    c.set('actor', a);
    const readiness = await (await wrapModuleLoad(() => import('./operations.js'))).verifyHostedDomain(c.env, a, domainId);
    const context: AuditContext = { ...auditContext(c), actor: { type: 'support', id: conversation.id, userId: conversation.userId, via: 'support', label: `${productName} support` } };
    await c.env.db.execute(auditInsert(context, { action: 'support.action', workspaceId: domain!.workspace_id, target: { type: 'domain', id: domainId },
      details: { kind: 'verify_domain', domain: domain!.name, queued: a.wakeJobs === 1 }, ticketRef: conversation.id, internal: true }));
    return c.json({ id: readiness.id, workspaceId: domain!.workspace_id, name: readiness.name, verificationStatus: readiness.verificationStatus, verified: readiness.verified, dkimStatus: readiness.dkimStatus,
      sending: readiness.sending, receiving: readiness.receiving, mailFromStatus: readiness.mailFromStatus, recheckQueued: a.wakeJobs === 1 }, 200);
  });

  // ---------- the customer's own session: only the person a proposal is for, while a member of its workspace ----------
  const sessionSecurity: Record<string, string[]>[] = [{ dashboardSession: [] }, { secureDashboardSession: [] }];
  const SessionParam = z.object({ id: z.string().regex(/^sac_[0-9a-f]{32}$/) });
  /** The signed-in person, like accepting an invitation: never a bearer credential or the support platform; writes from the dashboard's origin. */
  async function person(c: Ctx) {
    if (!c.env.config.multiTenant) notFound('Endpoint');
    if (c.env.platformCaller) throw new ApiError(403, 'DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.');
    const { verifiedDashboardUser, requireDashboardOrigin } = await wrapModuleLoad(() => import('./dashboard-auth.js'));
    const { userId } = await verifiedDashboardUser(c.env, c.req.raw.headers);
    if (c.req.method !== 'GET') requireDashboardOrigin(c.env, c.req.raw);
    return userId;
  }
  /** The proposal locked, with the person's role in its workspace now (held until the decision commits); 404 for anyone else. */
  async function decision(tx: DbExecutor, actionId: string, userId: string) {
    const { rows: [row] } = await tx.execute<Row>(sql`SELECT ${columns} FROM support_actions WHERE id = ${actionId} AND user_id = ${userId} FOR UPDATE`);
    const { rows: [member] } = row ? await tx.execute<{ role: string }>(sql`SELECT role FROM workspace_members WHERE workspace_id = ${row.workspace_id} AND user_id = ${userId} FOR SHARE`) : { rows: [] };
    if (!row || !member) notFound('Support action');
    return { row: row!, a: personActor(`user_${userId}`, row!.workspace_id, member!.role, 'dashboard') };
  }
  const expired = () => new ApiError(409, 'SUPPORT_ACTION_EXPIRED', 'This proposal expired. Ask support again if you still want it.');

  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: sessionSecurity, method: 'get', path: '/v1/support-actions/{id}', operationId: 'getSupportActionProposal',
    description: `A change ${productName} support proposed to you, in ${productName}’s words, and what came of it. Only you, while a member of its workspace.`,
    request: { params: SessionParam }, responses: { 200: response(Action), ...errors } }), async c => {
    const userId = await person(c);
    const { rows: [row] } = await c.env.db.execute<Row>(sql`SELECT ${columns} FROM support_actions s WHERE id = ${c.req.valid('param').id} AND user_id = ${userId}
      AND EXISTS (SELECT FROM workspace_members m WHERE m.workspace_id = s.workspace_id AND m.user_id = s.user_id)`);
    if (!row) notFound('Support action');
    return c.json(view(c, row!), 200);
  });

  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: sessionSecurity, method: 'post', path: '/v1/support-actions/{id}/confirm', operationId: 'confirmSupportAction',
    description: `Make a change ${productName} support proposed to you: it runs exactly as its own route does, once, while your role there still allows it. Confirming again answers what came of it.`,
    request: { params: SessionParam }, responses: { 200: response(Action), ...errors } }), async c => {
    const userId = await person(c), actionId = c.req.valid('param').id;
    // A campaign's controls read its workspace's regions first, as the public route's middleware does (app.ts).
    const { rows: [peek] } = await c.env.db.execute<{ kind: Kind; workspace_id: string }>(sql`SELECT kind, workspace_id FROM support_actions WHERE id = ${actionId} AND user_id = ${userId}`);
    if (!peek) notFound('Support action');
    const runtime = peek!.kind === 'pause_campaign' ? await (await wrapModuleLoad(() => import('./ses-region-state.js'))).withRegionSettings(c.env, peek!.workspace_id) : c.env;
    const claimed = await c.env.db.transaction(async (tx): Promise<{ row: Row; a?: Actor; post?: boolean }> => {
      const { row, a } = await decision(tx, actionId, userId);
      if (row.status === 'declined') throw new ApiError(409, 'SUPPORT_ACTION_DECLINED', 'You declined this proposal. Ask support again if you want it now.');
      if (row.status !== 'proposed') return { row };
      if (row.expired) throw expired();
      const refused = refusal(row.kind, a);
      if (refused) throw refused;
      c.set('actor', a);
      const context = auditContext(c);
      // A test posts to the customer's receiver: claimed here, posted after this commits, its answer recorded then.
      if (row.kind === 'test_inbound_webhook') {
        const { rows: [running] } = await tx.execute<Row>(sql`WITH s AS (UPDATE support_actions SET status = 'running' WHERE id = ${row.id} RETURNING ${columns}),
          logged AS (${decided(context, row, { outcome: 'running' })}) SELECT * FROM s`);
        return { row: running!, a, post: true };
      }
      // The change and the decision commit together; a change its route refuses rolls back alone, and is recorded.
      await tx.execute(sql`SAVEPOINT support_action`);
      let result: NonNullable<Row['result']>;
      try { const body = await perform(runtime, tx, row, a, context); await tx.execute(sql`RELEASE SAVEPOINT support_action`); woken(row, a, body); result = { body }; }
      catch (error) { const failed = refusedBy(error); if (!failed) throw error; await tx.execute(sql`ROLLBACK TO SAVEPOINT support_action`); result = failed; }
      const { rows: [done] } = await tx.execute<Row>(sql`WITH s AS (UPDATE support_actions SET status = ${result.error ? 'failed' : 'done'}, result = ${JSON.stringify(result)}::jsonb, resolved_at = now()
          WHERE id = ${row.id} RETURNING ${columns}), logged AS (${decided(context, row, { outcome: result.error ? 'failed' : 'done', code: result.error?.code })}) SELECT * FROM s`);
      return { row: done! };
    });
    if (!claimed.post) return c.json(view(c, claimed.row), 200);
    let result: NonNullable<Row['result']>, failure: unknown;
    try { result = { body: await perform(runtime, c.env.db, claimed.row, claimed.a!, auditContext(c)) }; }
    catch (error) { failure = refusedBy(error) ? undefined : error; result = refusedBy(error) ?? { error: { code: 'INTERNAL_ERROR', message: 'Unexpected server failure.' } }; }
    const { rows: [finished] } = await c.env.db.execute<Row>(sql`UPDATE support_actions SET status = ${result.error ? 'failed' : 'done'}, result = ${JSON.stringify(result)}::jsonb, resolved_at = now()
      WHERE id = ${claimed.row.id} AND status = 'running' RETURNING ${columns}`);
    if (failure) throw failure;
    return c.json(view(c, finished ?? claimed.row), 200);
  });

  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: sessionSecurity, method: 'post', path: '/v1/support-actions/{id}/decline', operationId: 'declineSupportAction',
    description: `Decline a change ${productName} support proposed to you. Nothing changes; declining again answers the same.`,
    request: { params: SessionParam }, responses: { 200: response(Action), ...errors } }), async c => {
    const userId = await person(c), actionId = c.req.valid('param').id;
    const row = await c.env.db.transaction(async tx => {
      const { row, a } = await decision(tx, actionId, userId);
      if (row.status === 'declined') return row;
      if (row.status !== 'proposed') throw new ApiError(409, 'SUPPORT_ACTION_CONFIRMED', 'You already confirmed this proposal.');
      if (row.expired) throw expired();
      c.set('actor', a);
      const { rows: [declined] } = await tx.execute<Row>(sql`WITH s AS (UPDATE support_actions SET status = 'declined', resolved_at = now() WHERE id = ${row.id} RETURNING ${columns}),
        logged AS (${decided(auditContext(c), row, { outcome: 'declined' })}) SELECT * FROM s`);
      return declined!;
    });
    return c.json(view(c, row), 200);
  });
}
