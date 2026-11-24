import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { ApiError, errors, response, security, type App, type Ctx, type Runtime } from './core.js';
import { operatorActor } from './operator.js';
import { cachedDashboardRead } from './dashboard-cache.js';
import { placesRow, withOpen, type Places } from './signups.js';
import { alertLabel, quantile } from './health.js';
import { LATENCY_BUCKETS } from './health-counters.js';
import { TICK } from './health-thresholds.js';
import { GRADE_BANDS, GRADES, type Grade } from './standing-model.js';
import { poolSends } from './states.js';
import { MicroCentsJson } from './billing/money.js';

// Glass (/glass in the dashboard): everything going on in the installation on one page, for operators. One read that
// returns every figure, cached GLASS_TTL_SECONDS per installation, so the page's 30-second refresh costs one statement
// at most twice a minute however many operators watch it.
//
// The statement reads rollups and bounded heads, never a scan of mail:
//  - sending and delivery: sending_metrics_hourly (migration 407, kept exact by triggers), probed per workspace through
//    its (workspace_id, hour) index; the per-minute rate from public_stats_minutes (the pool's accepted mail by minute);
//  - queued and held mail: the partial indexes on queued and unscreened mail, counted to CAP + 1;
//  - received mail: each workspace's newest inbound messages since yesterday through mail_messages_tenant_page, at most
//    CAP + 1 a workspace (atLeast says when a count stopped there);
//  - sign-ups, standing, billing accounts and the health tables: small tables (one row per account, workspace or alert);
//  - money: topups through the ledger's (kind, source_id) index, this month's cost from billing_months per account;
//  - visitors: analytics_hourly (#680), by its hour-first key.
// Hidden from the public OpenAPI document. Anyone but a signed-in operator gets the 404 of a route that doesn't exist.

const GLASS_TTL_SECONDS = 30;
/** Bounded counts read at most this many rows (one more says the count is a lower bound). */
export const GLASS_CAP = 10_000;
const SEND_ROUTES = ['POST /v1/emails/send', 'POST /v1/emails/batch'];

const int = z.number().int();
const Count = z.object({ n: int, atLeast: z.boolean().describe(`n is a lower bound: counting stopped at ${GLASS_CAP.toLocaleString('en-US')}.`) });
const Split = z.object({ open: int, waitlist: int });
const Hour = z.object({ accepted: int, marketing: int.describe('Of accepted, marketing mail.'), delivered: int, bounced: int, complained: int });
const Glass = z.object({
  generatedAt: z.string(),
  signups: z.object({
    places: z.object({ limit: int, signedUp: int, held: int, waiting: int, open: int }),
    today: Split, week: Split.describe('The last 7 days.'),
    daily: z.array(int).describe('Sign-ups per UTC day, the last 14, oldest first.'),
    funnel: z.object({ signedUp: int, domainAdded: int, domainVerified: int, keyCreated: int, firstSend: int }).describe('Workspaces created in the last 30 days, and how many of them reached each step.'),
  }),
  sending: z.object({
    perMinute: int.describe('Emails the pool accepted in the last whole minute.'), minutes: z.array(int).describe('The last 60 whole minutes, oldest first.'),
    today: z.object({ transactional: int, marketing: int }).describe('Accepted since UTC midnight.'),
    hourly: z.array(Hour).describe('The last 24 hours by creation hour, oldest first; the last is the current hour.'),
    queued: Count, held: Count.describe('Held for content screening.'),
    campaigns: z.array(z.object({ id: z.string(), name: z.string(), workspace: z.string(), total: int, released: int, rate: z.number().nullable() })),
    sendApi: z.object({ requests: int, p50Ms: int, p95Ms: int }).nullable().describe('POST /v1/emails/send and /batch over the last 15 minutes: upper bounds of the latency buckets.'),
  }),
  delivery: z.object({
    grades: z.record(z.enum(GRADES), int), calibrating: int,
    paused: int.describe('Hosted workspaces whose sending is paused.'), held: int.describe('Hosted workspaces whose marketing is held.'),
  }),
  receiving: z.object({ today: int, spam: int, atLeast: z.boolean(), hourly: z.array(int).describe('The last 24 hours, oldest first.') }),
  money: z.object({ creditToday: MicroCentsJson, creditMonth: MicroCentsJson, creditDaily: z.array(int).describe('Cents added each UTC day this month.'),
    owed: MicroCentsJson, owing: int.describe('Workspaces with a negative balance.'), usageMonth: MicroCentsJson.describe('This month’s settled usage cost.') }),
  system: z.object({
    status: z.enum(['ok', 'warning', 'critical', 'stale']), measuredAt: z.string().nullable(),
    alerts: z.object({ critical: int, warning: int, top: z.array(z.object({ key: z.string(), label: z.string(), severity: z.enum(['critical', 'warning']), words: z.string(), since: z.string() })) }),
    ses: z.object({ regions: int, maxSendRate: z.number(), max24HourSend: z.number(), sentLast24Hours: z.number(), checkedAt: z.string().nullable() }).nullable(),
    deploy: z.object({ sha: z.string().nullable(), at: z.string().nullable() }),
  }),
  visitors: z.object({ views: int, visitors: int, hourly: z.array(int), referrers: z.array(z.object({ host: z.string(), views: int })).describe('The last 7 days.'),
    through: z.string().nullable().describe('The end of the last hour rolled up.') }),
});
export type Glass = z.infer<typeof Glass>;

type Raw = {
  places: Omit<Places, 'open'>; joined: { today: z.infer<typeof Split>; week: z.infer<typeof Split> }; joined_daily: number[]; funnel: Glass['signups']['funnel'];
  minutes: number[]; today: Glass['sending']['today']; hourly: Glass['sending']['hourly']; queued: number; held: number;
  campaigns: { id: string; name: string; workspace: string; total: number; released: number }[]; send_api: { n: number; slowest: number; hist: number[] | null }[];
  grades: Record<Grade | 'calibrating', number>; standing: { paused: number; held: number };
  received: { today: number; spam: number; capped: boolean }; received_hourly: number[];
  credit: { today: string; month: string }; credit_daily: number[]; owed: { uc: string; workspaces: number }; usage: string;
  health: { generatedAt: string | null; stale: boolean; campaigns: { id: string; rate: number | null }[] | null } | null;
  alerts: { key: string; kind: string; severity: 'critical' | 'warning'; words: string; since: string }[];
  ses: { regions: number; maxSendRate: number | null; max24HourSend: number | null; sentLast24Hours: number | null; checkedAt: string | null };
  views: number; visitors: number; views_hourly: number[]; referrers: { host: string; views: number }[]; views_through: string | null;
};

const utc = (value: SQL) => sql`to_char((${value}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
/** n buckets from `start`, oldest first, each `counts`' n for its bucket or 0. `counts` returns (at, n). */
const series = (start: SQL, unit: 'minute' | 'hour' | 'day', n: number, counts: SQL, end?: SQL) => sql`(SELECT coalesce(json_agg(coalesce(c.n,0) ORDER BY g.at),'[]')
  FROM generate_series(${start},${end ?? sql`${start}+${`${n - 1} ${unit}s`}::interval`},${`1 ${unit}`}::interval) g(at) LEFT JOIN (${counts}) c ON c.at=g.at)`;
// The grade bands as SQL, best first: A+ from 95, A from 90 below 95, and so on (src/standing-model.ts).
const gradeCounts = sql.join(GRADE_BANDS.map((band, i) => {
  const above = GRADE_BANDS[i - 1];
  return sql`${band.grade}::text,count(*) FILTER (WHERE s.phase='graded' AND s.score>=${band.min}${above ? sql` AND s.score<${above.min}` : sql``})`;
}), sql`,`);

export async function readGlass(runtime: Pick<Runtime, 'db' | 'config'>): Promise<Glass> {
  const cap = GLASS_CAP + 1, own = new URL(runtime.config.publicUrl).hostname;
  const { rows: [r] } = await runtime.db.execute<Raw>(sql`WITH t AS MATERIALIZED (SELECT date_trunc('day',now(),'UTC') AS today,date_trunc('hour',now(),'UTC') AS hour,
      date_trunc('minute',now(),'UTC') AS minute,date_trunc('month',now(),'UTC') AS month,(date_trunc('month',now() AT TIME ZONE 'UTC'))::date AS month_date,
      least(date_trunc('day',now(),'UTC'),date_trunc('hour',now(),'UTC')-interval '23 hours') AS since),
    mail AS MATERIALIZED (SELECT x.hour,x.kind='marketing' AS marketing,sum(x.accepted)::bigint AS accepted,sum(x.delivered)::bigint AS delivered,sum(x.bounced)::bigint AS bounced,sum(x.complained)::bigint AS complained
      FROM workspaces w CROSS JOIN LATERAL (SELECT m.hour,m.kind,m.accepted,m.delivered,m.bounced,m.complained FROM sending_metrics_hourly m WHERE m.workspace_id=w.id AND m.hour>=(SELECT since FROM t)) x GROUP BY 1,2),
    inbound AS MATERIALIZED (SELECT w.id,y.received_at,y.spam FROM workspaces w CROSS JOIN LATERAL (SELECT m.received_at,m.spam FROM mail_messages m
      WHERE m.workspace_id=w.id AND m.direction='inbound' AND m.received_at>=(SELECT since FROM t) ORDER BY m.received_at DESC LIMIT ${cap}) y)
    SELECT (SELECT row_to_json(p) FROM (${placesRow}) p) AS places,
      (SELECT json_build_object('today',json_build_object('open',count(*) FILTER (WHERE s.at>=t.today AND s.via='open'),'waitlist',count(*) FILTER (WHERE s.at>=t.today AND s.via='waitlist')),
          'week',json_build_object('open',count(*) FILTER (WHERE s.at>=now()-interval '7 days' AND s.via='open'),'waitlist',count(*) FILTER (WHERE s.at>=now()-interval '7 days' AND s.via='waitlist')))
        FROM nightmail_signups s WHERE s.at>=least(t.today,now()-interval '7 days')) AS joined,
      ${series(sql`t.today-interval '13 days'`, 'day', 14, sql`SELECT date_trunc('day',s.at,'UTC') AS at,count(*) AS n FROM nightmail_signups s WHERE s.at>=t.today-interval '13 days' GROUP BY 1`)} AS joined_daily,
      (SELECT json_build_object('signedUp',count(*),'domainAdded',count(*) FILTER (WHERE EXISTS (SELECT FROM domain_claims d WHERE d.workspace_id=w.id)),
          'domainVerified',count(*) FILTER (WHERE EXISTS (SELECT FROM domain_claims d WHERE d.workspace_id=w.id AND d.sending_state IN ('verified','lost'))),
          'keyCreated',count(k.workspace_id),
          'firstSend',count(*) FILTER (WHERE EXISTS (SELECT FROM analytics_funnel_first f WHERE f.workspace=w.id AND f.step='first_send') OR EXISTS (SELECT FROM sending_metrics_hourly m WHERE m.workspace_id=w.id AND m.accepted>0)))
        FROM workspaces w LEFT JOIN (SELECT DISTINCT workspace_id FROM api_keys) k ON k.workspace_id=w.id WHERE w.created_at>=now()-interval '30 days') AS funnel,
      ${series(sql`t.minute-interval '60 minutes'`, 'minute', 60, sql`SELECT minute AS at,accepted AS n FROM public_stats_minutes WHERE minute>=t.minute-interval '60 minutes' AND minute<t.minute`)} AS minutes,
      (SELECT json_build_object('transactional',coalesce(sum(accepted) FILTER (WHERE NOT marketing),0),'marketing',coalesce(sum(accepted) FILTER (WHERE marketing),0)) FROM mail WHERE hour>=t.today) AS today,
      (SELECT json_agg(json_build_object('accepted',coalesce(m.accepted,0),'marketing',coalesce(m.marketing,0),'delivered',coalesce(m.delivered,0),'bounced',coalesce(m.bounced,0),'complained',coalesce(m.complained,0)) ORDER BY g.at)
        FROM generate_series(t.hour-interval '23 hours',t.hour,interval '1 hour') g(at) LEFT JOIN (SELECT hour,sum(accepted) AS accepted,sum(accepted) FILTER (WHERE marketing) AS marketing,sum(delivered) AS delivered,
          sum(bounced) AS bounced,sum(complained) AS complained FROM mail GROUP BY 1) m ON m.hour=g.at) AS hourly,
      (SELECT count(*)::int FROM (SELECT FROM sending_emails WHERE status='queued' LIMIT ${cap}) q) AS queued,
      (SELECT count(*)::int FROM (SELECT FROM sending_emails WHERE NOT screened AND status IN ('queued','scheduled') LIMIT ${cap}) q) AS held,
      (SELECT coalesce(json_agg(json_build_object('id',c.id,'name',c.name,'workspace',c.workspace,'total',c.total,'released',c.released) ORDER BY c.updated_at DESC),'[]') FROM (
        SELECT c.id,coalesce(c.draft->>'name',c.id) AS name,w.name AS workspace,c.total,c.expanded AS released,c.updated_at FROM sending_campaigns c JOIN workspaces w ON w.id=c.workspace_id
        WHERE c.state='sending' ORDER BY c.updated_at DESC LIMIT 3) c) AS campaigns,
      (SELECT coalesce(json_agg(json_build_object('n',n,'slowest',slowest,'hist',hist)),'[]') FROM health_minutes WHERE minute>=t.minute-interval '15 minutes' AND kind='route' AND key=ANY(${sql.param(SEND_ROUTES)}::text[])) AS send_api,
      (SELECT json_build_object(${gradeCounts},'calibrating',count(*) FILTER (WHERE s.phase<>'graded' OR s.score IS NULL)) FROM sender_standing s) AS grades,
      (SELECT json_build_object('paused',count(*) FILTER (WHERE pc.paused_at IS NOT NULL),'held',count(*) FILTER (WHERE pc.paused_at IS NULL AND pc.marketing_held_at IS NOT NULL)) FROM provider_connections pc WHERE pc.kind='shared') AS standing,
      (SELECT json_build_object('today',count(*) FILTER (WHERE i.received_at>=t.today),'spam',count(*) FILTER (WHERE i.received_at>=t.today AND i.spam),
          'capped',coalesce(bool_or(i.n>=${cap}),false)) FROM (SELECT received_at,spam,count(*) OVER (PARTITION BY id) AS n FROM inbound) i) AS received,
      ${series(sql`t.hour-interval '23 hours'`, 'hour', 24, sql`SELECT date_trunc('hour',received_at,'UTC') AS at,count(*) AS n FROM inbound GROUP BY 1`)} AS received_hourly,
      (SELECT json_build_object('today',coalesce(sum(l.paid_uc) FILTER (WHERE l.created_at>=t.today),0)::text,'month',coalesce(sum(l.paid_uc),0)::text) FROM billing_ledger l WHERE l.kind='topup' AND l.created_at>=t.month) AS credit,
      ${series(sql`t.month`, 'day', 0, sql`SELECT date_trunc('day',l.created_at,'UTC') AS at,(sum(l.paid_uc)/1000000)::bigint AS n FROM billing_ledger l WHERE l.kind='topup' AND l.created_at>=t.month GROUP BY 1`, sql`t.today`)} AS credit_daily,
      (SELECT json_build_object('uc',coalesce(sum(-a.balance_uc),0)::text,'workspaces',count(*)) FROM billing_accounts a WHERE a.unpaid_since IS NOT NULL AND a.balance_uc<0) AS owed,
      (SELECT coalesce(sum(billing_month_cost(b.month,b.sent,b.received,b.other_uc)),0)::text FROM billing_accounts a JOIN billing_months b ON b.workspace_id=a.workspace_id AND b.month=t.month_date) AS usage,
      (SELECT json_build_object('generatedAt',${utc(sql`h.generated_at`)},'stale',coalesce(h.generated_at<now()-make_interval(secs=>${TICK.staleSeconds}),true),'campaigns',h.rollup->'campaigns') FROM health_state h WHERE h.singleton) AS health,
      (SELECT coalesce(json_agg(a),'[]') FROM (SELECT key,kind,severity,words,${utc(sql`since`)} AS since FROM health_alerts ORDER BY severity='critical' DESC,since,key LIMIT 200) a) AS alerts,
      (SELECT json_build_object('regions',count(*),'maxSendRate',sum(l.max_send_rate),'max24HourSend',sum(l.max_24_hour_send),'sentLast24Hours',sum(l.sent_last_24_hours),'checkedAt',${utc(sql`max(l.checked_at)`)})
        FROM provider_pool_regions p JOIN provider_account_limits l ON l.aws_account_id=p.aws_account_id AND l.region=p.region WHERE ${poolSends()}) AS ses,
      (SELECT coalesce(sum(events),0)::int FROM analytics_hourly WHERE hour>=t.today AND metric='page_view') AS views,
      (SELECT count(DISTINCT v)::int FROM analytics_hourly a CROSS JOIN LATERAL unnest(a.visitor_ids) v WHERE a.hour>=t.today AND a.metric='visit') AS visitors,
      ${series(sql`t.hour-interval '24 hours'`, 'hour', 24, sql`SELECT hour AS at,sum(events) AS n FROM analytics_hourly WHERE hour>=t.hour-interval '24 hours' AND metric='page_view' GROUP BY 1`)} AS views_hourly,
      (SELECT coalesce(json_agg(r ORDER BY r.views DESC,r.host),'[]') FROM (SELECT dimensions->>'referrer' AS host,sum(events)::int AS views FROM analytics_hourly
        WHERE hour>=t.today-interval '6 days' AND metric='page_view' AND dimensions->>'referrer' IS NOT NULL AND dimensions->>'referrer'<>${own} GROUP BY 1 ORDER BY 2 DESC,1 LIMIT 3) r) AS referrers,
      (SELECT ${utc(sql`max(hour)+interval '1 hour'`)} FROM analytics_hours) AS views_through
    FROM t`);
  return shape(r!, runtime.config);
}

function shape(r: Raw, config: Pick<Runtime['config'], 'deploy'>): Glass {
  const num = (value: unknown) => Number(value ?? 0);
  // The send routes' latency: their minutes' histograms added up, read as the Health page reads a route's.
  const rows = r.send_api.filter(row => row.n > 0), requests = rows.reduce((sum, row) => sum + row.n, 0);
  const hist = Array.from({ length: LATENCY_BUCKETS.length + 1 }, (_, i) => rows.reduce((sum, row) => sum + (row.hist?.[i] ?? 0), 0));
  const slowest = Math.max(0, ...rows.map(row => row.slowest));
  const rates = new Map((r.health?.campaigns ?? []).map(c => [c.id, c.rate]));
  const alerts = r.alerts.flatMap(a => { const label = alertLabel(a.kind); return label ? [{ key: a.key, label, severity: a.severity, words: a.words.replaceAll('`', ''), since: a.since }] : []; });
  const critical = alerts.filter(a => a.severity === 'critical').length, warning = alerts.length - critical;
  const status = !r.health?.generatedAt || r.health.stale ? 'stale' : critical ? 'critical' : warning ? 'warning' : 'ok';
  const ses = r.ses.regions && r.ses.maxSendRate !== null ? { regions: num(r.ses.regions), maxSendRate: num(r.ses.maxSendRate), max24HourSend: num(r.ses.max24HourSend),
    sentLast24Hours: num(r.ses.sentLast24Hours), checkedAt: r.ses.checkedAt } : null;
  return {
    generatedAt: new Date().toISOString(),
    signups: { places: withOpen(r.places), today: r.joined.today, week: r.joined.week, daily: r.joined_daily.map(num), funnel: r.funnel },
    sending: {
      perMinute: num(r.minutes.at(-1)), minutes: r.minutes.map(num),
      today: { transactional: num(r.today.transactional), marketing: num(r.today.marketing) },
      hourly: r.hourly.map(h => ({ accepted: num(h.accepted), marketing: num(h.marketing), delivered: num(h.delivered), bounced: num(h.bounced), complained: num(h.complained) })),
      queued: { n: Math.min(r.queued, GLASS_CAP), atLeast: r.queued > GLASS_CAP }, held: { n: Math.min(r.held, GLASS_CAP), atLeast: r.held > GLASS_CAP },
      campaigns: r.campaigns.map(c => ({ ...c, total: num(c.total), released: num(c.released), rate: rates.get(c.id) ?? null })),
      sendApi: requests ? { requests, p50Ms: quantile(hist, 0.5, slowest), p95Ms: quantile(hist, 0.95, slowest) } : null,
    },
    delivery: { grades: Object.fromEntries(GRADES.map(grade => [grade, num(r.grades[grade])])) as Record<Grade, number>, calibrating: num(r.grades.calibrating), paused: num(r.standing.paused), held: num(r.standing.held) },
    receiving: { today: num(r.received.today), spam: num(r.received.spam), atLeast: r.received.capped, hourly: r.received_hourly.map(num) },
    money: { creditToday: r.credit.today, creditMonth: r.credit.month, creditDaily: r.credit_daily.map(num), owed: r.owed.uc, owing: num(r.owed.workspaces), usageMonth: r.usage },
    system: { status, measuredAt: r.health?.generatedAt ?? null, alerts: { critical, warning, top: alerts.slice(0, 3) }, ses, deploy: { sha: config.deploy?.sha ?? null, at: config.deploy?.at ?? null } },
    visitors: { views: num(r.views), visitors: num(r.visitors), hourly: r.views_hourly.map(num), referrers: r.referrers, through: r.views_through },
  };
}

/** A signed-in operator, or exactly what a route that doesn't exist answers. */
async function glassOperator(c: Ctx) {
  try { return await operatorActor(c, 'operator:read'); }
  catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) { c.set('failure', { code: 'NOT_FOUND', unmatched: true }); throw new ApiError(404, 'NOT_FOUND', 'Route not found.'); }
    throw error;
  }
}

export function registerGlass(app: App) {
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/glass', operationId: 'operatorGetGlass',
    description: `Everything going on in the installation, for operators: sign-ups, sending, delivery, receiving, money, the system and visitors. One statement over rollups and bounded heads, cached ${GLASS_TTL_SECONDS} seconds.`,
    responses: { 200: response(Glass), ...errors } }), async c => {
    await glassOperator(c);
    const { value, hit } = await cachedDashboardRead(new URL(c.env.config.publicUrl).origin, 'operator-glass', () => readGlass(c.env), GLASS_TTL_SECONDS);
    c.header('cache-control', 'private, no-store');
    c.header('x-nightmail-glass-cache', hit ? 'hit' : 'miss');
    return c.json(value, 200);
  });
}
