// Endpoints: everywhere received mail can be delivered outside an inbox. A webhook, a Slack or Discord channel, or a
// forward to an outside address is one row of one table (`endpoints`, still named mailbox_webhooks, migration 322) with
// its type, target, signing secret and headers (webhooks), policy, pause and reconfirm state, and for a webhook the events
// it subscribes to. Every write goes through this module: /v1/endpoints (named endpoints, any type) and
// /v1/inbound/webhooks (webhooks, named or not) are two views of it with the same checks and caps.
import { createRoute, z } from '@hono/zod-openapi';
import { sql, and, desc, eq, lt } from 'drizzle-orm';
import { ApiError, digest, errors, id, isoTime, json, lasting, nextCursor, randomSecret, readCursor, receivingAdmin, response, security, WEBHOOK_CHANGE, webhookUrlHint, WebhookUrlHint, type App, type Ctx, type ClaimedWebhook, type DbExecutor, type MailboxAccess, type Runtime } from './core.js';
import { claimSends } from './states.js';
import { endpoints, mailboxes, mailboxWebhookDeliveries, mailMessages, retainedMail, type EndpointRecord } from './db/mailbox.js';
import { ownReceiving, resumeNeedsUrl } from './rituals.js';
import { recordAudit } from './audit.js';
import { approvalField, approvalTie, tiedNextStep } from './approval-ties.js';
import { encrypt, decrypt, encryptWebhookHeaders, postWebhook, webhookHeaderViews, WebhookHeaders, WebhookHeaderViews, webhookSecret, webhookUrl } from './operations.js';
import { inboundEventTypes, webhookSecretBinding } from './mailbox-events.js';
import { InboundAddressId } from './inbound-threads.js';
import { lockMailboxLane } from './mailbox-store.js';
import { sendFromMailbox } from './mailbox-send.js';
import { chargeManualDelivery, JobDeferred } from './jobs.js';
import { detachDestination, enableRouting, RoutingKey } from './routing.js';
import { endpointPolicy, DEFAULT_POLICY, type EndpointPolicy } from './ritual-retry.js';
import { endpointCall, endpointPayloads, type EndpointType } from './ritual-schema.js';
import { legacyWebhookFormat, loopHeader, productName, webhookFormat } from './brand.js';

// ── The model ─────────────────────────────────────────────────────────────────────────────
type HeaderList = z.infer<typeof WebhookHeaders>;
type StoredFormat = EndpointRecord['format'];
/** Caps, per workspace. Paused webhooks don't count; chat and forward endpoints count whatever their state. */
export const ENDPOINT_CAPS = { subscribed: 32, routeOnly: 500, other: 50 } as const;
const targetBinding = (w: string, endpointId: string) => w + ':endpoint:' + endpointId;
/** Slack, Discord and forward endpoints keep the con_ ID prefix they always had, webhooks mwh_. */
const newEndpointId = (type: EndpointType) => id(type === 'webhook' ? 'mwh' : 'con');

export function pinnedUrl(type: string, value: string) {
  const pattern =
    type === 'slack'
      ? /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/
      : /^https:\/\/discord\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/;
  if (!pattern.test(value) || value.trim() !== value)
    throw new ApiError(422, 'INVALID_CONNECTOR', type === 'slack' ? 'Use the Slack incoming webhook URL: https://hooks.slack.com/services/…' : 'Use the Discord webhook URL: https://discord.com/api/webhooks/…', 'url');
  return value;
}
/** Chat payloads become plain text: no mentions, no markup and no link unfurls. */
export function renderChat(type: string, body: unknown) {
  const k = type === 'slack' ? 'text' : 'content';
  const fail = () => new ApiError(422, 'INVALID_CONNECTOR_MESSAGE', `endpoints.<name>() for ${type} takes { ${k}: "…" }.`);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) throw fail();
  const s = (body as Record<string, unknown>)[k];
  if (typeof s !== 'string' || !s.length) throw fail();
  return type === 'slack'
    ? { text: s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').slice(0, 3000), mrkdwn: false, unfurl_links: false, unfurl_media: false }
    : { content: s.replace(/([\\*_~`|>\[\]()#])/g, '\\$1').replace(/^(\s*)-/gm,'$1\\-').slice(0, 2000), allowed_mentions: { parse: [] }, flags:4 };
}

/** The columns a view needs, as raw SQL returns them (the overview aggregates rows into JSON). */
export type EndpointRow = {
  id: string; key: string | null; type: EndpointType; url: string | null; name: string | null; description: string; event_types: string[]; mailbox_ids: string[] | null;
  verified: boolean; expires_at: string | Date | null; declined_at: string | Date | null; created_at: string | Date; paused: boolean; reconfirm: boolean;
  encrypted_target: string | null; per_minute: number | null; retry_on_timeout: boolean | null; idempotent: boolean | null;
};
export const endpointColumns = (h = sql`h`) => sql`${h}.id,${h}.key,${h}.type,${h}.url,${h}.name,${h}.description,${h}.event_types,${h}.mailbox_ids,${h}.verified,${h}.expires_at,${h}.declined_at,
  ${h}.created_at,${h}.paused,${h}.reconfirm,${h}.encrypted_target,${h}.per_minute,${h}.retry_on_timeout,${h}.idempotent`;
const rowOf = (r: EndpointRecord): EndpointRow => ({ id: r.id, key: r.key, type: r.type, url: r.url, name: r.name, description: r.description, event_types: r.eventTypes, mailbox_ids: r.mailboxIds,
  verified: r.verified, expires_at: r.expiresAt, declined_at: r.declinedAt, created_at: r.createdAt, paused: r.paused, reconfirm: r.reconfirm, encrypted_target: r.encryptedTarget,
  per_minute: r.perMinute, retry_on_timeout: r.retryOnTimeout, idempotent: r.idempotent });
/** Named endpoints (any type), by name. */
export async function endpointRows(db: DbExecutor, w: string, q: { name?: string; cursor?: string; type?: string; limit?: number } = {}) {
  return (await db.execute<EndpointRow>(sql`SELECT ${endpointColumns()} FROM mailbox_webhooks h WHERE h.workspace_id=${w} AND h.key IS NOT NULL
    AND (${q.name ?? null}::text IS NULL OR h.key=${q.name ?? null}) AND (${q.cursor ?? null}::text IS NULL OR h.key>${q.cursor ?? null}) AND (${q.type ?? null}::text IS NULL OR h.type=${q.type ?? null})
    ORDER BY h.key LIMIT ${(q.limit ?? 500) + 1}`)).rows;
}
/** Held when the approval that created or changed it was removed. Its URL is write-only, so resuming takes the URL again; a forward shows its address. */
const needsUrl = (r: Pick<EndpointRow, 'paused' | 'reconfirm' | 'type'>) => r.paused && r.reconfirm && r.type !== 'forward';
const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());
type EndpointStatus = 'ready' | 'pending' | 'expired' | 'declined' | 'paused';
export function endpointStatus(r: Pick<EndpointRow, 'type' | 'paused' | 'verified' | 'declined_at' | 'expires_at'>): EndpointStatus {
  const expired = r.type === 'forward' && !r.verified && !r.declined_at && r.expires_at !== null && new Date(r.expires_at).getTime() <= Date.now();
  return r.paused ? 'paused' : r.declined_at ? 'declined' : r.verified ? 'ready' : expired ? 'expired' : 'pending';
}
/** Where it delivers, for people: a webhook or chat URL shows its last four characters, a forward its address. */
export async function endpointTarget(runtime: Runtime, w: string, r: Pick<EndpointRow, 'id' | 'type' | 'url' | 'encrypted_target'>) {
  if (r.type === 'webhook') return webhookUrlHint(r.url!);
  const value = await decrypt(runtime, r.encrypted_target!, targetBinding(w, r.id));
  return r.type === 'forward' ? value : `${r.type === 'slack' ? 'Slack incoming webhook' : 'Discord webhook'} ${webhookUrlHint(value)}`;
}

// ── /v1/endpoints: named endpoints of any type ────────────────────────────────────────────
const base = '/v1/endpoints',
  meta = { security, tags: ['Endpoints'] },
  types = ['slack', 'discord', 'webhook', 'forward'] as const,
  Name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).describe('Endpoint name, unique in the workspace across every type. Rules call endpoints.<name>(…).'),
  Status = z.enum(['ready', 'pending', 'expired', 'declined', 'paused']).describe('ready: callable. pending: a forward waiting for its recipient to confirm. expired: the confirmation link lapsed. declined: the recipient declined or stopped forwards. paused: deliveries are held.'),
  Policy = z.object({
    perMinute: z.number().int().min(1).max(6000).describe('Calls per minute; extra calls wait for the next minute.'),
    retryOnTimeout: z.boolean().describe('Replay an attempt whose outcome is unknown (timeout, dropped connection). Off by default for chat and webhooks; always on for forwards.'),
    idempotent: z.boolean().describe('The receiver deduplicates by the Idempotency-Key header, so unknown outcomes are replayed. Webhooks only.'),
  }).openapi('EndpointPolicy');
export const Endpoint = z.object({
  name: Name,
  type: z.enum(types),
  status: Status,
  call: z.string().describe('How a rule calls it.'),
  target: z.string().describe('Where it delivers. Slack, Discord and webhook URLs are write-only; only the last four characters are shown.'),
  policy: Policy,
  expiresAt: z.string().nullable().describe('When a pending forward confirmation link expires.'),
  nextStep: z.string().describe('What to do next, for people and agents.'),
  createdAt: z.string(),
}).openapi('Endpoint');
const Url = z.string().max(2048);
const CreateEndpoint = z.discriminatedUnion('type', [
  z.object({ type: z.literal('slack'), name: Name, url: Url.describe('Slack incoming webhook URL (https://hooks.slack.com/services/…). Stored encrypted and never returned.') }).strict(),
  z.object({ type: z.literal('discord'), name: Name, url: Url.describe('Discord webhook URL (https://discord.com/api/webhooks/…). Stored encrypted and never returned.') }).strict(),
  z.object({
    type: z.literal('webhook'), name: Name, url: Url.describe('Public HTTPS URL that receives signed JSON events.'),
    headers: WebhookHeaders.optional(), timeoutSeconds: z.number().int().min(1).max(30).optional(), retryAttempts: z.number().int().min(0).max(10).optional(),
  }).strict(),
  z.object({
    type: z.literal('forward'), name: Name, address: z.email().max(254).toLowerCase().describe('Recipient. They confirm with an emailed link unless preverify applies.'),
    from: z.string().max(254).optional().describe('Receiving address ID (mbx_…) or address that sends the confirmation request. Defaults to the oldest permanent receiving address.'),
    preverify: z.boolean().default(false).describe('Skip the emailed confirmation. Only for addresses on a domain this workspace has verified.'),
  }).strict(),
]).openapi('CreateEndpoint');
const UpdateEndpoint = Policy.partial().extend({
  name: Name.optional().describe('Rename it. Refused while an attached rule calls it by the current name.'),
  type: z.enum(types).optional().describe('Switch a Slack endpoint to Discord or back, with the new url. Webhook and forward endpoints keep their type.'),
  paused: z.boolean().optional().describe('Hold deliveries. Queued calls resume when unpaused.'),
  url: Url.optional().describe('Replace a Slack, Discord or webhook URL. Write-only: omit it to keep the current URL. Replacing a webhook URL drops its custom headers unless headers are sent with it.'),
  headers: WebhookHeaders.optional().describe('Replace a webhook endpoint’s custom headers. Write-only.'),
  timeoutSeconds: z.number().int().min(1).max(30).optional().describe('Webhook endpoints only.'),
  retryAttempts: z.number().int().min(0).max(10).optional().describe('Webhook endpoints only.'),
}).strict().openapi('UpdateEndpoint');
const NameParam = z.object({ name: Name });

export async function endpointView(runtime: Runtime, w: string, r: EndpointRow): Promise<z.infer<typeof Endpoint>> {
  const name = r.key!, policy = endpointPolicy(r.type, r), call = endpointCall(name), target = await endpointTarget(runtime, w, r), status = endpointStatus(r);
  const payload = endpointPayloads[r.type].signature(name).replace(/^endpoints\.[^(]+/, call);
  const nextStep = {
    ready: `Call it from a rule: ${payload}.`,
    pending: `Waiting for ${target} to open the confirmation link (expires ${iso(r.expires_at)}). Only the recipient can confirm. Resend with sendEndpointVerification if it was lost.`,
    expired: `The confirmation link expired. Send a new one with sendEndpointVerification.`,
    declined: `${target} declined or stopped forwards. A new request is possible 30 days after ${iso(r.declined_at)}.`,
    paused: needsUrl(r) ? `Deliveries were held when the approval that created or changed this endpoint was removed. Resume by sending its URL again: updateEndpoint { "url": "…", "paused": false }.` : `Deliveries are held. Resume with updateEndpoint { "paused": false }.`,
  }[status];
  return { name, type: r.type, status, call, target, policy, expiresAt: status === 'pending' || status === 'expired' ? iso(r.expires_at) : null, nextStep, createdAt: iso(r.created_at)! };
}
const missingEndpoint = (name: string) => new ApiError(404, 'NOT_FOUND', `No endpoint named ${name}. List them with listEndpoints.`);

// ── Checks every write applies ────────────────────────────────────────────────────────────
/**
 * Refuses a change that would leave an attached rule calling endpoints.<name> with nothing behind it, or with the
 * wrong payload: deleting the endpoint, renaming it (or removing a webhook's name) or switching its type. A delete is
 * also refused while a route delivers to it. The caller holds the address lane, which rule and route saves take too.
 */
export async function assertEndpointUnused(tx: DbExecutor, w: string, endpoint: { name: string | null; id: string }, change: 'delete' | 'rename' | 'switch', field = change === 'switch' ? 'type' : 'name') {
  // Attached rules' programs resolved endpoints.<name> and checked its type when they were saved.
  const callers = endpoint.name === null ? [] : (await tx.execute<{ key: string }>(sql`SELECT r.key FROM mail_ritual_configs c, jsonb_each(c.programs->'rituals') r
    WHERE c.workspace_id=${w} AND r.value->'refs' ? ${'endpoint:' + endpoint.name} ORDER BY r.key`)).rows.map(r => r.key);
  if (callers.length) {
    const one = callers.length === 1, them = one ? 'rule' : 'rules';
    throw new ApiError(409, 'ENDPOINT_IN_USE', `Attached ${them} ${callers.join(', ')} ${one ? 'calls' : 'call'} endpoints.${endpoint.name}. ` + (change === 'delete'
      ? `Remove the call or detach the ${them}, then delete.` : `To ${change} it, create a new endpoint, point the ${them} at it, then delete this one.`), change === 'delete' ? undefined : field);
  }
  if (change === 'delete' && (await tx.execute(sql`SELECT FROM mail_routes WHERE workspace_id=${w} AND destinations ? ${endpoint.id} LIMIT 1`)).rowCount)
    throw new ApiError(409, 'ENDPOINT_IN_USE', `A route delivers to ${endpoint.name ?? endpoint.id}. Remove it from routes first (deleteInboundWebhook with detach=true does both).`);
}
/** One name space across every type (the unique index mailbox_webhooks_key backs it). Caller holds the address lane. */
export async function assertEndpointName(tx: DbExecutor, w: string, name: string, exceptId = '', field = 'name') {
  if ((await tx.execute(sql`SELECT FROM mailbox_webhooks WHERE workspace_id=${w} AND key=${name} AND id<>${exceptId} LIMIT 1`)).rowCount)
    throw new ApiError(409, 'ENDPOINT_NAME_TAKEN', `Another endpoint is already named ${name}. Names are shared by Slack, Discord, webhook and forward endpoints.`, field);
}
/** Active webhooks of one kind (subscribed to events, or route-only), or chat and forward endpoints. Caller holds the address lane. */
async function assertCapacity(tx: DbExecutor, w: string, kind: 'subscribed' | 'routeOnly' | 'other', exceptId = '') {
  const cap = ENDPOINT_CAPS[kind];
  const over = kind === 'other'
    ? sql`SELECT FROM mailbox_webhooks WHERE workspace_id=${w} AND type<>'webhook' AND id<>${exceptId} LIMIT 1 OFFSET ${cap - 1}`
    : sql`SELECT FROM mailbox_webhooks WHERE workspace_id=${w} AND type='webhook' AND NOT paused AND id<>${exceptId} AND (event_types='[]')=${kind === 'routeOnly'} LIMIT 1 OFFSET ${cap - 1}`;
  if ((await tx.execute(over)).rowCount)
    throw new ApiError(409, kind === 'other' ? 'ENDPOINT_LIMIT' : 'MAILBOX_HOOK_LIMIT', {
      subscribed: `At most ${cap} webhooks with event subscriptions can be active. Pause or delete one, or use eventTypes [] for a route-only webhook.`,
      routeOnly: `At most ${cap} route-only webhooks can be active. Pause or delete one first.`,
      other: `At most ${cap} Slack, Discord and forward endpoints per workspace. Delete one first.`,
    }[kind]);
}
function checkScope(ids: string[] | null, types: string[], format: StoredFormat) {
  if (ids !== null && types.includes('message.stored')) throw new ApiError(422, 'INVALID_EVENT_SCOPE', 'message.stored requires a workspace webhook without an addressIds filter.', 'addressIds');
  if (format === 'inbound' && types.some(t => t !== 'message.received' && t !== 'message.junk')) throw new ApiError(422, 'INVALID_EVENT_SCOPE', 'The inbound format carries received mail only. Use eventTypes ["message.received"], or [] for a route-only webhook.', 'eventTypes');
}
const defaultJunk = (format: StoredFormat) => format === 'inbound' ? 'include' as const : 'skip' as const;
/**
 * Locks an endpoint for a change: the address lane, then this approval's hold on what it changes, then the row: the
 * order every endpoint write takes them in, and a removal takes the approval before the rows it disables. A removal
 * that lands after this waits for the change and holds the endpoint again.
 */
async function lockEndpoint(tx: DbExecutor, c: Ctx, w: string, where: { id: string } | { name: string }, hold = true) {
  await lockMailboxLane(tx, w, 'address');
  const [found] = await tx.select({ id: endpoints.id }).from(endpoints).where(and(eq(endpoints.workspaceId, w), 'id' in where ? eq(endpoints.id, where.id) : eq(endpoints.key, where.name)));
  if (!found) return null;
  if (hold) await ownReceiving(tx, c, 'endpoint', found.id);
  const [row] = await tx.select().from(endpoints).where(and(eq(endpoints.workspaceId, w), eq(endpoints.id, found.id))).for('update');
  return row ?? null;
}

// ── The writer ────────────────────────────────────────────────────────────────────────────
export type NewEndpoint =
  | { type: 'webhook'; key: string | null; name: string | null; url: string; description: string; eventTypes: string[]; addressIds: string[] | null; paused: boolean;
      format: StoredFormat; junk?: 'skip' | 'include'; include?: ('message' | 'raw')[]; timeoutSeconds?: number; retryAttempts?: number; headers?: HeaderList }
  | { type: 'slack' | 'discord'; key: string; url: string }
  | { type: 'forward'; key: string; address: string; from?: string; preverify: boolean };
/** Creates any endpoint. Returns the row and, for a webhook, its signing secret (shown once). */
export async function createEndpointRecord(tx: DbExecutor, c: Ctx, w: string, spec: NewEndpoint, nameField = 'name') {
  await lockMailboxLane(tx, w, 'address');
  if (spec.key) await assertEndpointName(tx, w, spec.key, '', nameField);
  const endpointId = newEndpointId(spec.type);
  let secret: string | undefined;
  if (spec.type === 'webhook') {
    const junk = spec.junk ?? defaultJunk(spec.format), eventTypes = [...new Set(spec.eventTypes)], binding = webhookSecretBinding(w, endpointId), url = webhookUrl(c.env, spec.url);
    checkScope(spec.addressIds, eventTypes, spec.format);
    if (!spec.paused) await assertCapacity(tx, w, eventTypes.length ? 'subscribed' : 'routeOnly');
    // Junk delivery needs the routed store, which emits message.junk.
    if (junk === 'include') await enableRouting(tx, w);
    secret = webhookSecret();
    await tx.insert(endpoints).values({ id: endpointId, workspaceId: w, type: 'webhook', key: spec.key, name: spec.name, url, description: spec.description, eventTypes, mailboxIds: spec.addressIds,
      paused: spec.paused, format: spec.format, junk, include: spec.include, timeoutSeconds: spec.timeoutSeconds, retryAttempts: spec.retryAttempts ?? (spec.format === 'inbound' ? 3 : 9),
      encryptedSecret: await encrypt(c.env, secret, binding), encryptedHeaders: await encryptWebhookHeaders(c.env, spec.headers, binding) });
    await ownReceiving(tx, c, 'endpoint', endpointId);
  } else {
    await assertCapacity(tx, w, 'other');
    const forward = spec.type === 'forward', value = forward ? spec.address : pinnedUrl(spec.type, spec.url);
    if (forward) await checkExternal(tx, w, value);
    const preverified = forward && spec.preverify;
    if (preverified && !await ownVerifiedDomain(c.env, tx, w, value))
      throw new ApiError(422, 'PREVERIFY_NOT_ALLOWED', `preverify works only for addresses on a domain this workspace has verified. Omit it to email ${value} a confirmation link.`, 'preverify');
    await tx.execute(sql`INSERT INTO mailbox_webhooks(id,workspace_id,type,key,encrypted_target,event_types,verified,expires_at,preverified_by)
      VALUES(${endpointId},${w},${spec.type},${spec.key},${await encrypt(c.env, value, targetBinding(w, endpointId))},'[]',${!forward || preverified},${forward && !preverified ? sql`now()+interval '24 hours'` : null},${preverified ? c.get('actor').keyId : null})`);
    await ownReceiving(tx, c, 'endpoint', endpointId);
    if (forward && !preverified) await requestConfirmation(c, tx, w, endpointId, value, spec.from);
  }
  const [row] = await tx.select().from(endpoints).where(and(eq(endpoints.workspaceId, w), eq(endpoints.id, endpointId)));
  return { row: row!, secret };
}
export type EndpointChange = {
  key?: string | null; type?: EndpointType; url?: string; headers?: HeaderList; paused?: boolean;
  name?: string | null; description?: string; eventTypes?: string[]; addressIds?: string[] | null; format?: StoredFormat; junk?: 'skip' | 'include'; include?: ('message' | 'raw')[];
  timeoutSeconds?: number; retryAttempts?: number; perMinute?: number; retryOnTimeout?: boolean; idempotent?: boolean;
};
const webhookOnly = ['headers', 'name', 'description', 'eventTypes', 'addressIds', 'format', 'junk', 'include', 'timeoutSeconds', 'retryAttempts'] as const;
const chat = (t: EndpointType) => t === 'slack' || t === 'discord';
/** Changes any endpoint the caller locked with lockEndpoint. Only what the change names is written. */
export async function changeEndpointRecord(tx: DbExecutor, c: Ctx, row: EndpointRecord, q: EndpointChange, nameField = 'name') {
  const w = row.workspaceId, label = row.key ?? row.id;
  if (q.paused === false && q.url === undefined && needsUrl(row)) throw resumeNeedsUrl();
  if (q.idempotent && row.type !== 'webhook') throw new ApiError(422, 'UNSUPPORTED_IDEMPOTENCY', 'Only webhook endpoints can declare that they deduplicate by Idempotency-Key.', 'idempotent');
  const retype = q.type !== undefined && q.type !== row.type ? q.type : undefined, type = retype ?? row.type;
  if (retype && !(chat(row.type) && chat(retype))) throw new ApiError(422, 'ENDPOINT_TYPE_FIXED', `Only Slack and Discord endpoints switch type. Create a new ${retype} endpoint instead.`, 'type');
  if (retype && q.url === undefined) throw new ApiError(422, 'ENDPOINT_URL_REQUIRED', `Switching ${label} to ${retype === 'slack' ? 'Slack' : 'Discord'} needs its ${retype === 'slack' ? 'Slack incoming webhook' : 'Discord webhook'} URL.`, 'url');
  const misplaced = row.type === 'webhook' ? undefined : webhookOnly.find(k => q[k] !== undefined);
  if (misplaced) throw new ApiError(422, 'WEBHOOK_SETTING_ONLY', `${misplaced} applies to webhook endpoints only.`, misplaced);
  if (q.url !== undefined && row.type === 'forward') throw new ApiError(422, 'FORWARD_ADDRESS_FIXED', 'A forward address cannot change. Create a new forward endpoint so its recipient can confirm.', 'url');
  const rekey = q.key !== undefined && q.key !== row.key ? q.key : undefined;
  if (rekey === null && row.type !== 'webhook') throw new ApiError(422, 'ENDPOINT_NAME_REQUIRED', 'Slack, Discord and forward endpoints are called by name.', nameField);
  if (rekey !== undefined || retype) await assertEndpointUnused(tx, w, { name: row.key, id: row.id }, rekey !== undefined ? 'rename' : 'switch', rekey !== undefined ? nameField : 'type');
  if (rekey) await assertEndpointName(tx, w, rekey, row.id, nameField);
  const paused = q.paused ?? row.paused, resumed = row.paused && q.paused === false;
  const set: Partial<typeof endpoints.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (rekey !== undefined) set.key = rekey;
  if (q.paused !== undefined) set.paused = q.paused;
  // A new URL answers a reconfirm mark; a forward has no URL to send again (its address is shown and fixed), so resuming clears it.
  if (q.url !== undefined || (row.type === 'forward' && q.paused !== undefined)) set.reconfirm = false;
  if (row.type === 'webhook') {
    const eventTypes = q.eventTypes && [...new Set(q.eventTypes)], events = eventTypes ?? row.eventTypes;
    const format = q.format ?? row.format, junk = q.junk ?? (format !== row.format ? defaultJunk(format) : row.junk);
    checkScope(q.addressIds === undefined ? row.mailboxIds : q.addressIds, events, format);
    if (!paused && (row.paused || !row.eventTypes.length !== !events.length)) await assertCapacity(tx, w, events.length ? 'subscribed' : 'routeOnly', row.id);
    if (junk === 'include') await enableRouting(tx, w);
    const url = q.url === undefined ? undefined : webhookUrl(c.env, q.url), moved = url !== undefined && url !== row.url;
    // A new URL drops the custom headers meant for the old one, unless new ones come with it. Moving an inbound-format
    // webhook also replaces its secret, which its verification token is derived from.
    const headers = q.headers ?? (moved ? [] : undefined), binding = webhookSecretBinding(w, row.id);
    Object.assign(set, { name: q.name, description: q.description, eventTypes, mailboxIds: q.addressIds, format: q.format && format, junk: q.junk !== undefined || format !== row.format ? junk : undefined,
      include: q.include, timeoutSeconds: q.timeoutSeconds, retryAttempts: q.retryAttempts, url, encryptedHeaders: await encryptWebhookHeaders(c.env, headers, binding),
      encryptedSecret: moved && (format === 'inbound' || row.format === 'inbound') ? await encrypt(c.env, webhookSecret(), binding) : undefined });
    // A webhook named after its endpoint name keeps the two together.
    if (rekey && row.name === row.key && q.name === undefined) set.name = rekey;
  } else {
    if (retype) set.type = retype;
    if (q.url !== undefined) set.encryptedTarget = await encrypt(c.env, pinnedUrl(type, q.url), targetBinding(w, row.id));
  }
  if (q.perMinute !== undefined || q.retryOnTimeout !== undefined || q.idempotent !== undefined) {
    const next: EndpointPolicy = { ...endpointPolicy(row.type, rowOf(row)), ...Object.fromEntries(Object.entries({ perMinute: q.perMinute, retryOnTimeout: q.retryOnTimeout, idempotent: q.idempotent }).filter(([, v]) => v !== undefined)) };
    Object.assign(set, { perMinute: next.perMinute, retryOnTimeout: next.retryOnTimeout, idempotent: next.idempotent });
  }
  const [updated] = await tx.update(endpoints).set(set).where(and(eq(endpoints.workspaceId, w), eq(endpoints.id, row.id))).returning();
  if (resumed) { await tx.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) VALUES('job_'||gen_random_uuid(),'mailbox.resumeDeliveries',${w},jsonb_build_object('hook',${row.id}::text))`); c.get('actor').wakeJobs = 1; }
  return updated!;
}
/** Deletes an endpoint the caller locked. `detach` (the webhooks API) first removes it from every route, as one routing version. */
async function deleteEndpointRecord(tx: DbExecutor, c: Ctx, row: EndpointRecord, detach: boolean) {
  if (detach) await detachDestination(tx, c, row.workspaceId, row.id);
  await assertEndpointUnused(tx, row.workspaceId, { name: row.key, id: row.id }, 'delete');
  await tx.delete(endpoints).where(and(eq(endpoints.workspaceId, row.workspaceId), eq(endpoints.id, row.id)));
}
async function debit(tx: DbExecutor, w: string, key: string, limit: number, window: 'day' | 'hour', message = 'Forwarding budget reached for this window.') {
  const charge = await tx.execute(sql`INSERT INTO api_request_budgets AS b(workspace_id,key_id,window_start,used) VALUES(${w},${key},date_trunc(${window},now()),1)
    ON CONFLICT(workspace_id,key_id) DO UPDATE SET used=CASE WHEN b.window_start=excluded.window_start THEN b.used+1 ELSE 1 END,window_start=excluded.window_start
    WHERE b.window_start<>excluded.window_start OR b.used<${limit} RETURNING 1`);
  if (!charge.rowCount) throw new ApiError(429, 'FORWARD_LIMIT', message, undefined, true);
}
async function checkExternal(tx: DbExecutor, w: string, address: string) {
  if ((await tx.execute(sql`SELECT FROM mailbox_domains WHERE workspace_id=${w} AND coalesce(receiving_host,name)=split_part(${address},'@',2) LIMIT 1`)).rowCount)
    throw new ApiError(422, 'FORWARD_LOOP', 'Cannot forward to a receiving host of this workspace; mail would loop.', 'address');
}
/** The address is on a domain this workspace has proven it controls (a verified sending domain or a subdomain of one). */
async function ownVerifiedDomain(runtime: Runtime, tx: DbExecutor, w: string, address: string) {
  const host = address.split('@')[1]!;
  const found = runtime.config.multiTenant
    ? await tx.execute(sql`SELECT FROM domain_claims dc WHERE workspace_id=${w} AND ${claimSends()} AND (name=${host} OR right(${host},length(name)+1)='.'||name) LIMIT 1 FOR SHARE`)
    : await tx.execute(sql`SELECT FROM operation_domains WHERE workspace_id=${w} AND (name=${host} OR right(${host},length(name)+1)='.'||name) LIMIT 1`);
  return !!found.rowCount;
}
async function senderBox(tx: DbExecutor, w: string, from?: string) {
  const [box] = from
    ? await tx.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, w), sql`(${mailboxes.id}=${from} OR ${mailboxes.id}=(SELECT mailbox_id FROM mailbox_addresses WHERE workspace_id=${w} AND address=${from.toLowerCase()}))`))
    : await tx.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, w), sql`${mailboxes.kind}<>'inbox' AND ${mailboxes.expiresAt} IS NULL`)).orderBy(mailboxes.id).limit(1);
  if (!box || box.kind === 'inbox' || box.expiresAt)
    throw new ApiError(422, 'FORWARD_SENDER_REQUIRED', from ? 'Choose a permanent receiving address (not an expiring inbox) to send the confirmation request.' : 'Create a permanent receiving address first; the confirmation request is sent from it.', 'from');
  return box;
}
const forwardBase = (runtime: Runtime) => runtime.config.publicUrl.replace(/\/$/, '') + '/v1/forwarding';
/**
 * Emails the recipient a single-use, 24-hour confirmation link. The message is sealed: the
 * workspace's sent-mail views show it with the link withheld, because the link alone confirms.
 */
async function requestConfirmation(c: Ctx, tx: DbExecutor, w: string, endpointId: string, address: string, from?: string) {
  const box = await senderBox(tx, w, from);
  const addressHash = await digest(address);
  const declined = (await tx.execute<{ until: string }>(sql`SELECT (declined_at+interval '30 days')::text AS until FROM mail_forward_declines WHERE workspace_id=${w} AND address_hash=${addressHash} AND declined_at>now()-interval '30 days'`)).rows[0];
  if (declined) throw new ApiError(409, 'FORWARD_DECLINED', `${address} declined forwarding from this workspace. You can ask again after ${new Date(declined.until).toISOString()}.`, 'address');
  await debit(tx, w, 'forward-verification', 20, 'day', 'At most 20 forward confirmation requests per workspace per day.');
  await debit(tx, w, 'forward-verification:' + addressHash, 3, 'day', 'At most 3 confirmation requests per address per day.');
  // Across every workspace: one address cannot be flooded with requests by many workspaces.
  await debit(tx, 'global', 'forward-verification:' + addressHash, 5, 'day', 'This address has received too many confirmation requests today.');
  const token = randomSecret('fwd_');
  await tx.execute(sql`UPDATE mailbox_webhooks SET proof_hash=${await digest(token)},expires_at=now()+interval '24 hours',requested_at=now(),request_from=${box.address},declined_at=NULL WHERE workspace_id=${w} AND id=${endpointId}`);
  await sendFromMailbox(c.env, tx, {
    actor: c.get('actor'), scope: { workspaceId: w }, mailbox: box, from: box.address, to: [address], cc: [], bcc: [], replyTo: [],
    subject: `Confirm forwarding from ${box.address}`,
    text: `${box.address} wants to forward the email it receives to ${address}.\n\nTo allow it, open this link within 24 hours and choose Allow:\n${forwardBase(c.env)}/confirm/${token}\n\nIf you don't recognize this request, ignore this email or choose Decline. Nothing is forwarded until you allow it, and declining stops this sender from asking again for 30 days. Every forwarded message includes a link to stop.`,
    inReplyTo: null, references: [], headers: [], attachments: [], autoSubmitted: 'auto-generated', sealed: true,
  });
}

export function registerEndpoints(app: App) {
  const manage = 'create, change, test or delete endpoints';
  const findEndpoint = async (db: DbExecutor, w: string, name: string) => { const row = (await endpointRows(db, w, { name, limit: 1 }))[0]; if (!row) throw missingEndpoint(name); return row; };
  app.openapi(createRoute({ ...meta, method: 'get', path: base, operationId: 'listEndpoints', summary: 'List endpoints rules can call', request: { query: z.object({ type: z.enum(types).optional(), cursor: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }) }, responses: { 200: response(z.object({ data: z.array(Endpoint), nextCursor: z.string().nullable() }).openapi('EndpointPage')), ...errors } }), async c => {
    const w = receivingAdmin(c).workspaceId, q = c.req.valid('query'), rows = await endpointRows(c.env.db, w, q);
    return c.json({ data: await Promise.all(rows.slice(0, q.limit).map(r => endpointView(c.env, w, r))), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.key : null }, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'get', path: `${base}/{name}`, operationId: 'getEndpoint', summary: 'Read one endpoint, its status and the next step', request: { params: NameParam }, responses: { 200: response(Endpoint), ...errors } }), async c => {
    const w = receivingAdmin(c).workspaceId;
    return c.json(await endpointView(c.env, w, await findEndpoint(c.env.db, w, c.req.valid('param').name)), 200);
  });
  app.openapi(createRoute({
    ...meta, method: 'post', path: base, operationId: 'createEndpoint', summary: 'Create a named Slack, Discord, webhook or forward endpoint',
    description: 'Slack and Discord URLs are credentials: stored encrypted, pinned to the provider host and never returned. A webhook endpoint is a route-only inbound webhook; its signing secret is returned once. A forward emails its recipient a single-use confirmation link (24 hours); it stays pending until they choose Allow. With preverify, an address on a domain this workspace has verified is ready at once.',
    request: { body: json(CreateEndpoint) }, responses: { 201: response(Endpoint.extend({ secret: z.string().optional().describe('Webhook signing secret, shown once.') }).openapi('CreatedEndpoint')), ...errors },
  }), async c => {
    const q = c.req.valid('json'), w = receivingAdmin(c, manage).workspaceId;
    const spec: NewEndpoint = q.type === 'webhook'
      ? { type: 'webhook', key: q.name, name: q.name, url: q.url, description: '', eventTypes: [], addressIds: null, paused: false, format: legacyWebhookFormat, headers: q.headers, timeoutSeconds: q.timeoutSeconds, retryAttempts: q.retryAttempts }
      : q.type === 'forward' ? { type: 'forward', key: q.name, address: q.address, from: q.from, preverify: q.preverify } : { type: q.type, key: q.name, url: q.url };
    const { row, secret } = await c.env.db.transaction(async tx => {
      const created = await createEndpointRecord(tx, c, w, spec);
      // Slack and Discord URLs are credentials: only a forward's address is named.
      await recordAudit(tx, c, { action: 'endpoint.create', workspaceId: w, target: { type: 'endpoint', id: created.row.id }, after: { name: q.name, type: q.type,
        ...(q.type === 'webhook' ? { headerNames: q.headers?.map(h => h.name) } : q.type === 'forward' ? { address: q.address, preverified: created.row.verified } : {}) } });
      return created;
    });
    c.header('Cache-Control', 'no-store');
    const created = await endpointView(c.env, w, rowOf(row));
    if (created.status === 'pending') c.get('actor').wakeJobs = 1;
    return c.json({ ...created, ...(secret ? { secret } : {}) }, 201);
  });
  app.openapi(createRoute({ ...meta, method: 'patch', path: `${base}/{name}`, operationId: 'updateEndpoint', summary: 'Edit an endpoint: its name, type, URL, pause state, rate or retry policy',
    description: 'Send only what changes. URLs and headers are write-only: an omitted url keeps the current one, and none is ever returned. A forward’s address is fixed (its recipient confirmed it); create a new forward instead.',
    request: { params: NameParam, body: json(UpdateEndpoint) }, responses: { 200: response(Endpoint), ...errors } }), async c => {
    const w = receivingAdmin(c, manage).workspaceId, name = c.req.valid('param').name, { name: rename, ...q } = c.req.valid('json');
    const updated = await c.env.db.transaction(async tx => {
      const row = await lockEndpoint(tx, c, w, { name });
      if (!row) throw missingEndpoint(name);
      const next = await changeEndpointRecord(tx, c, row, { ...q, key: rename });
      // URLs and header values are credentials: only that they changed is recorded (in fields), never their values.
      await recordAudit(tx, c, { action: 'endpoint.update', workspaceId: w, target: { type: 'endpoint', id: row.id }, details: { fields: Object.keys(c.req.valid('json')) },
        ...(next.key !== row.key || next.type !== row.type ? { before: { name, type: row.type } } : {}),
        after: { name: next.key, type: next.type, paused: q.paused, perMinute: q.perMinute, retryOnTimeout: q.retryOnTimeout, idempotent: q.idempotent, timeoutSeconds: q.timeoutSeconds, retryAttempts: q.retryAttempts, headerNames: q.headers?.map(h => h.name) } });
      return next;
    });
    return c.json(await endpointView(c.env, w, rowOf(updated)), 200);
  });
  app.openapi(createRoute({ ...meta, method: 'delete', path: `${base}/{name}`, operationId: 'deleteEndpoint', summary: 'Delete an endpoint no rule or route uses', request: { params: NameParam }, responses: { 200: response(z.object({ name: Name, deleted: z.literal(true) }).openapi('DeletedEndpoint')), ...errors } }), async c => {
    const w = receivingAdmin(c, manage).workspaceId, name = c.req.valid('param').name;
    await c.env.db.transaction(async tx => {
      const row = await lockEndpoint(tx, c, w, { name }, false);
      if (!row) throw missingEndpoint(name);
      await deleteEndpointRecord(tx, c, row, false);
      await recordAudit(tx, c, { action: 'endpoint.delete', workspaceId: w, target: { type: 'endpoint', id: row.id }, before: { name, type: row.type } });
    });
    return c.json({ name, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: `${base}/{name}/verification`, operationId: 'sendEndpointVerification', summary: 'Email a forward recipient a new confirmation link', description: 'For a pending, expired or (after 30 days) declined forward. The recipient must open the link and choose Allow; no API call can confirm on their behalf.', request: { params: NameParam, body: json(z.object({ from: z.string().max(254).optional() }).strict()) }, responses: { 202: response(Endpoint), ...errors } }), async c => {
    const w = receivingAdmin(c, manage).workspaceId, name = c.req.valid('param').name, q = c.req.valid('json');
    await c.env.db.transaction(async tx => {
      const row = await lockEndpoint(tx, c, w, { name }, false);
      if (!row) throw missingEndpoint(name);
      if (row.type !== 'forward') throw new ApiError(422, 'VERIFICATION_NOT_NEEDED', `${row.type} endpoints need no recipient confirmation.`);
      if (row.verified) throw new ApiError(409, 'ALREADY_CONFIRMED', `${name} is already confirmed.`);
      await requestConfirmation(c, tx, w, row.id, await decrypt(c.env, row.encryptedTarget!, targetBinding(w, row.id)), q.from);
    });
    c.get('actor').wakeJobs = 1;
    return c.json(await endpointView(c.env, w, await findEndpoint(c.env.db, w, name)), 202);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: `${base}/{name}/test`, operationId: 'testEndpoint', summary: 'Post a fixed test message to a Slack, Discord or webhook endpoint now', description: 'Bypasses rules and queues: one synchronous post, counted against the endpoint rate. Forwards send real mail, so they are not tested this way; use testRules for a dry run.', request: { params: NameParam }, responses: { 200: response(z.object({ ok: z.boolean(), status: z.number().int().nullable(), error: z.string().nullable() }).openapi('EndpointTest')), ...errors } }), async c => {
    const w = receivingAdmin(c, manage).workspaceId, name = c.req.valid('param').name;
    const [row] = await c.env.db.select().from(endpoints).where(and(eq(endpoints.workspaceId, w), eq(endpoints.key, name)));
    if (!row) throw missingEndpoint(name);
    if (row.type === 'forward') throw new ApiError(422, 'FORWARD_TEST_UNAVAILABLE', 'Forwards send real mail. Dry-run the rule with testRules instead.');
    if (needsUrl(row)) throw resumeNeedsUrl(); // Nothing is posted to a held endpoint, a test included.
    await debit(c.env.db, w, 'endpoint-test:' + row.id, 10, 'hour', 'At most 10 endpoint tests per hour.');
    try {
      const result = row.type === 'webhook'
        ? await (await import('./inbound-webhook.js')).sendTestWebhook(c.env, row, {})
        : await postWebhook(c.env, pinnedUrl(row.type, await decrypt(c.env, row.encryptedTarget!, targetBinding(w, row.id))), {}, JSON.stringify(renderChat(row.type, { [row.type === 'slack' ? 'text' : 'content']: `Test from ${productName}: ${endpointCall(name)} is connected.` })), null, targetBinding(w, row.id));
      const ok = result.status >= 200 && result.status < 300;
      return c.json({ ok, status: result.status, error: ok ? null : `HTTP ${result.status}` }, 200);
    } catch (e) {
      return c.json({ ok: false, status: null, error: e instanceof ApiError ? e.code : 'NETWORK_ERROR' }, 200);
    }
  });
  registerForwardPages(app);
}

// ── /v1/inbound/webhooks: webhook endpoints, named or not ─────────────────────────────────
// The native format is called nightmail. Requests may still name it bane (brand.ts legacyWebhookFormat), and webhooks store
// it as bane: the database constrains and compares the stored value, so every existing webhook delivers as before.
export const storedFormat = (format: typeof webhookFormat | typeof legacyWebhookFormat | 'inbound'): StoredFormat => format === 'inbound' ? 'inbound' : legacyWebhookFormat;
const shownFormat = (format: StoredFormat): typeof webhookFormat | 'inbound' => format === 'inbound' ? 'inbound' : webhookFormat;
const formatHelp = `${webhookFormat} (default): ${productName}'s thin signed event. inbound: inbound.new's email.received body with its X-Webhook-Verification-Token, X-Endpoint-ID, X-Webhook-Event and X-Webhook-Timestamp headers, plus ${productName}'s signature headers. Attachment downloadUrl and rawUrl need an admin API key.`;
const FormatInput = z.enum([webhookFormat, 'inbound', legacyWebhookFormat]).describe(`${formatHelp} ${legacyWebhookFormat} is the earlier name of ${webhookFormat}, still accepted.`);
// Delivery settings a route webhook needs. The inbound format replays inbound.new's email.received for receivers moved from it.
const hookOptions={key:RoutingKey.nullable().describe('Its endpoint name: rules call it as endpoints.<key>(…) and routes can name it as webhook:<key>. Shared with Slack, Discord and forward endpoint names.'),name:z.string().max(120).nullable().describe('Display name; sent as endpoint.name in the inbound format.'),
  format:z.enum([webhookFormat,'inbound']).describe(formatHelp),
  junk:z.enum(['skip','include']).describe(`include delivers junk mail (SES spam verdict not PASS) as message.junk, or with spam.isJunk in the inbound format. Defaults to skip for ${webhookFormat} and include for inbound.`),
  include:z.array(z.enum(['message','raw'])).max(2).describe(`${webhookFormat} format: also embed the message (text and HTML up to 256 KiB, attachment metadata) and raw MIME in message events. The signed JSON is capped at 512 KiB; fetch omitted content by URL.`),
  timeoutSeconds:z.number().int().min(1).max(30).describe('Seconds to wait for a 2xx response. Default 5.'),
  retryAttempts:z.number().int().min(0).max(10).describe(`Retries after a failed attempt, backing off from 15 seconds to 12 hours. Default 9 for ${webhookFormat}, 3 for inbound.`)};
const InboundWebhookSchema = z.object({ id: z.string(), url: WebhookUrlHint, description: z.string(), eventTypes: z.array(z.enum(inboundEventTypes)), paused: z.boolean(), headers: WebhookHeaderViews, createdAt: z.string(), updatedAt: z.string(), addressIds: z.array(z.string()).nullable(), approval: approvalField }).extend(hookOptions).openapi('InboundWebhook');
const DeliverySchema = z.object({ id: z.string(), webhookId: z.string(), eventId: z.string(), status: z.enum(['pending', 'delivered', 'failed','paused']), attemptCount: z.number().int(), lastStatusCode: z.number().nullable(), lastError: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).openapi('InboundWebhookDelivery');
const pageOf = <T extends z.ZodType>(item: T, name: string) => z.object({ data: z.array(item), nextCursor: z.string().nullable() }).openapi(name);
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const IdParam = z.object({ id: z.string().min(1).max(120) });
export const Ok = z.object({ ok: z.literal(true) }).openapi('InboundOk');
type Access = { access: (c: Ctx) => MailboxAccess; admin: (c: Ctx) => MailboxAccess };

export function registerInboundWebhooks(app: App, deps: Access) {
  const path = '/v1/inbound/webhooks', tags = ['Inbound webhooks'];
  const idFilter = z.array(z.string().min(1).max(120)).min(1).max(500).nullable().describe('Only events for these receiving addresses; null for all.');
  const readAccess = (c: Ctx) => c.get('actor')?.credential === 'apiKey' ? deps.access(c) : deps.admin(c);
  // A webhook outlives the credential that sets it up (requireReceivingConsent already refused approvals without consent).
  const manageHook = (c: Ctx) => { const value = deps.admin(c); lasting(c, WEBHOOK_CHANGE); return value; };
  const isWebhook = (w: string, webhookId: string) => and(eq(endpoints.workspaceId, w), eq(endpoints.id, webhookId), eq(endpoints.type, 'webhook'));
  const notFound = () => new ApiError(404, 'NOT_FOUND', 'Webhook was not found.');
  const getWebhook = async (db: DbExecutor, w: string, webhookId: string) => { const [row] = await db.select().from(endpoints).where(isWebhook(w, webhookId)); if (!row) throw notFound(); return row; };
  const lockWebhook = async (tx: DbExecutor, c: Ctx, w: string, webhookId: string, hold = true) => { const row = await lockEndpoint(tx, c, w, { id: webhookId }, hold); if (!row || row.type !== 'webhook') throw notFound(); return row; };
  const webhookView = async (c: Ctx, row: EndpointRecord) => ({ key: row.key, name: row.name, format: shownFormat(row.format), junk: row.junk, include: row.include, timeoutSeconds: row.timeoutSeconds, retryAttempts: row.retryAttempts,
    id: row.id, url: webhookUrlHint(row.url!), description: row.description, eventTypes: row.eventTypes as (typeof inboundEventTypes[number])[], addressIds: row.mailboxIds, paused: row.paused,
    headers: await webhookHeaderViews(c.env, row.encryptedHeaders, webhookSecretBinding(row.workspaceId, row.id), deps.access(c).admin), createdAt: isoTime(row.createdAt)!, updatedAt: isoTime(row.updatedAt)!,
    approval: await approvalTie(c.env, row.workspaceId, ['endpoint'], row.id) });
  const webhookFields = { ...z.object(hookOptions).partial().shape, format: FormatInput.optional(), url: z.string().url().max(2048), description: z.string().max(500), eventTypes: z.array(z.enum(inboundEventTypes)).max(inboundEventTypes.length).describe('Events to subscribe to. [] makes a route-only webhook: it receives only mail a route sends to it.'), paused: z.boolean(), headers: WebhookHeaders.optional() };
  const createFields = { ...webhookFields, description: webhookFields.description.default(''), eventTypes: webhookFields.eventTypes.default(['message.received']), paused: webhookFields.paused.default(false) };
  const create = z.object({ ...createFields, addressIds: idFilter.default(null) }).strict();
  const patch = z.object({ ...webhookFields, addressIds: idFilter }).partial().strict();
  // Charge actual queued copies, not API requests. A rejected charge rolls the requeue and its jobs back.
  const requeue=(wid:string,condition:ReturnType<typeof sql>)=>sql`WITH resumed AS (UPDATE mailbox_webhook_deliveries SET last_redelivery_at=now(),status='pending',generation=generation+1,last_error=NULL,updated_at=now() WHERE workspace_id=${wid} AND ${condition} RETURNING *), reset_success AS (DELETE FROM mail_action_attempts a USING resumed r WHERE a.workspace_id=r.workspace_id AND a.delivery_id=r.id AND a.state='delivered') INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'job_'||gen_random_uuid(),'mailbox.webhook',workspace_id,jsonb_build_object('deliveryId',id,'generation',generation) FROM resumed`;
  const inboundToken = async (format: string, secret: string) => format === 'inbound' ? { verificationToken: await (await import('./inbound-webhook.js')).verificationToken(secret) } : {};

  app.openapi(createRoute({ method: 'post', path, operationId: 'createInboundWebhook', security, tags, summary: 'Subscribe to inbound events', description: 'Deliveries are signed with Standard Webhooks headers (Webhook-Id, Webhook-Timestamp, Webhook-Signature) and retried with backoff. The endpoint must be a public HTTPS URL. The signing secret, and for the inbound format its verification token, are returned once. A webhook with a key is also a named endpoint (listEndpoints). Set up over MCP, or with a key that was, it is tied to that approval: approval and nextStep in the result say until when.', request: { body: json(create.openapi('CreateInboundWebhook')) }, responses: { 201: response(InboundWebhookSchema.extend({ secret: z.string(), verificationToken: z.string().optional().describe('inbound format: the X-Webhook-Verification-Token value.'), nextStep: z.string().optional().describe('Only for a webhook tied to an MCP approval: what it depends on and how to make a lasting one.') }).openapi('InboundWebhookSecret')), ...errors } }), async c => {
    const w = manageHook(c).workspaceId, input = c.req.valid('json'), format = storedFormat(input.format ?? webhookFormat);
    const { row, secret } = await c.env.db.transaction(async tx => {
      const created = await createEndpointRecord(tx, c, w, { type: 'webhook', key: input.key ?? null, name: input.name ?? null, url: input.url, description: input.description, eventTypes: input.eventTypes, addressIds: input.addressIds,
        paused: input.paused, format, junk: input.junk, include: input.include, timeoutSeconds: input.timeoutSeconds, retryAttempts: input.retryAttempts, headers: input.headers }, 'key');
      await recordAudit(tx,c,{action:'inbound_webhook.create',workspaceId:w,target:{type:'inbound_webhook',id:created.row.id},after:{url:webhookUrlHint(created.row.url!),key:input.key ?? null,name:input.name ?? null,eventTypes:created.row.eventTypes,addressIds:input.addressIds,format:shownFormat(format),paused:input.paused,headerNames:input.headers?.map(h=>h.name)}});
      return created;
    });
    c.header('Cache-Control', 'no-store');
    const view = await webhookView(c, row);
    return c.json({ ...view, ...view.approval ? { nextStep: tiedNextStep('webhook', view.approval) } : {}, secret: secret!, ...await inboundToken(format, secret!) }, 201);
  });
  app.openapi(createRoute({ method: 'get', path, operationId: 'listInboundWebhooks', security, tags,
    summary: 'List inbound webhooks a page at a time, in a stable ID order',
    description: 'Every webhook endpoint, named or not. Pass nextCursor back as cursor until it is null to read every webhook. addressId and eventType narrow the list to the webhooks that get that address\'s events (subscribed to it or to every address); getInboundOverview links a route\'s full list of subscribers this way.',
    request: { query: z.object({
      cursor: z.string().max(200).optional().describe('nextCursor from the previous page.'),
      limit: z.coerce.number().int().min(1).max(100).default(100),
      addressId: InboundAddressId.optional().describe('Only webhooks that get events for this address: subscribed to it, or to every address.'),
      eventType: z.enum(inboundEventTypes).optional().describe('Only webhooks subscribed to this event type.'),
    }) },
    responses: { 200: response(pageOf(InboundWebhookSchema, 'InboundWebhookList')), ...errors } }), async c => {
    const value = readAccess(c), q = c.req.valid('query');
    const rows = await c.env.db.select().from(endpoints).where(and(eq(endpoints.workspaceId, value.workspaceId), eq(endpoints.type, 'webhook'),
      q.addressId ? sql`(${endpoints.mailboxIds} IS NULL OR ${endpoints.mailboxIds} ? ${q.addressId})` : undefined,
      q.eventType ? sql`${endpoints.eventTypes} ? ${q.eventType}` : undefined,
      q.cursor ? lt(endpoints.id, q.cursor) : undefined)).orderBy(desc(endpoints.id)).limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return c.json({ data: await Promise.all(page.map(row => webhookView(c, row))), nextCursor: rows.length > q.limit ? page.at(-1)!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: `${path}/{id}`, operationId: 'getInboundWebhook', security, tags, request: { params: IdParam }, responses: { 200: response(InboundWebhookSchema), ...errors } }), async c => c.json(await webhookView(c, await getWebhook(c.env.db, readAccess(c).workspaceId, c.req.valid('param').id)), 200));
  app.openapi(createRoute({ method: 'patch', path: `${path}/{id}`, operationId: 'updateInboundWebhook', security, tags, description: 'Only supplied fields change. Changing format resets junk to that format\'s default unless junk is supplied too.', request: { params: IdParam, body: json(patch.openapi('UpdateInboundWebhook')) }, responses: { 200: response(InboundWebhookSchema), ...errors } }), async c => {
    const input = c.req.valid('json'), webhookId = c.req.valid('param').id;
    const updated = await c.env.db.transaction(async tx => {
      // One transaction and one row lock: two independently valid changes must not combine into a scoped message.stored subscription.
      const w = manageHook(c).workspaceId, row = await lockWebhook(tx, c, w, webhookId);
      const { format, ...rest } = input;
      const result = await changeEndpointRecord(tx, c, row, { ...rest, ...(format ? { format: storedFormat(format) } : {}) }, 'key');
      // Changed field names and non-secret values: a URL hint, never header values.
      await recordAudit(tx, c, { action: 'inbound_webhook.update', workspaceId: w, target: { type: 'inbound_webhook', id: row.id }, details: { fields: Object.keys(input) },
        before: { url: input.url ? webhookUrlHint(row.url!) : undefined, paused: input.paused !== undefined ? row.paused : undefined, eventTypes: input.eventTypes ? row.eventTypes : undefined },
        after: { url: input.url ? webhookUrlHint(result.url!) : undefined, paused: input.paused, eventTypes: input.eventTypes && result.eventTypes, addressIds: input.addressIds, key: input.key, format: format && shownFormat(storedFormat(format)), junk: input.junk, headerNames: input.headers?.map(h => h.name) } });
      return result;
    });
    return c.json(await webhookView(c, updated), 200);
  });
  const detach = z.object({ detach: z.enum(['true', 'false']).optional().describe('Also remove it from every route that delivers to it, as one routing version. Without it, a referenced webhook is not deleted.') });
  app.openapi(createRoute({ method: 'delete', path: `${path}/{id}`, operationId: 'deleteInboundWebhook', security, tags, request: { params: IdParam, query: detach }, responses: { 200: response(Ok), ...errors } }), async c => {
    const w = manageHook(c).workspaceId, webhookId = c.req.valid('param').id;
    await c.env.db.transaction(async tx => {
      const row = await lockWebhook(tx, c, w, webhookId, false);
      await deleteEndpointRecord(tx, c, row, true);
      await recordAudit(tx, c, { action: 'inbound_webhook.delete', workspaceId: w, target: { type: 'inbound_webhook', id: row.id }, before: { url: webhookUrlHint(row.url!), key: row.key, name: row.name, eventTypes: row.eventTypes } });
    });
    return c.json({ ok: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: `${path}/{id}/test`, operationId: 'testInboundWebhook', security, tags, summary: 'Send a test delivery',
    description: 'Posts a synthetic message.received for an example message, in the webhook\'s format or the one given, and returns the response status. overrideUrl sends it elsewhere, signed with a throwaway secret and without the webhook\'s custom headers.',
    request: { params: IdParam, body: json(z.object({ format: FormatInput.optional(), overrideUrl: z.string().max(2048).optional() }).strict().openapi('TestInboundWebhook')) }, responses: { 200: response(z.object({ statusCode: z.number().int() }).openapi('InboundWebhookTestResult')), ...errors } }), async c => {
    const row = await getWebhook(c.env.db, deps.admin(c).workspaceId, c.req.valid('param').id), input = c.req.valid('json');
    // Nothing is posted to a held webhook's saved URL, a test included; a test to another URL is not affected.
    if (row.paused && row.reconfirm && !input.overrideUrl) throw resumeNeedsUrl();
    await chargeManualDelivery(c.env.db, row.workspaceId, 1);
    const { sendTestWebhook } = await import('./inbound-webhook.js');
    try { return c.json({ statusCode: (await sendTestWebhook(c.env, row, { ...input, format: input.format && storedFormat(input.format) })).status }, 200); }
    catch (error) {
      if (error instanceof JobDeferred) throw new ApiError(503, 'WEBHOOK_COOLING_DOWN', `This endpoint timed out three times in a row; ${productName} tries it again after ${error.availableAt}.`, undefined, true);
      if (error instanceof ApiError) throw error;
      // The receiver timed out, refused the connection or failed its TLS handshake: the test's result, not a server failure (a 500).
      // Node reports a socket or certificate code; a Worker's fetch reports a TypeError. Anything else is a bug and stays a 500.
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'), code = (error as { code?: unknown }).code;
      if (!timedOut && !(error instanceof TypeError) && !(typeof code === 'string' && /^(?:E[A-Z]+|ERR_TLS_\w+|CERT_\w+|UNABLE_TO_\w+|DEPTH_ZERO_\w+|SELF_SIGNED_\w+)$/.test(code))) throw error;
      throw new ApiError(503, 'WEBHOOK_UNREACHABLE', timedOut ? `The endpoint did not answer within ${row.timeoutSeconds} seconds.` : 'The endpoint could not be reached.', undefined, true);
    }
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/inbound/messages/{messageId}/redeliver', operationId: 'redeliverInboundMessage', security, tags, summary: 'Redeliver a message to its route webhooks',
    description: 'Queues this message again for every route webhook that already finished with it (delivered or failed), or only destination. Returns how many deliveries were queued; 0 means none are eligible. Previously redelivered successes have a 10-minute cooldown. The workspace gets 60 manual posts per hour. Receivers deduplicate by Webhook-Id.',
    request: { params: z.object({ messageId: z.string().max(120) }), body: json(z.object({ destination: z.string().max(128).optional().describe('A webhook ID: redeliver to that webhook only.') }).strict().openapi('RedeliverInboundMessage')) }, responses: { 202: response(z.object({ queued: z.number().int() }).openapi('InboundRedelivery')), ...errors } }), async c => {
    const { workspaceId: w } = deps.admin(c), { messageId } = c.req.valid('param'), { destination } = c.req.valid('json');
    const queued = await c.env.db.transaction(async tx => {
      const n = (await tx.execute(requeue(w, sql`routed AND payload->>'messageId'=${messageId} AND status IN ('delivered','failed') AND (status='failed' OR last_redelivery_at IS NULL OR last_redelivery_at<=now()-interval '10 minutes') AND webhook_id IN (SELECT id FROM mailbox_webhooks WHERE workspace_id=${w} AND NOT paused ${destination ? sql`AND id=${destination}` : sql``})`))).rowCount ?? 0;
      await chargeManualDelivery(tx, w, n); return n;
    });
    c.get('actor').wakeJobs = queued;
    return c.json({ queued }, 202);
  });
  app.openapi(createRoute({ method: 'post', path: `${path}/{id}/rotate-secret`, operationId: 'rotateInboundWebhookSecret', security, tags, request: { params: IdParam }, responses: { 200: response(z.object({ secret: z.string(), verificationToken: z.string().optional().describe('inbound format: the new X-Webhook-Verification-Token, which changes with the secret.') }).openapi('InboundWebhookRotatedSecret')), ...errors } }), async c => {
    const w = manageHook(c).workspaceId, secret = webhookSecret();
    const row = await c.env.db.transaction(async tx => {
      const row = await lockWebhook(tx, c, w, c.req.valid('param').id);
      await tx.update(endpoints).set({ encryptedSecret: await encrypt(c.env, secret, webhookSecretBinding(w, row.id)), updatedAt: new Date().toISOString() }).where(and(eq(endpoints.workspaceId, w), eq(endpoints.id, row.id)));
      await recordAudit(tx, c, { action: 'inbound_webhook.secret_rotate', workspaceId: w, target: { type: 'inbound_webhook', id: row.id }, details: { url: webhookUrlHint(row.url!) } });
      return row;
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ secret, ...await inboundToken(row.format, secret) }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: `${path}/{id}/deliveries/{deliveryId}/retry`, operationId: 'retryInboundWebhookDelivery', security, tags, description: 'Retry a failed delivery to its original active endpoint. Receivers must deduplicate by Webhook-Id.', request: { params: IdParam.extend({ deliveryId: z.string().max(200) }) }, responses: { 202: response(Ok), ...errors } }), async c => {
    const p = c.req.valid('param'), w = deps.admin(c).workspaceId;
    await c.env.db.transaction(async tx => {
      const [row] = await tx.select().from(endpoints).where(isWebhook(w, p.id)).for('update');
      if (!row) throw notFound();
      if (row.paused) throw new ApiError(409, 'ENDPOINT_PAUSED', 'Resume the webhook before retrying.');
      if (!(await tx.execute(requeue(w, sql`webhook_id=${row.id} AND id=${p.deliveryId} AND status='failed'`))).rowCount) throw new ApiError(409, 'DELIVERY_NOT_FAILED', 'No failed delivery on this endpoint.');
      await chargeManualDelivery(tx, w, 1);
    });
    c.get('actor').wakeJobs = 1;
    return c.json({ ok: true as const }, 202);
  });
  app.openapi(createRoute({ method: 'get', path: `${path}/{id}/deliveries`, operationId: 'listInboundWebhookDeliveries', security, tags, request: { params: IdParam, query: z.object({ cursor: z.string().max(200).optional(), limit: Limit }) }, responses: { 200: response(pageOf(DeliverySchema, 'InboundWebhookDeliveryPage')), ...errors } }), async c => {
    // Newest first by creation time: delivery IDs are random, so ordering by ID showed an arbitrary sample, not the latest.
    const w = deps.admin(c).workspaceId, row = await getWebhook(c.env.db, w, c.req.valid('param').id), q = c.req.valid('query'), binding = `inbound-webhook-deliveries:${row.id}`, cursor = readCursor(q.cursor, binding);
    const rows = await c.env.db.select().from(mailboxWebhookDeliveries).where(and(eq(mailboxWebhookDeliveries.workspaceId, w), eq(mailboxWebhookDeliveries.webhookId, row.id), cursor ? sql`(${mailboxWebhookDeliveries.createdAt},${mailboxWebhookDeliveries.id})<(${cursor.at}::timestamptz,${cursor.id})` : undefined)).orderBy(desc(mailboxWebhookDeliveries.createdAt), desc(mailboxWebhookDeliveries.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(item => ({ id: item.id, webhookId: item.webhookId, eventId: String(item.payload.id), status: item.status, attemptCount: item.attemptCount, lastStatusCode: item.lastStatusCode, lastError: item.lastError, createdAt: isoTime(item.createdAt)!, updatedAt: isoTime(item.updatedAt)! })), nextCursor: nextCursor(rows, q.limit, binding) }, 200);
  });
}

// ── Recipient pages ────────────────────────────────────────────────────────────────────────
// Public, no login: the emailed link is the proof. GET only shows the request (mail scanners
// follow links); a same-origin POST from the page records the choice.
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
function page(c: Ctx, title: string, body: string, status: 200 | 403 | 404 | 410 = 200) {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex');
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:34rem;margin:12vh auto;padding:0 1.25rem;color:#1a1a1a;background:#fbfbf9}h1{font-size:1.15rem;margin:0 0 1rem}p{margin:0 0 1rem;color:#444}form{display:flex;gap:.75rem;margin-top:1.5rem}button{font:inherit;padding:.55rem 1rem;border-radius:6px;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;cursor:pointer}button[value=decline]{background:transparent;color:#1a1a1a;border-color:#bbb}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#aaa}button{background:#eee;color:#111;border-color:#eee}button[value=decline]{color:#eee;border-color:#555}}</style><h1>${escapeHtml(title)}</h1>${body}</html>`, status);
}
const sameOrigin = (c: Ctx) => {
  const origin = c.req.header('origin'), site = c.req.header('sec-fetch-site');
  return (origin === undefined || origin === new URL(c.env.config.publicUrl).origin) && (site === undefined || site === 'same-origin' || site === 'none');
};
async function stopSignature(runtime: Runtime, endpointId: string) {
  const key = await crypto.subtle.importKey('raw', Buffer.from(runtime.config.encryptionKey, 'hex'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('forward-stop\n' + endpointId))).toString('base64url');
}
/** Stop link included in every forwarded message. Signed, so nothing is stored per message. */
export async function forwardStopUrl(runtime: Runtime, endpointId: string) {
  return `${forwardBase(runtime)}/stop/${endpointId}.${await stopSignature(runtime, endpointId)}`;
}
type Pending = { workspace_id: string; id: string; encrypted_target: string; request_from: string | null };
const pendingWhere = async (token: string) => sql`proof_hash=${await digest(token)} AND type='forward' AND NOT verified AND declined_at IS NULL AND expires_at>now()`;
async function decline(tx: DbExecutor, runtime: Runtime, row: Pending) {
  await tx.execute(sql`UPDATE mailbox_webhooks SET verified=false,proof_hash=NULL,declined_at=now() WHERE workspace_id=${row.workspace_id} AND id=${row.id}`);
  const hash = await digest(await decrypt(runtime, row.encrypted_target, targetBinding(row.workspace_id, row.id)));
  await tx.execute(sql`INSERT INTO mail_forward_declines(workspace_id,address_hash) VALUES(${row.workspace_id},${hash}) ON CONFLICT(workspace_id,address_hash) DO UPDATE SET declined_at=now()`);
}
/** Records the recipient's choice. Single use: the token is cleared by whichever choice comes first. */
export async function answerForward(runtime: Runtime, token: string, choice: 'allow' | 'decline') {
  return runtime.db.transaction(async tx => {
    const row = (await tx.execute<Pending>(sql`SELECT workspace_id,id,encrypted_target,request_from FROM mailbox_webhooks WHERE ${await pendingWhere(token)} FOR UPDATE`)).rows[0];
    if (!row) throw new ApiError(410, 'CONFIRMATION_UNAVAILABLE', 'This link was already used or has expired.');
    if (choice === 'allow') await tx.execute(sql`UPDATE mailbox_webhooks SET verified=true,proof_hash=NULL,confirmed_at=now() WHERE workspace_id=${row.workspace_id} AND id=${row.id}`);
    else await decline(tx, runtime, row);
    return { address: await decrypt(runtime, row.encrypted_target, targetBinding(row.workspace_id, row.id)), from: row.request_from };
  });
}
function registerForwardPages(app: App) {
  const confirm = '/v1/forwarding/confirm/:token', stop = '/v1/forwarding/stop/:token';
  app.get(confirm, async c => {
    const token = c.req.param('token'), row = /^fwd_[0-9a-f]{64}$/.test(token) ? (await c.env.db.execute<Pending>(sql`SELECT workspace_id,id,encrypted_target,request_from FROM mailbox_webhooks WHERE ${await pendingWhere(token)}`)).rows[0] : undefined;
    if (!row) return page(c, 'This link has expired', '<p>It was already used, or more than 24 hours have passed. Nothing will be forwarded unless a new request is allowed.</p>', 410);
    const address = await decrypt(c.env, row.encrypted_target, targetBinding(row.workspace_id, row.id));
    return page(c, 'Allow email forwarding?', `<p><strong>${escapeHtml(row.request_from ?? `A ${productName} workspace`)}</strong> wants to forward the email it receives to <strong>${escapeHtml(address)}</strong>.</p><p>Forwarded messages arrive as plain text from that address, each with a link to stop. If you decline, this sender cannot ask again for 30 days.</p><form method="post"><button name="choice" value="allow">Allow forwarding</button><button name="choice" value="decline">Decline</button></form>`);
  });
  app.post(confirm, async c => {
    const token = c.req.param('token');
    if (!sameOrigin(c)) return page(c, 'Open the link from your email', '<p>Confirm from the page the emailed link opens.</p>', 403);
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>)), choice = form.choice === 'allow' ? 'allow' : form.choice === 'decline' ? 'decline' : null;
    if (!choice || !/^fwd_[0-9a-f]{64}$/.test(token)) return page(c, 'Choose Allow or Decline', '<p>Open the link from your email again and choose an option.</p>', 403);
    try {
      const done = await answerForward(c.env, token, choice);
      return choice === 'allow'
        ? page(c, 'Forwarding allowed', `<p>Email received by ${escapeHtml(done.from ?? 'this sender')} will now be forwarded to ${escapeHtml(done.address)}. Each forwarded message has a link to stop.</p>`)
        : page(c, 'Request declined', `<p>Nothing will be forwarded to ${escapeHtml(done.address)}. This sender cannot ask again for 30 days.</p>`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) return page(c, 'This link has expired', '<p>It was already used, or more than 24 hours have passed.</p>', 410);
      throw e;
    }
  });
  const stopRow = async (c: Ctx) => {
    const [endpointId, signature] = c.req.param('token')!.split('.');
    if (!endpointId || !signature || !/^con_[A-Za-z0-9_-]+$/.test(endpointId) || signature !== await stopSignature(c.env, endpointId)) return undefined;
    return (await c.env.db.execute<Pending & { declined_at: string | null }>(sql`SELECT workspace_id,id,encrypted_target,request_from,declined_at FROM mailbox_webhooks WHERE id=${endpointId} AND type='forward'`)).rows[0];
  };
  app.get(stop, async c => {
    const row = await stopRow(c);
    if (!row) return page(c, 'Link not recognized', '<p>This stop link is not valid.</p>', 404);
    if (row.declined_at) return page(c, 'Forwarding is off', '<p>These forwards are already stopped.</p>');
    return page(c, 'Stop these forwards?', `<p>Stop forwarding email from <strong>${escapeHtml(row.request_from ?? 'this sender')}</strong> to you. The sender cannot ask again for 30 days.</p><form method="post"><button name="choice" value="decline">Stop forwarding</button></form>`);
  });
  app.post(stop, async c => {
    if (!sameOrigin(c)) return page(c, 'Open the link from a forwarded message', '<p>Stop from the page the link opens.</p>', 403);
    const row = await stopRow(c);
    if (!row) return page(c, 'Link not recognized', '<p>This stop link is not valid.</p>', 404);
    await c.env.db.transaction(tx => decline(tx, c.env, row));
    return page(c, 'Forwarding stopped', '<p>No more messages will be forwarded to you from this sender.</p>');
  });
}

// ── Sending one delivery ───────────────────────────────────────────────────────────────────
/**
 * Posts one claimed delivery to its endpoint, by the endpoint's type: a webhook gets the signed event, Slack and Discord
 * the rule's message, and a forward sends the message on. Retries, rates and fences are applied around it by
 * deliverEndpoint (endpoint-delivery.ts).
 */
export async function sendToEndpoint(runtime: Runtime, w: string, h: ClaimedWebhook) {
  if (h.type === undefined || h.type === 'webhook') return (await import('./inbound-webhook.js')).deliverInboundWebhook(runtime, w, h);
  const event = h.payload as { messageId: string; type: string; ritualBody?: unknown; data: { recipients?: string[]; junk?: boolean } },
    endpointId = h.webhook_id;
  const d = (await runtime.db.execute<{ type: EndpointType; encrypted_target: string }>(sql`SELECT type,encrypted_target FROM mailbox_webhooks WHERE workspace_id=${w} AND id=${endpointId} AND type<>'webhook' AND verified AND declined_at IS NULL`)).rows[0];
  if (!d || event.type !== 'message.received' || event.data.junk || !event.data.recipients?.length)
    throw new ApiError(422, 'CONNECTOR_UNAVAILABLE', 'Only confirmed endpoints receive routed, non-junk mail.');
  const value = await decrypt(runtime, d.encrypted_target, targetBinding(w, endpointId));
  if (d.type !== 'forward') return postWebhook(runtime, pinnedUrl(d.type, value), {}, JSON.stringify(renderChat(d.type, event.ritualBody)), null, targetBinding(w, endpointId));
  const stopUrl = await forwardStopUrl(runtime, endpointId);
  await runtime.db.transaction(async tx => {
    await checkExternal(tx, w, value);
    const [m] = await tx.select().from(mailMessages).where(and(eq(mailMessages.workspaceId, w), eq(mailMessages.id, event.messageId), eq(mailMessages.direction, 'inbound'), retainedMail()));
    // Whether it may be forwarded is decided once at ingest (forwardEligibility); only whether it is still kept changes.
    // A message stored without the verdict (sandbox mail, an IMAP append) is never forwarded.
    if (!m || m.verdicts.forwardEligible !== true)
      throw new ApiError(422, 'FORWARD_BLOCKED', 'Automated, junk, unparsed, looped or unscanned mail is never forwarded.');
    const recipient = event.data.recipients![0]!;
    const [box] = await tx.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, w), sql`id=(SELECT mailbox_id FROM mailbox_addresses WHERE workspace_id=${w} AND address IN (${recipient},regexp_replace(${recipient},'[+][^@]*@','@')) ORDER BY (address=${recipient}) DESC LIMIT 1)`));
    if (!box || box.kind === 'inbox' || box.expiresAt) throw new ApiError(422, 'FORWARD_SENDER_REQUIRED', 'Forward from a permanent receiving address.');
    // One forward per message and endpoint, decided in the same transaction as the send.
    if (!(await tx.execute(sql`INSERT INTO mail_forward_once(workspace_id,message_id,endpoint,grants) VALUES(${w},${m.id},${endpointId},${JSON.stringify((h.payload as {grants?:string[]}).grants??[])}::jsonb) ON CONFLICT DO NOTHING RETURNING 1`)).rowCount) return;
    await debit(tx, w, 'forward-daily', 1000, 'day');
    await debit(tx, w, 'forward-hourly:' + endpointId, 200, 'hour');
    // Any incoming loop token blocks a forward (forwardEligibility), including tokens from other installations.
    const loop = await crypto.subtle.importKey('raw', Buffer.from(runtime.config.encryptionKey, 'hex'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const token = Buffer.from(await crypto.subtle.sign('HMAC', loop, new TextEncoder().encode(w + ':' + m.id))).toString('base64url');
    const sender = (((m.verdicts as { ritualVerified?: boolean }).ritualVerified && m.fromName) || m.fromAddress || 'Sender').replaceAll('@', ' at ').replace(/[\x00-\x1f<>\x7f]/g, ' ').slice(0, 100);
    const sent=await sendFromMailbox(runtime, tx, {
      actor: { workspaceId: w, keyId: 'forward:' + endpointId, permissions: ['send'], domains: [] },
      scope: { workspaceId: w }, mailbox: box, from: box.address,
      fromName: `${sender} via ${(box.displayName || box.address.split('@')[0]!).replace(/[\x00-\x1f@<>\x7f]/g, ' ').slice(0, 80)}`,
      to: [value], cc: [], bcc: [], replyTo: [],
      subject: 'Fwd: ' + m.subject.slice(0, 200),
      text: `${(m.text || m.snippet || '(No plain text)').slice(0, 64000)}\n\n--\nForwarded by ${box.address}. Stop these forwards: ${stopUrl}`,
      screen: true, inReplyTo: null, references: [], autoSubmitted: 'auto-generated',
      headers: [{ name: loopHeader, value: 'v1.1.' + token }],
      attachments: [],
    });
    await tx.execute(sql`UPDATE mail_forward_once SET email_id=${sent.message.sendingEmailId} WHERE workspace_id=${w} AND message_id=${m.id} AND endpoint=${endpointId}`);
  });
  return { status: 202 };
}
export { DEFAULT_POLICY };
