import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { bounded, utc, type Hosted } from './abuse.js';
import { accessed, BANDS, REASON_CODES, type Band, type ClusterChange } from './abuse-clusters.js';
import { errors, log, response, security, type App } from './core.js';
import { operatorActor } from './operator.js';

// Abuse monitoring, part 3: the alert outbox. When a cluster first reaches a level a person should look at, climbs a
// level or gains a member, one alert is stored with the Slack card it would post. Operators read the outbox in the
// Operator area. A card is posted only when ABUSE_SLACK_WEBHOOK_URL is set; unset, nothing leaves the installation.
//
// A card holds no personal data and no evidence: a risk level, reason codes from a fixed list, counts, workspace IDs
// and links into the Operator area (a staff sign-in). Never a workspace's name (it can be a person's), an address, a
// domain, a signal's value or free text. The payload and the webhook URL are never logged.

const rank = (band: Band) => BANDS.indexOf(band);
export type AlertKind = 'new' | 'raised' | 'grew';
/** Whether a change to a cluster is worth an alert: it first reached review or high, climbed a level, or gained a member there. */
export function alertFor(change: ClusterChange): AlertKind | null {
  if (rank(change.band) < rank('review')) return null;
  if (!change.previous || rank(change.previous.band) < rank('review')) return 'new';
  if (rank(change.band) > rank(change.previous.band)) return 'raised';
  return change.members > change.previous.members ? 'grew' : null;
}
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/, CODES: readonly string[] = REASON_CODES, WORKSPACES_SHOWN = 10, WORKSPACE_BUTTONS = 3;
const bandName = { review: 'Review', high: 'High' } as const, kindName: Record<AlertKind, string> = { new: 'New', raised: 'Risk raised', grew: 'New member' };
/**
 * The Slack message for one alert: Block Kit blocks and a plain-text fallback. Built only from a level, numbers, reason
 * codes on the fixed list and IDs of a safe shape; anything else is left out. No mentions, no unfurls, and every link
 * is under the installation's own Operator area.
 */
export function slackCard(publicUrl: string, alert: { cluster: string; band: 'review' | 'high'; score: number; kind: AlertKind; accounts: number; reasons: { code: string; points: number }[]; workspaces: string[] }) {
  const origin = publicUrl.replace(/\/$/, ''), ids = alert.workspaces.filter(id => SAFE_ID.test(id)), reasons = alert.reasons.filter(reason => CODES.includes(reason.code) && Number.isInteger(reason.points));
  const title = `Related accounts: ${bandName[alert.band].toLowerCase()} risk`, more = ids.length - WORKSPACES_SHOWN;
  const field = (name: string, value: string) => ({ type: 'mrkdwn' as const, text: `*${name}*\n${value}` });
  return {
    text: `${title} (score ${alert.score}, ${alert.accounts} accounts, ${ids.length} workspaces)`, unfurl_links: false, unfurl_media: false,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title, emoji: false } },
      { type: 'section', fields: [field('Risk', `${bandName[alert.band]} · ${alert.score}`), field('Change', kindName[alert.kind]), field('Accounts', String(alert.accounts)), field('Workspaces', String(ids.length))] },
      ...(reasons.length ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Reasons*\n${reasons.map(reason => `\`${reason.code}\` ${reason.points}`).join('\n')}` } }] : []),
      ...(ids.length ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Workspaces*\n${ids.slice(0, WORKSPACES_SHOWN).map(id => `\`${id}\``).join('\n')}${more > 0 ? `\n+${more} more` : ''}` } }] : []),
      { type: 'actions', elements: [
        { type: 'button', action_id: 'open_cluster', style: 'primary', text: { type: 'plain_text', text: 'Open in Operator', emoji: false }, url: `${origin}/operator/abuse/${alert.cluster}` },
        ...ids.slice(0, WORKSPACE_BUTTONS).map((id, i) => ({ type: 'button', action_id: `open_workspace_${i + 1}`, text: { type: 'plain_text', text: `Workspace ${i + 1}`, emoji: false }, url: `${origin}/operator/workspaces/${encodeURIComponent(id)}` })),
      ] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Monitoring only: nothing was blocked or paused. Details need a staff sign-in.' }] },
    ],
  };
}
/** Stores an alert for a cluster's change, at most one per cluster and level in seven days. Returns its ID, or null. */
export async function noteAlert(runtime: Hosted, change: ClusterChange) {
  const kind = alertFor(change), band = change.band;
  if (!kind || (band !== 'review' && band !== 'high')) return null;
  const id = `aal_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const payload = slackCard(runtime.config.publicUrl, { cluster: change.id, band, score: change.score, kind, accounts: change.accounts, reasons: change.reasons, workspaces: change.workspaces });
  const { rows } = await bounded(runtime, tx => tx.execute(sql`INSERT INTO abuse_alerts(id,cluster_id,band,score,kind,workspaces,payload) SELECT ${id},${change.id},${band},${change.score},${kind},${change.workspaces.length},${JSON.stringify(payload)}::jsonb
    WHERE NOT EXISTS (SELECT FROM abuse_alerts a WHERE a.cluster_id=${change.id} AND a.band=${band} AND a.created_at>now()-interval '7 days') RETURNING id`));
  return rows.length ? id : null;
}
export type SlackPost = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; redirect: 'manual'; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; body?: { cancel(): Promise<void> } | null }>;
const DELIVERED_A_RUN = 10, ATTEMPTS_MOST = 5;
/**
 * The delivery adapter: posts stored alerts of the last day to the Slack webhook, oldest first, a few a run. Without a
 * configured webhook it does nothing and alerts stay stored. A post that fails is tried again on later runs, five
 * times in all. Runs inside the hourly job's lease, so two runs never post the same alert.
 */
export async function deliverAlerts(runtime: Hosted, deadline: number, post: SlackPost = fetch) {
  const url = runtime.config.abuseSlackWebhookUrl;
  if (!url) return 0;
  const { rows } = await bounded(runtime, tx => tx.execute<{ id: string; payload: unknown }>(sql`SELECT id,payload FROM abuse_alerts WHERE status='stored' AND created_at>now()-interval '1 day' ORDER BY created_at LIMIT ${DELIVERED_A_RUN}`));
  let sent = 0;
  for (const alert of rows) {
    if (Date.now() >= deadline) break;
    let error: string | null = null;
    try {
      // Never follow a redirect: the card goes to the configured webhook only.
      const answer = await post(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(alert.payload), redirect: 'manual', signal: AbortSignal.timeout(5000) });
      await answer.body?.cancel().catch(() => undefined);
      if (!answer.ok) error = `HTTP_${answer.status}`;
    } catch { error = 'UNREACHABLE'; }
    if (!error) sent++; else log('warn', { code: 'ABUSE_ALERT_FAILED', reason: error });
    await bounded(runtime, tx => tx.execute(sql`UPDATE abuse_alerts SET attempts=attempts+1,error=${error},sent_at=CASE WHEN ${error === null} THEN now() END,
      status=CASE WHEN ${error === null} THEN 'sent' WHEN attempts+1>=${ATTEMPTS_MOST} THEN 'failed' ELSE 'stored' END WHERE id=${alert.id}`));
  }
  return sent;
}

const Alert = z.object({ id: z.string(), clusterId: z.string(), band: z.enum(['review', 'high']), score: z.number().int(), kind: z.enum(['new', 'raised', 'grew']), workspaces: z.number().int(),
  status: z.enum(['stored', 'sent', 'failed']), attempts: z.number().int(), createdAt: z.string(), sentAt: z.string().nullable(), payload: z.unknown().describe('The Slack message as it is, or would be, posted.') }).openapi('OperatorAbuseAlert');
export function registerAbuseAlerts(app: App) {
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/abuse/alerts', operationId: 'operatorListAbuseAlerts',
    request: { query: z.object({ cursor: z.string().max(100).regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|aal_[0-9a-f]{24}$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) },
    responses: { 200: response(z.object({ data: z.array(Alert), nextCursor: z.string().nullable(), delivery: z.enum(['slack', 'off']).describe('off: no Slack webhook is configured, so alerts are only stored.') })), ...errors } }), async c => {
    const operator = await operatorActor(c, 'operator:read'), q = c.req.valid('query'), [after, afterId] = q.cursor?.split('|') ?? [];
    await accessed(c, operator, 'abuse.alerts');
    const { rows } = await c.env.db.execute<z.infer<typeof Alert>>(sql`SELECT id,cluster_id AS "clusterId",band,score,kind,workspaces,status,attempts,${utc(sql`created_at`)} AS "createdAt",
        CASE WHEN sent_at IS NOT NULL THEN ${utc(sql`sent_at`)} END AS "sentAt",payload FROM abuse_alerts
      ${after ? sql`WHERE (created_at,id)<(${after}::timestamptz,${afterId})` : sql``} ORDER BY created_at DESC,id DESC LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit), last = page.at(-1);
    return c.json({ data: page, nextCursor: rows.length > q.limit && last ? `${last.createdAt}|${last.id}` : null, delivery: c.env.config.abuseSlackWebhookUrl ? 'slack' as const : 'off' as const }, 200);
  });
}
