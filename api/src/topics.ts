import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { actor, ApiError, databaseCodeOf, errors, IdParams, isoTime, json, notFound, page, PageQuery, response, rowId, security, type Actor, type App, type DbExecutor } from './core.js';
import { consentAudit, topics } from './db/audience.js';
import { enqueue } from './jobs.js';

/**
 * Topics: the kinds of marketing mail a workspace sends ("Product updates", "Events"), and each contact's choice about
 * each one (migration 535). A marketing send or campaign may name one topic; its one-click unsubscribe then opts the
 * person out of that topic alone. A contact's marketing consent stays the switch for everything: a topic is sent only to
 * contacts subscribed to marketing who did not opt out of it (or, for a topic nobody gets by default, opted in).
 * A topic is never deleted, only archived: sends launched with it keep honoring its opt-outs, and it can come back.
 * A workspace without topics reads and writes none of this.
 */
export const TOPICS_MAX = 100;
const Name = z.string().trim().min(1).max(100);
const Description = z.string().trim().max(300);
const TopicInput = z.object({
  name: Name.describe('Shown to recipients on the preference page, e.g. "Product updates". Unique among the workspace\u2019s topics that aren\u2019t archived, ignoring case.'),
  description: Description.default('').describe('One line under the name on the preference page.'),
  subscribedByDefault: z.boolean().default(true).describe('What a contact who never chose gets: true sends the topic to everyone subscribed to marketing until they opt out of it; false only to those who opted in. Fixed when the topic is made.'),
}).strict();
const TopicPatch = z.object({
  name: Name.optional(), description: Description.optional(),
  archived: z.boolean().optional().describe('true archives the topic: it leaves the topic list and the preference page, and new sends can\u2019t name it, while sends already launched with it keep skipping the people who opted out of it. false brings it back, with every choice made about it.'),
}).strict().describe('subscribedByDefault is fixed when the topic is made: it can\u2019t change who gets the topic without their choice.');
const TopicQuery = PageQuery.extend({ archived: z.enum(['true', 'false']).default('false').describe('true lists the archived topics instead.') }).openapi('ListTopicsQuery');
export const Topic = z.object({ id: z.string(), workspaceId: z.string(), name: z.string(), description: z.string(), subscribedByDefault: z.boolean(), archivedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).openapi('Topic');
export const ContactTopic = z.object({
  topicId: z.string(), name: z.string(),
  subscribed: z.boolean().describe('Whether sends with this topic reach the contact, as far as the topic goes: the contact\u2019s own choice, or the topic\u2019s default without one. Mail is still sent only while the contact is subscribed to marketing and not suppressed.'),
  chosen: z.boolean().describe('true when a choice about this topic was recorded for the contact; false when subscribed is the topic\u2019s default.'),
  updatedAt: z.string().nullable().describe('When the choice was last recorded; null without one.'),
}).openapi('ContactTopic');

const limitReached = () => new ApiError(409, 'TOPIC_LIMIT_REACHED', `A workspace has at most ${TOPICS_MAX} topics that aren\u2019t archived. Archive one you no longer send.`);
// The unique index on the names of topics that aren't archived (migration 535) settles two writes racing for one name.
const named = <T>(work: Promise<T>) => work.catch(error => { throw databaseCodeOf(error) === '23505' ? new ApiError(409, 'TOPIC_EXISTS', 'The workspace already has a topic with this name.', 'name') : error; });
const activeCount = (workspaceId: string) => sql`(SELECT count(*) FROM audience_topics WHERE workspace_id = ${workspaceId} AND archived_at IS NULL)`;
const topicView = (row: typeof topics.$inferSelect) => ({ id: row.id, workspaceId: row.workspaceId, name: row.name, description: row.description, subscribedByDefault: row.subscribedByDefault, archivedAt: isoTime(row.archivedAt), createdAt: isoTime(row.createdAt)!, updatedAt: isoTime(row.updatedAt)! });

/** Every topic that isn't archived with the contact's state of it, oldest first (ContactTopic, plus its description). */
export async function contactTopicStates(db: DbExecutor, workspaceId: string, contactId: string) {
  const { rows } = await db.execute<{ topicId: string; name: string; description: string; subscribed: boolean; chosen: boolean; updatedAt: string | null }>(sql`
    SELECT t.id AS "topicId", t.name, t.description, coalesce(c.subscribed, t.subscribed_by_default) AS subscribed, c.topic_id IS NOT NULL AS chosen, c.updated_at AS "updatedAt"
    FROM audience_topics t LEFT JOIN audience_contact_topics c ON c.workspace_id = t.workspace_id AND c.contact_id = ${contactId} AND c.topic_id = t.id
    WHERE t.workspace_id = ${workspaceId} AND t.archived_at IS NULL ORDER BY t.id`);
  return rows.map(row => ({ ...row, updatedAt: isoTime(row.updatedAt) }));
}

/**
 * Records choices about topics for a contact its caller holds FOR UPDATE: each choice is stored, and each one that
 * changes whether the topic reaches the contact gets a consent record with its topic and a contact.subscription_changed
 * event with topicId. An unknown or archived topic is refused (TOPIC_NOT_FOUND). `resubscribe`: whether turning back on
 * a topic the contact opted out of is allowed (RESUBSCRIBE_CONFIRMATION_REQUIRED otherwise). Returns the topics it changed.
 */
export async function recordTopicChoices(tx: DbExecutor, workspaceId: string, contact: { id: string; email: string }, choices: { topicId: string; subscribed: boolean }[],
  decision: { source: string; policyVersion?: string; evidence?: string; occurredAt: string; actorKeyId: string | null }, resubscribe: boolean): Promise<string[]> {
  const ids = choices.map(choice => choice.topicId);
  const { rows: current } = await tx.execute<{ id: string; subscribed: boolean; chosen: boolean | null }>(sql`
    SELECT t.id, coalesce(c.subscribed, t.subscribed_by_default) AS subscribed, c.subscribed AS chosen
    FROM audience_topics t LEFT JOIN audience_contact_topics c ON c.workspace_id = t.workspace_id AND c.contact_id = ${contact.id} AND c.topic_id = t.id
    WHERE t.workspace_id = ${workspaceId} AND t.id = ANY(${sql.param(ids)}::text[]) AND t.archived_at IS NULL ORDER BY t.id FOR SHARE OF t`);
  const known = new Map(current.map(row => [row.id, row]));
  const missing = ids.find(id => !known.has(id));
  if (missing) throw new ApiError(422, 'TOPIC_NOT_FOUND', `Topic ${missing} was not found.`, 'topicId');
  if (!resubscribe && choices.some(choice => choice.subscribed && known.get(choice.topicId)!.chosen === false))
    throw new ApiError(409, 'RESUBSCRIBE_CONFIRMATION_REQUIRED', 'The contact opted out of this topic before: confirm they asked for it again (confirmResubscribe).', 'confirmResubscribe');
  const at = new Date().toISOString();
  await tx.execute(sql`INSERT INTO audience_contact_topics (workspace_id, contact_id, topic_id, subscribed, updated_at)
    SELECT ${workspaceId}, ${contact.id}, c."topicId", c.subscribed, ${at} FROM jsonb_to_recordset(${JSON.stringify(choices)}::jsonb) c("topicId" text, subscribed boolean)
    ON CONFLICT (workspace_id, contact_id, topic_id) DO UPDATE SET subscribed = excluded.subscribed, updated_at = excluded.updated_at`);
  const changed = choices.filter(choice => known.get(choice.topicId)!.subscribed !== choice.subscribed);
  for (const choice of changed) {
    const auditId = rowId('cns'), status = choice.subscribed ? 'subscribed' as const : 'unsubscribed' as const;
    await tx.insert(consentAudit).values({ id: auditId, workspaceId, contactId: contact.id, email: contact.email, status, source: decision.source, policyVersion: decision.policyVersion ?? null, evidence: decision.evidence ?? null, occurredAt: decision.occurredAt, actorKeyId: decision.actorKeyId, topicId: choice.topicId });
    await enqueue(tx, { type: 'operation.publish', workspaceId, payload: { event: { id: auditId, type: 'contact.subscription_changed', createdAt: at, workspaceId, region: null, data: { contactId: contact.id, status, source: decision.source, topicId: choice.topicId } } } });
  }
  return changed.map(choice => choice.topicId);
}

export function registerTopics(app: App) {
  const tags = ['Audience'];
  app.openapi(createRoute({ method: 'get', path: '/v1/topics', operationId: 'listTopics', tags, security, description: 'The workspace\u2019s topics, oldest first: the kinds of marketing mail it sends. A marketing send or campaign may name one, and its one-click unsubscribe then opts the person out of that topic only. A contact\u2019s choices are on getContact (topics) and set with updateContactConsent (topicId).', request: { query: TopicQuery }, responses: { 200: response(page(Topic)), ...errors } }), async c => {
    const a = actor(c), query = c.req.valid('query');
    const rows = await c.env.db.select().from(topics).where(and(eq(topics.workspaceId, a.workspaceId), query.archived === 'true' ? isNotNull(topics.archivedAt) : isNull(topics.archivedAt), query.cursor ? gt(topics.id, query.cursor) : undefined)).orderBy(asc(topics.id)).limit(query.limit + 1);
    return c.json({ data: rows.slice(0, query.limit).map(topicView), nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/topics', operationId: 'createTopic', tags, security, description: `Make a topic, a kind of marketing mail recipients can opt out of on its own (up to ${TOPICS_MAX} that aren\u2019t archived). Recipients see its name and description on the preference page. subscribedByDefault is fixed once made.`, request: { body: json(TopicInput) }, responses: { 201: response(Topic), ...errors } }), async c => {
    const a = actor(c, 'manage'), input = c.req.valid('json'), now = new Date().toISOString();
    const [row] = (await named(c.env.db.execute<{ id: string }>(sql`INSERT INTO audience_topics (id, workspace_id, name, description, subscribed_by_default, created_at, updated_at)
      SELECT ${rowId('top')}, ${a.workspaceId}, ${input.name}, ${input.description}, ${input.subscribedByDefault}, ${now}, ${now} WHERE ${activeCount(a.workspaceId)} < ${TOPICS_MAX} RETURNING id`))).rows;
    if (!row) throw limitReached();
    const [created] = await c.env.db.select().from(topics).where(and(eq(topics.workspaceId, a.workspaceId), eq(topics.id, row.id)));
    return c.json(topicView(created!), 201);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/topics/{id}', operationId: 'updateTopic', tags, security, description: 'Rename a topic, change its description, or archive it (archived) or bring it back. Who gets it by default is fixed when it is made.', request: { params: IdParams, body: json(TopicPatch) }, responses: { 200: response(Topic), ...errors } }), async c => {
    const a = actor(c, 'manage'), { archived, ...input } = c.req.valid('json'), now = new Date().toISOString(), id = c.req.valid('param').id;
    const [found] = await c.env.db.select().from(topics).where(and(eq(topics.workspaceId, a.workspaceId), eq(topics.id, id)));
    if (!found) notFound('Topic');
    const restoring = archived === false && found.archivedAt !== null;
    const [row] = await named(c.env.db.update(topics).set({ ...input, ...archived === undefined ? {} : { archivedAt: archived ? found.archivedAt ?? now : null }, updatedAt: now })
      .where(and(eq(topics.workspaceId, a.workspaceId), eq(topics.id, id), restoring ? sql`${activeCount(a.workspaceId)} < ${TOPICS_MAX}` : undefined)).returning());
    if (!row) throw limitReached();
    return c.json(topicView(row), 200);
  });
}
