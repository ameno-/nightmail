import { SQL, sql } from 'drizzle-orm';
import { ApiError, log, type DbExecutor, type JobHandler, type Runtime } from './core.js';
import { retryDatabaseFailures } from './jobs.js';
import { hostedAllowance } from './hosted-sending.js';
import { postSlack } from './reputation-alerts.js';

// Operator alerts (hosted): one Slack card when a customer may be in trouble, posted to OPERATOR_SLACK_WEBHOOK_URL.
// Each moment queues an operator.alert job in one statement that never fails what it reports; the job posts through
// the reputation alerts' Slack path (postSlack) and retries like them. Unset, nothing is posted: the hooks that read
// the configuration queue nothing, and the standing's (applyChange has none to read) queues a job that posts nothing.
//
// A new sign-up posts every time. Every other card posts at most once in 24 hours per workspace ('platform' for the
// installation-wide two), kept by the job's own ID: it names the UTC day, and yesterday's counts while it is under 24
// hours old. Each is queued when its state begins (a rise of the standing, a refusal, a sample that became full, a
// window that became slow), never while it simply continues.
//
// A card carries the workspace's name and plain words: never an address, a domain's contents, a score or a threshold.

const JOB = 'operator.alert', PLATFORM = 'platform';
const CARDS = {
  signup: { emoji: ':wave:', label: 'New sign-up' },
  paused: { emoji: ':double_vertical_bar:', label: 'Paused' },
  marketing_held: { emoji: ':mega:', label: 'Marketing on hold' },
  amazon_paused: { emoji: ':cloud:', label: 'Amazon paused' },
  daily_limit: { emoji: ':no_entry_sign:', label: 'Daily limit' },
  share_full: { emoji: ':bucket:', label: 'Customer share full' },
  signin_slow: { emoji: ':snail:', label: 'Sign-in mail slow' },
} as const;
type Kind = keyof typeof CARDS;
const REASONS = { bounces: 'too many bounces', complaints: 'too many spam complaints', screen: 'too much mail flagged as spam', review: 'after a review' } as const;
/** Sign-in mail is slow when, of at least `minimum` transactional emails in `minutes`, `share` or more waited over `seconds` for their first attempt. */
export const SLOW_SIGN_IN = { minutes: 15, seconds: 10, share: 1 / 20, minimum: 20 } as const;

// Slack mrkdwn has no escape for its emphasis characters, so a name shows look-alikes instead of turning bold or code.
const LOOKALIKE: Record<string, string> = { '*': '\u2217', '_': '\u02cd', '~': '\u223c', '`': '\u02cb' };
/** A workspace's name as card text: one line, an address cut to its local part, at most 80 characters, no markup. */
export function cardName(name: string) {
  const plain = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/([^\s@]+)@[A-Za-z0-9.-]+/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 80) || 'A workspace';
  return plain.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[*_~`]/g, c => LOOKALIKE[c]!);
}
const count = (n: unknown) => Number(n).toLocaleString('en-US');
/** "1 in 20", or "Most" or "All" past one in two. */
const share = (slow: number, mail: number) => mail / slow >= 2 ? `1 in ${Math.round(mail / slow)}` : slow >= mail ? 'All' : 'Most';
const whole = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * The Slack message for one alert: one section with an emoji, a bold label and a few words, an Open button into the
 * Operator area, and the same words as the plain-text fallback. Null for a payload that is not one of the seven.
 */
export function operatorCard(publicUrl: string, p: Record<string, unknown>, workspace: { id: string; name: string | null }) {
  const kind = p.kind as Kind, name = cardName(workspace.name ?? '');
  if (typeof kind !== 'string' || !Object.hasOwn(CARDS, kind)) return null;
  const card = CARDS[kind];
  const words = kind === 'signup' && whole(p.signedUp) && whole(p.limit) ? `${name}. ${count(p.signedUp)} of ${count(p.limit)}.`
    : kind === 'paused' ? `${name}${typeof p.reason === 'string' && Object.hasOwn(REASONS, p.reason) ? `, ${REASONS[p.reason as keyof typeof REASONS]}` : ''}.`
    : kind === 'marketing_held' ? `${name}.`
    : kind === 'amazon_paused' ? `${name}${typeof p.region === 'string' && p.region ? `, ${p.region}` : ''}.`
    : kind === 'daily_limit' && whole(p.used) && whole(p.limit) ? `${name}, ${count(p.used)} of ${count(p.limit)}.`
    : kind === 'share_full' && whole(p.used) && whole(p.share) ? `${count(p.used)} of ${count(p.share)}.`
    : kind === 'signin_slow' && whole(p.slow) && whole(p.mail) && Number(p.slow) > 0 ? `${share(Number(p.slow), Number(p.mail))} over ${SLOW_SIGN_IN.seconds} seconds.`
    : null;
  if (!words) return null;
  const origin = publicUrl.replace(/\/$/, ''), global = kind === 'share_full' || kind === 'signin_slow';
  const url = global ? `${origin}/operator` : `${origin}/operator/workspaces/${encodeURIComponent(workspace.id)}`;
  return {
    text: `${card.label}: ${words}`, unfurl_links: false, unfurl_media: false,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${card.emoji} *${card.label}* ${words}`, verbatim: true },
      accessory: { type: 'button', action_id: 'open', text: { type: 'plain_text', text: 'Open', emoji: false }, url } }],
  };
}

/**
 * Queues one card, in one statement that never fails its caller: a card that can't be queued is logged. Inside a
 * transaction pass `savepoint`, so a failed insert leaves the transaction usable. `daily`: at most one in 24 hours.
 */
async function queue(db: DbExecutor, workspaceId: string, kind: Kind, data: Record<string, unknown> | SQL, options: { daily: boolean; savepoint?: boolean }) {
  const key = `operator-alert:${kind}:${workspaceId}`, day = (ago: string) => sql`${key}||':'||to_char((now() AT TIME ZONE 'UTC')-${ago}::interval,'YYYYMMDD')`;
  const payload = data instanceof SQL ? data : sql`${JSON.stringify(data)}::jsonb`;
  try {
    if (options.savepoint) await db.execute(sql`SAVEPOINT operator_alert`);
    const { rows } = await db.execute(options.daily
      ? sql`INSERT INTO jobs(id,type,workspace_id,payload) SELECT ${day('0')},${JOB},${workspaceId},jsonb_build_object('kind',${kind}::text)||${payload}
          WHERE NOT EXISTS (SELECT FROM jobs WHERE id=${day('0')}) AND NOT EXISTS (SELECT FROM jobs WHERE id=${day('1 day')} AND created_at>now()-interval '24 hours')
          ON CONFLICT (id) DO NOTHING RETURNING id`
      : sql`INSERT INTO jobs(id,type,workspace_id,payload) VALUES (${key},${JOB},${workspaceId},jsonb_build_object('kind',${kind}::text)||${payload}) ON CONFLICT (id) DO NOTHING RETURNING id`);
    if (options.savepoint) await db.execute(sql`RELEASE SAVEPOINT operator_alert`);
    return rows.length > 0;
  } catch {
    if (options.savepoint) await db.execute(sql`ROLLBACK TO SAVEPOINT operator_alert`).catch(() => {});
    log('warn', { code: 'OPERATOR_ALERT_NOT_QUEUED', workspaceId, kind });
    return false;
  }
}

/**
 * New sign-up: "Driftwood. 91 of 100", for the workspace the new account owns, in the transaction that signed it up.
 * The one call site for the sign-up limit (pull request #575): after its account and workspace exist, with its places.
 */
export async function alertNewSignup(runtime: Runtime, db: DbExecutor, userId: string, places: { signedUp: number; limit: number }) {
  if (!runtime.config.operatorSlackWebhookUrl) return false;
  const [owned] = (await db.execute<{ workspace_id: string }>(sql`SELECT workspace_id FROM workspace_members WHERE user_id=${userId} AND role='owner' ORDER BY created_at,id LIMIT 1`)).rows;
  return !!owned && queue(db, owned.workspace_id, 'signup', { signedUp: places.signedUp, limit: places.limit }, { daily: false, savepoint: true });
}

const PAUSE_WHY: Record<string, keyof typeof REASONS> = { bounces: 'bounces', marketing_bounces: 'bounces', transactional_bounces: 'bounces', complaints: 'complaints', screen: 'screen' };
/**
 * A rise of the standing (src/standing.ts applyChange, in its transaction): a pause is Paused, or Amazon paused when
 * AWS paused the workspace's SES tenant; a restrict is Marketing on hold. Anything else posts nothing.
 */
export async function standingAlert(db: DbExecutor, workspaceId: string, step: string, reasons: { code: string; metric: string; step: string }[], details?: Record<string, unknown>) {
  if (step === 'restrict') return queue(db, workspaceId, 'marketing_held', {}, { daily: true, savepoint: true });
  if (step !== 'pause') return false;
  const why = reasons.find(r => r.step === 'pause') ?? reasons[0];
  if (why?.code === 'SES_TENANT_PAUSED') {
    const region = typeof details?.tenant === 'string' ? details.tenant.split(':')[3] ?? null : null;
    return queue(db, workspaceId, 'amazon_paused', { region }, { daily: true, savepoint: true });
  }
  return queue(db, workspaceId, 'paused', { reason: why?.code === 'OPERATOR_PAUSE' ? 'review' : why ? PAUSE_WHY[why.metric] ?? null : null }, { daily: true, savepoint: true });
}

/** Daily limit: a send refused at the workspace's daily limit (app.ts onError), with what admission counted against it. */
export async function dailyLimitAlert(runtime: Runtime, workspaceId: string) {
  if (!runtime.config.operatorSlackWebhookUrl) return false;
  // One incoming recipient: with none, the function leaves the hours (and what was used) out.
  const allowance = hostedAllowance(runtime.config, workspaceId, 1, 0, true);
  return queue(runtime.db, workspaceId, 'daily_limit', sql`(SELECT jsonb_build_object('used',(a->>'used')::bigint,'limit',(a->>'cap')::bigint) FROM (SELECT ${allowance} AS a) x)`, { daily: true });
}

/** Customer share full: the dispatcher's quota sample that found the share used up when the previous one had not. */
export async function shareFullAlert(runtime: Runtime, used: number, full: number) {
  if (!runtime.config.operatorSlackWebhookUrl) return false;
  return queue(runtime.db, PLATFORM, 'share_full', { used: Math.round(used), share: Math.round(full) }, { daily: true });
}

/**
 * Sign-in mail slow: on the standing job's ten-minute schedule, the last 15 minutes of Hosted transactional mail (no
 * campaigns, no simulated mail, no paused workspace) against the 15 minutes before them. An email waited from when it
 * was due (its creation, or a later scheduled time), as the dispatcher's DISPATCH_EMAIL queueMs measures it, until its
 * first attempt; one still queued counts once it has waited the full 10 seconds. Posts when the last window is slow
 * and the one before was not. Never throws.
 */
export async function checkSignInMail(runtime: Runtime) {
  if (!runtime.config.operatorSlackWebhookUrl) return false;
  try {
    const { minutes, seconds } = SLOW_SIGN_IN;
    const { rows } = await runtime.db.execute<{ current: boolean; mail: number; slow: number }>(sql`WITH mail AS (
        SELECT e.created_at>=now()-make_interval(mins=>${minutes}) AS current,e.status,
          CASE WHEN e.dispatch_version=0 THEN e.attempt_started_at ELSE (SELECT min(v.created_at) FROM sending_email_events v WHERE v.workspace_id=e.workspace_id AND v.email_id=e.id AND v.type='dispatch_attempt') END AS first,
          CASE WHEN e.dispatch_version=0 THEN greatest(e.created_at,e.scheduled_at) ELSE e.created_at END AS due
        FROM provider_connections pc JOIN sending_emails e ON e.workspace_id=pc.workspace_id AND e.snapshot->>'kind'='transactional'
          AND e.created_at>=now()-make_interval(mins=>${2 * minutes}) AND e.campaign_id IS NULL AND NOT e.simulated
        WHERE pc.kind='shared' AND pc.paused_at IS NULL
      ), waited AS (SELECT current,first IS NOT NULL AS attempted,coalesce(first,CASE WHEN status='queued' THEN clock_timestamp() END)-due>make_interval(secs=>${seconds}) AS slow FROM mail)
      SELECT current,count(*) FILTER (WHERE attempted OR slow)::int AS mail,count(*) FILTER (WHERE slow)::int AS slow FROM waited GROUP BY current`);
    const slowIn = (current: boolean) => rows.find(r => r.current === current && r.mail >= SLOW_SIGN_IN.minimum && r.slow >= r.mail * SLOW_SIGN_IN.share);
    const now = slowIn(true);
    if (!now || slowIn(false)) return false;
    return await queue(runtime.db, PLATFORM, 'signin_slow', { slow: now.slow, mail: now.mail }, { daily: true });
  } catch {
    log('warn', { code: 'SIGN_IN_MAIL_CHECK_FAILED', message: 'The next standing run checks again.' });
    return false;
  }
}

/** Posts one card. Without the webhook it does nothing; a refused or timed-out post throws, and the job retries. */
const deliver: JobHandler = async (runtime, payload, job) => {
  const url = runtime.config.operatorSlackWebhookUrl;
  if (!url) return;
  let name: string | null = null;
  if (payload.kind !== 'share_full' && payload.kind !== 'signin_slow') {
    const [workspace] = (await runtime.db.execute<{ name: string }>(sql`SELECT name FROM workspaces WHERE id=${job.workspaceId}`)).rows;
    if (!workspace) return; // The workspace was deleted meanwhile.
    name = workspace.name;
  }
  // AWS's region code, shown by its place name (us-east-2: Ohio).
  const region = payload.kind === 'amazon_paused' && typeof payload.region === 'string' && /^[a-z]{2}(-[a-z]+)+-\d$/.test(payload.region)
    ? (await import('./byo-regional.js')).regionLabels[payload.region] ?? payload.region : null;
  const card = operatorCard(runtime.config.publicUrl, { ...payload, ...(payload.kind === 'amazon_paused' ? { region } : {}) }, { id: job.workspaceId, name });
  if (!card) throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Invalid operator alert job.');
  await postSlack(url, card, 'OPERATOR_ALERT_FAILED');
};
export const operatorAlertJobs: Record<string, JobHandler> = { [JOB]: retryDatabaseFailures(deliver) };
