import { sql, type SQL } from 'drizzle-orm';
import { ApiError, type Runtime } from './core.js';
import { log, logError } from './core.js';
import { campaignActive } from './states.js';
import { expireDomainClaims } from './operations.js';

// Rows per delete statement: small enough to finish well inside Hyperdrive's 60 s statement limit on 1 vCPU.
const RETENTION_BATCH = 5000;
const UPLOAD_BATCH = 1000;
const DAY_MS = 24 * 3600_000;

/**
 * Storage reconciliation, hourly after cleanup (the only retention step that calls storage). A put can
 * land at any time (see Storage.put): after its reservation expired, after the sweeper's deletion ran
 * and after the reservation's tombstone (158) was spent. The reconciler lists only the upload prefix
 * (uploadKey), takes only keys of its exact grammar (uploads/<existing workspace>/attachment_<32 hex>)
 * that are a day old and that no row references (storage_key_in_use), and queues their deletion; the
 * same object found again later is queued again. The deletion job checks the key once more when it
 * runs. Each run continues from a stored cursor and starts over at the end, so a large bucket is
 * covered over several runs. Tombstones remain the fast path, and the only one for keys of the earlier
 * layout (<workspace>/attachments/<id>), which this never lists.
 */
const UPLOAD_PREFIX = 'uploads/', UPLOAD_KEY = /^uploads\/[^/]+\/attachment_[0-9a-f]{32}$/, RECONCILE_PAGES = 20;
export async function reconcileUploads(runtime: Runtime, budgetMs = 60_000) {
  if (!runtime.storage.list) return 0;
  try { return await reconcilePages(runtime, Date.now() + budgetMs); }
  catch { log('warn', { code: 'UPLOAD_RECONCILE_FAILED', message: 'The next hourly run resumes the storage listing.' }); return 0; }
}
async function reconcilePages(runtime: Runtime, deadline: number) {
  let queued = 0, after = (await runtime.db.execute<{ after: string }>(sql`SELECT after FROM sending_upload_reconcile WHERE id='uploads'`)).rows[0]?.after ?? '';
  for (let page = 0; page < RECONCILE_PAGES && Date.now() < deadline; page++) {
    const listed = await runtime.storage.list!(UPLOAD_PREFIX, after || undefined), old = Date.now() - DAY_MS, next = listed.cursor ?? '';
    const keys = listed.objects.filter(o => UPLOAD_KEY.test(o.key) && o.uploaded.getTime() <= old).map(o => o.key);
    const { rows: [r] } = await runtime.db.execute<{ moved: boolean; n: number }>(sql`WITH moved AS (
        INSERT INTO sending_upload_reconcile(id,after) VALUES('uploads',${next}) ON CONFLICT(id) DO UPDATE SET after=excluded.after WHERE sending_upload_reconcile.after=${after} RETURNING 1),
      orphans AS (SELECT key,split_part(key,'/',2) AS wid FROM unnest(${sql.param(keys)}::text[]) key WHERE EXISTS(SELECT FROM moved)
        AND EXISTS(SELECT FROM workspaces w WHERE w.id=split_part(key,'/',2)) AND NOT storage_key_in_use(key)),
      queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'upload-orphan:'||key,'maintenance.deleteAttachment',wid,jsonb_build_object('key',key) FROM orphans
        ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,lease_until=NULL,last_error=NULL,available_at=now() WHERE jobs.status IN ('completed','failed') RETURNING 1)
      SELECT EXISTS(SELECT FROM moved) AS moved,(SELECT count(*)::int FROM queued) AS n`);
    // Another reconciler moved the cursor: it owns this page.
    if (!r?.moved) break;
    queued += r.n; after = next;
    if (!next) break;
  }
  return queued;
}
// Hourly cron invocations may run up to 15 minutes; stop starting new batches after this and continue next hour.
const RETENTION_BUDGET_MS = 4 * 60_000;

/**
 * The hourly backstop for the ten-minute standing job (src/standing.ts): runs the ladder now, which also re-queues any
 * workspace whose SES tenants differ from what Nightmail wants. The ladder, not this check, decides pauses (docs/sending-limits.md).
 */
export async function checkHostedHealth(runtime: Runtime) {
  if (!runtime.config.multiTenant) return;
  const { refreshStanding } = await import('./standing.js');
  const result = await refreshStanding(runtime);
  if (result.changed) log('info', { code: 'STANDING_REFRESHED', ...result });
}

/** Independent bounded slice, before other hourly drains. A poison batch must not
 * abort ordinary retention, MX checks or receipt recovery. Alternate deletion
 * and GC so a backlog or failure in either phase doesn't starve the other. */
export async function sweepInboxes(runtime:Runtime, budgetMs:number,clock=Date.now){
  const until=clock()+budgetMs;
  const phases=[{name:'leases',batch:sql`SELECT inbox_retention_batch(25) n`,done:false,failed:false},
    {name:'content',batch:sql`SELECT mail_gc_batch(1000) n`,done:false,failed:false},
    {name:'expunge history',batch:sql`SELECT inbox_prune_vanished() n`,done:false,failed:false},
    {name:'reservations',batch:sql`WITH pruned AS (DELETE FROM mail_retired_addresses WHERE (workspace_id,address) IN (SELECT workspace_id,address FROM mail_retired_addresses WHERE until<=now() ORDER BY until LIMIT 5000) RETURNING 1) SELECT count(*)::int n FROM pruned`,done:false,failed:false}];
  while(clock()<until && phases.some(p=>!p.done&&!p.failed))for(const p of phases){
    if(p.done||p.failed||clock()>=until)continue;
    try{const {rows}=await runtime.db.execute<{n:number}>(p.batch);p.done=Number(rows[0]?.n)===0;if(p.name==='leases'&&!p.done)phases[1].done=false;}
    catch{p.failed=true;log('error',{code:'INBOX_RETENTION_FAILED',phase:p.name});}
  }
  const pending=phases.filter(p=>!p.done).map(p=>p.name);
  log(pending.length?'warn':'info',{code:pending.length?'INBOX_RETENTION_PARTIAL':'INBOX_RETENTION_COMPLETED',pending});
  return pending.length===0;
}

/**
 * One retention step: a bounded statement that removes (or retires) at most `size` rows, oldest first, and returns their
 * count as n. `oldest` selects the time of the oldest row the step would still take, for the log. `lane` groups the steps in
 * the log (sent mail, received mail, everything else); the sent ones also run every 15 minutes (retentionTick). `batches`
 * caps the statements a step runs per pass.
 */
type Lane = 'sent' | 'inbound' | 'other';
type Drain = { name: string; statement: () => SQL; size?: number; oldest?: SQL; lane?: Lane; batches?: number };
const HOUR_MS = 3600_000, SENT_PERIOD_MS = 15 * 60_000;
// A 15-minute run of the sent-side tables, from the minute cron: well inside the cron's 15-minute wall time.
const SENT_BUDGET_MS = 3 * 60_000;

/** The rows of `table` that match `where`, oldest first by `by`. A row another run holds is skipped, not waited for. */
function expired(name: string, table: string, by: SQL, where: SQL, extra: Partial<Drain> = {}): Drain {
  const t = sql.identifier(table), size = extra.size ?? RETENTION_BATCH;
  return { name, oldest: sql`SELECT min(${by}) FROM ${t} WHERE ${where}`, ...extra,
    statement: () => sql`WITH gone AS (DELETE FROM ${t} WHERE ctid IN (SELECT ctid FROM ${t} WHERE ${where} ORDER BY ${by} LIMIT ${size} FOR UPDATE SKIP LOCKED) RETURNING 1) SELECT count(*)::int AS n FROM gone` };
}
const at = (column: string) => sql`${sql.identifier(column)}`;

/**
 * Every retention step, in their usual order. Never erase contacts, consent, suppression, drafts, idempotency keys or
 * active scheduled work.
 */
async function retentionDrains(runtime: Runtime): Promise<Drain[]> {
  const cutoff = sql`now() - interval '30 days'`, { abuseExpired, linkExpired } = await import('./abuse.js');
  const closedLongAgo = sql`SELECT id FROM support_conversations WHERE closed_at < now() - interval '90 days'`;
  const sent = { lane: 'sent' } as const, inbound = { lane: 'inbound' } as const;
  return [
    { name: 'expired_uploads', oldest: sql`SELECT min(expires_at) FROM sending_upload_reservations WHERE expires_at<=now()`, statement: () => sql`WITH expired AS (DELETE FROM sending_upload_reservations WHERE id IN
      (SELECT id FROM sending_upload_reservations WHERE expires_at<=now() ORDER BY expires_at LIMIT ${RETENTION_BATCH} FOR UPDATE SKIP LOCKED) RETURNING *),
      cleanup AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'upload-cleanup:'||id,'maintenance.deleteAttachment',workspace_id,jsonb_build_object('key',storage_key) FROM expired)
      SELECT count(*)::int AS n FROM expired` },
    // A day after a reservation ended without its attachment (158), delete its object once more: a late
    // put may have landed after the first deletion. An attachment that holds the object is never touched.
    { name: 'upload_tombstones', oldest: sql`SELECT min(delete_after) FROM sending_upload_tombstones WHERE delete_after<=now()`, statement: () => sql`WITH due AS (DELETE FROM sending_upload_tombstones WHERE id IN
      (SELECT id FROM sending_upload_tombstones WHERE delete_after<=now() ORDER BY delete_after LIMIT ${RETENTION_BATCH} FOR UPDATE SKIP LOCKED) RETURNING *),
      cleanup AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'upload-tombstone:'||d.id,'maintenance.deleteAttachment',d.workspace_id,jsonb_build_object('key',d.storage_key) FROM due d
        WHERE NOT EXISTS(SELECT FROM sending_attachments a WHERE a.id=d.id AND a.storage_key=d.storage_key) ON CONFLICT(id) DO NOTHING)
      SELECT count(*)::int AS n FROM due` },
    expired('api_request_budgets', 'api_request_budgets', at('window_start'), sql`window_start < now() - interval '1 day'`),
    // Denied sign-ins operators haven't acted on in 90 days (the table is otherwise capped at 10,000 identities).
    expired('access_requests', 'access_requests', at('last_requested_at'), sql`last_requested_at < now() - interval '90 days'`),
    // Refused sign-ins an operator has not acted on in 30 days (one row per subject).
    expired('nightmail_signin_attempts', 'nightmail_signin_attempts', at('last_at'), sql`last_at < now() - interval '30 days'`),
    // The waitlist keeps an address a year after its last attempt at most (migration 366).
    expired('nightmail_waitlist', 'nightmail_waitlist', at('last_at'), sql`last_at < now() - interval '1 year'`),
    ...['auth_state_slots', 'nightmail_dpop_proofs', 'nightmail_sessions', 'nightmail_login_flows'].map(table => expired(table, table, at('expires_at'), sql`expires_at <= now()`)),
    // Eight routing versions a year old per statement (migration 124).
    { name: 'mail_routing_versions', size: 8, oldest: sql`SELECT min(created_at) FROM mail_routing_versions WHERE created_at<now()-interval '1 year'`, statement: () => sql`SELECT mail_prune_route_versions() AS n` },
    expired('mail_receipts', 'mail_receipts', sql`coalesce(processed_at,created_at)`, sql`status IN ('processed','failed') AND coalesce(processed_at,created_at)<${cutoff}`, inbound),
    expired('mail_receipt_holds', 'mail_receipt_holds', at('expires_at'), sql`status<>'held' AND expires_at<${cutoff}`, inbound),
    // Received-mail events and webhook deliveries are kept 30 days. A delivery still held for a paused endpoint after that is
    // dead-lettered with ENDPOINT_PAUSED_EXPIRED (unpause no longer resumes it) and kept 7 more days so the reason is seen.
    expired('mailbox_events', 'mailbox_events', at('created_at'), sql`created_at<${cutoff}`, inbound),
    expired('mail_ignored_staging', 'mail_ignored_staging', at('created_at'), sql`created_at<now()-interval '3 days'`, inbound),
    { name: 'mailbox_webhook_deliveries_paused_expired', ...inbound, oldest: sql`SELECT min(created_at) FROM mailbox_webhook_deliveries WHERE created_at<${cutoff} AND status='paused'`,
      statement: () => sql`WITH held AS (UPDATE mailbox_webhook_deliveries SET status='failed',last_error='ENDPOINT_PAUSED_EXPIRED',updated_at=now() WHERE id IN (SELECT id FROM mailbox_webhook_deliveries
        WHERE created_at<${cutoff} AND status='paused' ORDER BY created_at LIMIT ${RETENTION_BATCH} FOR UPDATE SKIP LOCKED) RETURNING 1) SELECT count(*)::int AS n FROM held` },
    expired('mailbox_webhook_deliveries', 'mailbox_webhook_deliveries', at('created_at'), sql`created_at<${cutoff} AND status IN ('delivered','failed') AND (last_error IS DISTINCT FROM 'ENDPOINT_PAUSED_EXPIRED' OR updated_at<now()-interval '7 days')`, inbound),
    ...(runtime.config.multiTenant ? [
      // The score's daily evidence decays with a 30-day half-life; past 400 days it no longer moves the score or the card.
      expired('sender_score_daily', 'sender_score_daily', at('day'), sql`day < (now() AT TIME ZONE 'UTC')::date-400`),
      expired('operator_idempotency', 'operator_idempotency', at('created_at'), sql`created_at < now()-interval '1 day'`),
      // Keep only aggregate workspace evidence long enough to observe a 30-day clean span.
      ...['hosted_usage_hourly', 'hosted_health_hourly', 'hosted_health_credits', 'hosted_screen_hourly'].map(table => expired(table, table, at('hour'),
        table === 'hosted_health_hourly' || table === 'hosted_screen_hourly' ? sql`hour < now()-interval '32 days'` : sql`hour < now()-interval '2 days'`)),
    ] : []),
    expired('agent_tokens', 'agent_tokens', at('expires_at'), sql`expires_at < ${cutoff}`),
    // Abuse-monitoring signals past their retention (src/abuse.ts abuseExpired). Expiry runs whether monitoring is on or off.
    expired('abuse_signals', 'abuse_signals', at('last_at'), abuseExpired),
    expired('abuse_sampling', 'abuse_sampling', at('sampled_through'), sql`sampled_through < now()-interval '30 days'`),
    // Links leave with the signals they came from; a cluster nothing has rescored for 30 days (monitoring off, or its links gone) leaves too.
    expired('identity_links', 'identity_links', at('last_at'), linkExpired),
    expired('abuse_clusters', 'abuse_clusters', at('scored_at'), sql`scored_at < now()-interval '30 days'`),
    expired('abuse_alerts', 'abuse_alerts', at('created_at'), sql`created_at < now()-interval '1 year'`),
    // An erasure's floor outlives every record it could still apply to (the sign-in log, 30 days; signals, 90).
    expired('abuse_floors', 'abuse_floors', at('ignore_through'), sql`ignore_through < now()-interval '90 days'`),
    // The audit trail past its retention (src/audit.ts RETENTION); the table refuses to delete anything earlier. No row
    // locks: the application may not update it (42501), and only the hourly run takes it.
    { name: 'audit_events', oldest: sql`SELECT min(retain_until) FROM audit_events WHERE retain_until <= now()`, statement: () => sql`WITH gone AS (DELETE FROM audit_events WHERE id IN
      (SELECT id FROM audit_events WHERE retain_until <= now() ORDER BY retain_until LIMIT ${RETENTION_BATCH}) RETURNING 1) SELECT count(*)::int AS n FROM gone` },
    // Handoffs go 30 days after they expire; what they opened is in audit_events.
    expired('support_handoffs', 'support_handoffs', at('expires_at'), sql`expires_at < ${cutoff}`),
    // An email's sign-in nobody confirmed goes when it can no longer be confirmed (support-conversations.ts SIGNIN_DAYS), and
    // with it the sender address it kept; a Message-ID's binding once its Date is too old to bind anyway.
    expired('support_email_signins', 'support_email_signins', at('created_at'), sql`signed_in_at IS NULL AND created_at < now() - interval '7 days'`),
    expired('support_email_bindings', 'support_email_bindings', at('created_at'), sql`created_at < now() - interval '7 days'`),
    // Support transcripts (src/support-inbox.ts) and their subjects go 90 days after the conversation closed.
    expired('support_messages', 'support_messages', at('created_at'), sql`conversation_id IN (${closedLongAgo})`),
    { name: 'support_subjects', statement: () => sql`WITH gone AS (UPDATE support_conversations SET subject = NULL
        WHERE id IN (${closedLongAgo} AND subject IS NOT NULL LIMIT ${RETENTION_BATCH}) RETURNING 1) SELECT count(*)::int AS n FROM gone` },
    expired('audience_operation_plans', 'audience_operation_plans', at('expires_at'), sql`expires_at < now() - interval '1 day'`),
    // A preview holds its whole parsed CSV (up to 5 MiB) and is replaced by each re-preview, so abandoned ones pile up.
    // A week leaves room to come back and commit; committed imports stay because deliverability reads them.
    expired('audience_import_previews', 'audience_imports', at('created_at'), sql`status = 'preview' AND created_at < now() - interval '7 days'`, { size: 100 }),
    expired('sending_email_events', 'sending_email_events', at('created_at'), sql`created_at < ${cutoff}`, sent),
    // An email and its attachment links leave in the same statement, so no link can outlive its email.
    { name: 'sending_emails', ...sent, oldest: sql`SELECT min(created_at) FROM sending_emails WHERE created_at < ${cutoff} AND status NOT IN ('queued','attempting','scheduled')`, statement: () => sql`WITH gone AS (
        DELETE FROM sending_emails WHERE ctid IN (SELECT ctid FROM sending_emails WHERE created_at < ${cutoff} AND status NOT IN ('queued','attempting','scheduled')
          ORDER BY created_at LIMIT ${RETENTION_BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING id, workspace_id
      ), links AS (
        DELETE FROM sending_attachment_links l USING gone e WHERE l.owner_type = 'email' AND l.owner_id = e.id AND l.workspace_id = e.workspace_id
      ) SELECT count(*)::int AS n FROM gone` },
    // Retire lightweight preparation rows after terminal/obsolete work ages out. Never purge a campaign's current
    // snapshot or one with an outstanding reservation (including a failed launch).
    { name: 'sending_review_recipients', ...sent, statement: () => sql`WITH expired AS (
        SELECT r.review_id, r.ordinal FROM sending_review_recipients r
        JOIN sending_campaign_reviews v ON v.id = r.review_id
        WHERE v.created_at < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM sending_emails e WHERE (e.review_id,e.review_ordinal)=(r.review_id,r.ordinal))
          AND NOT EXISTS (SELECT 1 FROM sending_campaigns c WHERE c.id = v.campaign_id AND c.workspace_id = v.workspace_id
            AND (c.updated_at >= ${cutoff} OR ${campaignActive()} OR c.review_id = v.id))
        LIMIT ${RETENTION_BATCH} FOR UPDATE OF r SKIP LOCKED
      ), gone AS (DELETE FROM sending_review_recipients r USING expired e WHERE r.review_id = e.review_id AND r.ordinal = e.ordinal RETURNING 1)
      SELECT count(*)::int AS n FROM gone` },
    // One statement: a review's links leave once nothing of it is left.
    { name: 'review_attachment_links', size: Infinity, statement: () => sql`WITH gone AS (DELETE FROM sending_attachment_links l USING sending_campaign_reviews v
      WHERE l.owner_type = 'review' AND l.owner_id = v.id AND l.workspace_id = v.workspace_id
        AND v.created_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM sending_review_recipients r WHERE r.review_id = v.id)
        AND NOT EXISTS (SELECT 1 FROM sending_emails e WHERE e.review_id = v.id)
        AND NOT EXISTS (SELECT 1 FROM sending_campaigns c WHERE c.id = v.campaign_id AND c.workspace_id = v.workspace_id
          AND (${campaignActive()} OR c.review_id = v.id)) RETURNING 1) SELECT count(*)::int AS n FROM gone` },
    expired('operation_delivery_attempts', 'operation_delivery_attempts', at('created_at'), sql`created_at < ${cutoff}`, sent),
    // As in the inbound lane: a delivery still held for a paused endpoint after 30 days is dead-lettered with
    // ENDPOINT_PAUSED_EXPIRED (unpausing no longer resumes it) and kept 7 more days so the reason is seen. Only endpoints
    // that are still paused: an unpaused one's parked deliveries belong to its resume job.
    { name: 'operation_deliveries_paused_expired', ...sent, statement: () => sql`WITH expired AS (UPDATE operation_deliveries SET status='failed', last_error='ENDPOINT_PAUSED_EXPIRED', updated_at=now()
        WHERE id IN (SELECT d.id FROM operation_webhooks w JOIN operation_deliveries d ON d.workspace_id=w.workspace_id AND d.webhook_id=w.id
          WHERE w.paused AND d.status='paused' AND d.created_at < ${cutoff} ORDER BY d.created_at LIMIT ${RETENTION_BATCH} FOR UPDATE OF d SKIP LOCKED) RETURNING 1)
      SELECT count(*)::int AS n FROM expired` },
    expired('operation_deliveries', 'operation_deliveries', at('created_at'), sql`created_at < ${cutoff} AND status NOT IN ('pending','paused') AND (last_error IS DISTINCT FROM 'ENDPOINT_PAUSED_EXPIRED' OR updated_at < now() - interval '7 days')`, sent),
    expired('operation_events', 'operation_events', at('created_at'), sql`created_at < ${cutoff}`, sent),
    expired('operation_sns_receipts', 'operation_sns_receipts', at('created_at'), sql`created_at < ${cutoff}`, sent),
    expired('operation_feedback_failures', 'operation_feedback_failures', at('created_at'), sql`created_at < ${cutoff} AND reason NOT IN ('FEEDBACK_UNTAGGED','FEEDBACK_LEGACY_RECOVERY','FEEDBACK_QUEUE_RECOVERY')`, sent),
    expired('jobs', 'jobs', at('created_at'), sql`status IN ('completed','failed') AND type NOT IN ('maintenance.deleteAttachment','mail.deleteObjects') AND created_at < ${cutoff}`, sent),
    // Delete metadata only when no draft or message references it. The outbox retains the object key until deletion succeeds.
    // A fixed 50 rows an hour fell behind any installation retiring more than about 1,200 uploads a day, so their objects and
    // the workspace's stored-attachment usage were never released. Up to 5,000 a run now (120,000 a day), 1,000 per
    // transaction in workspace order: each queues an object deletion that shares the 'other' job class with domain checks and
    // alerts, and each row's usage trigger holds its workspace's usage row until the batch commits.
    { name: 'unused_attachments', size: UPLOAD_BATCH, batches: 5, statement: () => sql`WITH old AS (
        SELECT a.id FROM sending_attachments a WHERE a.created_at < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM sending_attachment_links l WHERE l.workspace_id = a.workspace_id AND l.attachment_id = a.id)
        ORDER BY a.workspace_id, a.id LIMIT ${UPLOAD_BATCH} FOR UPDATE SKIP LOCKED
      ), gone AS (DELETE FROM sending_attachments a USING old WHERE a.id = old.id RETURNING a.storage_key, a.workspace_id, a.source_template_asset_id
      ), queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'job_'||replace(gen_random_uuid()::text,'-',''),'maintenance.deleteAttachment',workspace_id,jsonb_build_object('key',storage_key)
        FROM gone WHERE source_template_asset_id IS NULL
      ) SELECT count(*)::int AS n FROM gone` },
    { name: 'unused_template_assets', size: UPLOAD_BATCH, batches: 5, statement: () => sql`WITH old AS (
        SELECT a.id FROM template_assets a WHERE a.created_at < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM template_asset_links l WHERE l.workspace_id = a.workspace_id AND l.asset_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM sending_attachments s WHERE s.workspace_id = a.workspace_id AND s.source_template_asset_id = a.id)
        ORDER BY a.workspace_id, a.id LIMIT ${UPLOAD_BATCH} FOR UPDATE SKIP LOCKED
      ), gone AS (DELETE FROM template_assets a USING old WHERE a.id = old.id RETURNING a.storage_key, a.workspace_id
      ), queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'job_'||replace(gen_random_uuid()::text,'-',''),'maintenance.deleteAttachment',workspace_id,jsonb_build_object('key',storage_key) FROM gone
      ) SELECT count(*)::int AS n FROM gone` },
    expired('jobs_attachment_deletes', 'jobs', at('created_at'), sql`status = 'completed' AND type IN ('maintenance.deleteAttachment','mail.deleteObjects') AND created_at < ${cutoff}`, sent),
  ];
}

// Per lane, so no map in a log line passes the logger's 50 keys.
type ByLane = Partial<Record<Lane, Record<string, number>>>;
type Retired = { deleted: ByLane; waiting: ByLane; failed: string[]; complete: boolean };
const note = (map: ByLane, d: Drain, n: number) => { const lane = (map[d.lane ?? 'other'] ??= {}); lane[d.name] = (lane[d.name] ?? 0) + n; };
/**
 * Runs retention steps within one budget. Each step is isolated: one that fails is logged and the rest still run. Each
 * gets at least one statement and a fair share of the time left (what's left divided by the steps still to go), so a
 * backlog in one table can't starve the tables after it; the time steps don't use goes to those still behind, in a
 * second pass. The first step changes every period, as sweepInboxes alternates its phases. Reports codes and counts only:
 * rows removed per table (a table that removed none is left out: every step ran unless it is in `failed`) and, for each
 * table with rows still waiting, the age in seconds of the oldest.
 */
async function retire(runtime: Runtime, drains: Drain[], budgetMs: number, periodMs: number, clock = Date.now): Promise<Retired> {
  const start = clock(), deadline = start + budgetMs, deleted: ByLane = {}, failed: string[] = [];
  // Steps with rows still waiting: `behind` ran out of time, `capped` reached its statements for the run.
  const behind = new Set<Drain>(), capped = new Set<Drain>();
  const first = drains.length ? Math.floor(start / periodMs) % drains.length : 0, order = [...drains.slice(first), ...drains.slice(0, first)];
  // Statements until one comes back short (nothing left), `until` passes or the step's cap. The first always runs.
  const step = async (d: Drain, until: number) => {
    for (let batches = 1; ; batches++) {
      const n = Number((await runtime.db.execute<{ n: number }>(d.statement())).rows[0]?.n ?? 0);
      if (n) note(deleted, d, n);
      if (n < (d.size ?? RETENTION_BATCH)) return 'done';
      if (batches >= (d.batches ?? Infinity)) return 'capped';
      if (clock() >= until) return 'behind';
    }
  };
  const attempt = async (d: Drain, until: number) => {
    behind.delete(d);
    try { const outcome = await step(d, until); if (outcome === 'behind') behind.add(d); else if (outcome === 'capped') capped.add(d); }
    catch (error) { failed.push(d.name); logError(error, { code: 'RETENTION_STEP_FAILED', table: d.name }, 'warn'); }
  };
  for (const [i, d] of order.entries()) await attempt(d, clock() + Math.max(0, deadline - clock()) / (order.length - i));
  for (const d of order) if (behind.has(d) && clock() < deadline) await attempt(d, deadline);
  const waiting: ByLane = {};
  for (const d of order) if (d.oldest && (behind.has(d) || capped.has(d) || failed.includes(d.name))) {
    try {
      const age = (await runtime.db.execute<{ s: string | null }>(sql`SELECT floor(extract(epoch FROM now() - (${d.oldest})))::bigint AS s`)).rows[0]?.s;
      if (age != null) note(waiting, d, Number(age));
    } catch { /* the step's failure is already logged */ }
  }
  return { deleted, waiting, failed, complete: !behind.size && !capped.size && !failed.length };
}
const retentionLog = (scope: string, run: Retired, complete = run.complete) =>
  log(complete ? 'info' : 'warn', { code: complete ? 'RETENTION_COMPLETED' : 'RETENTION_PARTIAL', scope, deleted: run.deleted, waiting: run.waiting, failed: run.failed });

/**
 * Hourly retention: every table, each in bounded batches that are their own transactions. It used to be one transaction
 * of unbounded deletes: a single statement over the 60 s limit (e.g. the 2M consent events of a bulk import all crossing
 * 30 days in the same hour) rolled back the whole run every hour, so nothing was ever retired again. Then it was one table
 * after another under one deadline with no isolation: a failing statement skipped every table after it, and a backlog at
 * the front used the whole budget. Throws after the run if a step failed, so hourlyUpkeep reports it.
 */
export async function cleanup(runtime: Runtime, budgetMs = RETENTION_BUDGET_MS) {
  const inboxComplete=await sweepInboxes(runtime,Math.min(60_000,Math.floor(budgetMs/4)));
  try { await checkHostedHealth(runtime); } catch { log('error', { code: 'HOSTED_HEALTH_CHECK_FAILED', message: 'Continuing retention; the next hourly check will retry.' }); }
  const deadline = Date.now() + budgetMs, failed: string[] = [];
  // A durable daily election prevents two reconcilers from applying the same
  // snapshot difference. Dispatch continues adding deltas while this runs.
  try {
    await runtime.db.execute(sql`WITH elected AS (INSERT INTO job_schedule(workspace_id,next_wake_at)
      VALUES ('maintenance:sending-depth',now()+interval '1 day') ON CONFLICT(workspace_id) DO UPDATE SET next_wake_at=excluded.next_wake_at
      WHERE job_schedule.next_wake_at<=now() RETURNING 1) SELECT reconcile_sending_depth(),reconcile_asset_usage(),reconcile_ingest_turns() FROM elected`);
  } catch (error) { failed.push('reconcile'); logError(error, { code: 'RETENTION_STEP_FAILED', table: 'reconcile' }, 'warn'); }
  let claims: number | undefined;
  if (runtime.config.multiTenant) {
    try { claims = await expireDomainClaims(runtime, Math.min(deadline, Date.now() + 60_000)); }
    catch (error) { failed.push('domain_claims'); logError(error, { code: 'RETENTION_STEP_FAILED', table: 'domain_claims' }, 'warn'); }
  }
  const run = await retire(runtime, await retentionDrains(runtime), Math.max(0, deadline - Date.now()), HOUR_MS);
  if (claims) run.deleted.other = { domain_claims: claims, ...run.deleted.other };
  run.failed.unshift(...failed);
  retentionLog('hourly', run, inboxComplete && run.complete && !failed.length);
  if (run.failed.length) throw new Error('Retention steps failed: ' + run.failed.join(', '));
}

/**
 * The sent-side tables every 15 minutes (elected, from the minute cron and the Node runner), so a day's mail aging out
 * is retired through the hour, not only in the hourly run, which still includes them. Concurrent runs skip each other's rows.
 */
export async function retentionTick(runtime: Runtime, budgetMs = SENT_BUDGET_MS) {
  const { rows } = await runtime.db.execute(sql`INSERT INTO job_schedule(workspace_id,next_wake_at) VALUES ('maintenance:sent-retention',now()+interval '15 minutes')
    ON CONFLICT(workspace_id) DO UPDATE SET next_wake_at=excluded.next_wake_at WHERE job_schedule.next_wake_at<=now() RETURNING 1`);
  if (!rows.length) return;
  retentionLog('sent', await retire(runtime, (await retentionDrains(runtime)).filter(d => d.lane === 'sent'), budgetMs, SENT_PERIOD_MS));
}

/** Received-mail events and webhook deliveries alone (the hourly run includes them): for checks that run just these. */
export async function pruneMailboxEvents(runtime: Runtime, budgetMs = 60_000) {
  const names = new Set(['mailbox_events', 'mail_ignored_staging', 'mailbox_webhook_deliveries_paused_expired', 'mailbox_webhook_deliveries']);
  retentionLog('inbound', await retire(runtime, (await retentionDrains(runtime)).filter(d => names.has(d.name)), budgetMs, HOUR_MS));
}
/** The hourly upkeep. Every step is best-effort: a failing step (a retention statement that keeps timing out) must not
 * skip the steps after it, and on Node, where this used to run inside the dispatch loop, it must not stop job processing
 * and mail dispatch. Returns the codes of the steps that failed. */
export async function hourlyUpkeep(runtime: Runtime, mailboxRuntime: () => Promise<Runtime> = async () => runtime) {
  const failed: string[] = [];
  for (const [code, step] of [
    ['MAINTENANCE_CLEANUP_FAILED', () => cleanup(runtime)],
    ['UPLOAD_RECONCILE_FAILED', () => reconcileUploads(runtime)],
    ['PREVIEW_SWEEP_FAILED', async () => (await import('./preview-images.js')).sweepPreviews(runtime)],
    ['REPUTATION_ALERT_CHECK_FAILED', async () => (await import('./reputation-alerts.js')).checkReputationAlerts(runtime)],
    ['MAILBOX_HOURLY_FAILED', async () => (await import('./mailbox-ingest.js')).mailboxHourly(await mailboxRuntime())],
    ['ANALYTICS_COMPACT_FAILED', async () => { if (runtime.config.dashboardAnalytics) await (await import('./analytics.js')).compactAnalytics(runtime); }],
    // Billing settles the closed hours (and once a UTC day its storage, unpaid, drift and expiry work).
    ['BILLING_HOURLY_FAILED', async () => { if (runtime.config.multiTenant) await (await import('./billing/cron.js')).billingHourly(runtime); }],
    // Connected AWS accounts: one health check each (byo-regional.ts).
    ['BYO_HEALTH_QUEUE_FAILED', async () => { await (await import('./byo-regional.js')).queueByoHealth(runtime); }],
    // Abuse monitoring (src/abuse.ts), last so it never delays the steps above: a bounded, leased slice. Hosted, and only while it is on.
    ['ABUSE_HOURLY_FAILED', async () => { await (await import('./abuse.js')).abuseHourly(runtime); }],
  ] as const) {
    try { await step(); } catch (error) { failed.push(code); log('warn', { code: error instanceof ApiError ? error.code : code, step: code }); }
  }
  return failed;
}
