import { sql, type SQL } from 'drizzle-orm';
import { ApiError, log, type Config, type DbExecutor, type Runtime } from './core.js';
import { builtinRefusal, isBuiltinHost } from './builtin-domain.js';
import { LINK_LABEL, LINK_RETENTION_DAYS } from './link-hosts.js';
import { cname, fqdn } from './public-dns.js';
import { GOOD_STANDING, RAMP } from './standing-model.js';

/**
 * Where the links Nightmail puts in customer mail live: the unsubscribe link (footer, text part and List-Unsubscribe),
 * forwarding's confirm and stop links, and linked images. Never on this installation's own domain, which a blocklist
 * would then list for every customer's mail at once.
 *
 * Each sending domain has its own link host, links.<domain>: a standard record of the domain's setup, a CNAME to the
 * installation's target (config.linkHosts.target, cname.nightmailedge.com on Hosted), which is a name in its Cloudflare for
 * SaaS zone. Once public DNS shows the CNAME, the domain's check makes it a custom hostname of that zone (checkLinkHost),
 * and once Cloudflare has issued its certificate, the host is active: mail from the domain links there, served by the
 * Worker on the customer's own name. With link hosts on, Hosted refuses campaign and marketing mail from a domain whose
 * link host isn't active (LINK_RECORD_REQUIRED), and self-hosted links on its own origin, PUBLIC_URL, until it is. An
 * installation without them (NIGHTMAIL_LINK_SAAS_* unset: self-hosted, or Hosted dev, which has no Cloudflare for SaaS
 * zone of its own) links on PUBLIC_URL, as before link hosts, and has no link records.
 *
 * While the zone's custom hostname quota is full, a domain whose CNAME is in place but whose own host isn't active yet
 * links on the shared fallback host (config.linkHosts.fallbackHost, links.nightmailedge.com; never this installation's own
 * domain) instead of being refused, within guardrails (linkChoice), and moves to its own host as soon as it is active.
 */
export const linkHostName = (domain: string) => `${LINK_LABEL}.${domain}`;
/** A link host retired with its domain (forgetLinkHost, cleanUpLinkHosts) that still answers its links: mail it already
 *  sent keeps working for LINK_RETENTION_DAYS. `h` is the link_hosts alias. */
const retained = (h: SQL) => sql`(${h}.status='retired' AND ${h}.retired_at > now() - make_interval(days => ${LINK_RETENTION_DAYS}))`;
export const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase().replace(/\.$/, '');

/** What the link is for: a campaign (and its test), a `kind: marketing` send, or a forward. */
export type LinkPurpose = 'campaign' | 'marketing' | 'forward';
/** Mail from a built-in domain that needs a link host: refused as the built-in domain's own rules refuse it. */
export function builtinLinkRefusal(config: Config, host: string, purpose: LinkPurpose) {
  return purpose === 'forward'
    ? new ApiError(422, 'BUILTIN_DOMAIN_UNSUPPORTED', 'The built-in domain has no link host for the stop link every forwarded message carries, so it can\u2019t forward. Verify a domain of your own for that.', 'from')
    : builtinRefusal(config, { code: 'BUILTIN_DOMAIN_UNSUPPORTED', field: purpose === 'marketing' ? 'kind' : 'campaign', host });
}
export function linkRecordRequired(target: string, domain: string, field = 'from') {
  return new ApiError(409, 'LINK_RECORD_REQUIRED', `Campaign and marketing mail from ${domain} needs the domain's link record, which carries its unsubscribe link: add a CNAME at ${linkHostName(domain)} pointing to ${target}, then check the domain.`, field);
}
/** The domain's link record is in place and its host isn't active yet, with no shared host to use meanwhile. */
function linkHostWaiting(domain: string, full: boolean) {
  return new ApiError(409, 'LINK_RECORD_REQUIRED', `Campaign and marketing mail from ${domain} links on its link host, ${linkHostName(domain)}, which isn\u2019t set up yet: ${full
    ? 'link hosts are at capacity right now, and it is set up automatically when there is room'
    : 'its certificate is issued once the domain is verified, usually within a few minutes'}. The CNAME is in place: nothing to change in DNS.`, 'from');
}
/** Today's allowance on the shared link host is used up (LINK_FALLBACK.dailyRecipients). */
export function linkFallbackSpent(domain: string) {
  return new ApiError(409, 'LINK_RECORD_REQUIRED', `Campaign and marketing mail from ${domain} links on a shared host until ${linkHostName(domain)} is set up, and today\u2019s allowance there (${LINK_FALLBACK.dailyRecipients.toLocaleString('en-US')} recipients) is used up. It resets at midnight UTC, or as soon as ${linkHostName(domain)} is active.`, 'from');
}

/**
 * The shared fallback link host's guardrails. Only a workspace in good standing past the new-sender checks uses it: graded,
 * a score of GOOD_STANDING or more with no warning (step ok or notice), out of the growth pace, and no paused connection
 * (an operator's pause or the abuse path takes it off at once, as every use asks again). Its campaign and marketing recipients linked there are
 * capped a UTC day at the ramp's first daily batch (RAMP.plan.firstBatch), counted in link_fallback_days.
 */
export const LINK_FALLBACK = { dailyRecipients: RAMP.plan.firstBatch } as const;
const fallbackDay = sql`(now() AT TIME ZONE 'UTC')::date`;
const fallbackEligible = (workspaceId: string) => sql`(coalesce((SELECT s.phase='graded' AND s.score>=${GOOD_STANDING} AND s.step IN ('ok','notice') AND (s.growth_until IS NULL OR s.growth_until<=now())
    FROM sender_standing s WHERE s.workspace_id=${workspaceId}),false)
  AND NOT EXISTS (SELECT 1 FROM provider_connections pc WHERE pc.workspace_id=${workspaceId} AND pc.paused_at IS NOT NULL))`;
/** Where a message's links go: `fallback` when on the shared host, with how many more campaign and marketing recipients
 *  the workspace may link there today (`left`, reserved with reserveFallback by whoever sends them). */
export type LinkChoice = { origin: string; fallback?: { host: string; left: number } };
/**
 * Counts `recipients` against the workspace's fallback allowance today, all or none: false when they don't fit. Each use is a row of
 * the workspace's (zero recipients for a forward's stop link), which is what lets the shared host serve its links
 * afterwards (servesWorkspace), even once the fallback is off. Logged for Glass's activity feed (src/glass.ts).
 */
export async function reserveFallback(db: DbExecutor, workspaceId: string, host: string, recipients: number) {
  // One statement: the workspace's day total (link_fallback_totals, whatever the host, so changing the host mid-day starts no
  // new allowance) takes them only if they fit, its row lock serializing concurrent reservations; then the host's row.
  const { rows: [row] } = await db.execute<{ recipients: number }>(sql`WITH total AS (
      INSERT INTO link_fallback_totals AS t(workspace_id, day, recipients) SELECT ${workspaceId}, ${fallbackDay}, ${recipients}::int WHERE ${recipients}::int <= ${LINK_FALLBACK.dailyRecipients}
      ON CONFLICT (workspace_id, day) DO UPDATE SET recipients=t.recipients+excluded.recipients WHERE t.recipients+excluded.recipients <= ${LINK_FALLBACK.dailyRecipients}
      RETURNING t.recipients),
    used AS (INSERT INTO link_fallback_days AS f(workspace_id, host, day, recipients) SELECT ${workspaceId}, ${host}, ${fallbackDay}, ${recipients}::int FROM total
      ON CONFLICT (workspace_id, host, day) DO UPDATE SET recipients=f.recipients+excluded.recipients RETURNING 1)
    SELECT recipients FROM total`);
  if (row) log('info', { code: 'LINK_FALLBACK_USED', workspaceId, recipients, today: row.recipients });
  else log('warn', { code: 'LINK_FALLBACK_SPENT', workspaceId, recipients });
  return !!row;
}
/** Hosted, a domain with no active link host: the shared host when its CNAME is in place (its own is waiting for room or
 *  its certificate) and the workspace passes the guardrails; otherwise refused, saying what it waits for. */
async function fallbackChoice(runtime: Runtime, db: DbExecutor, workspaceId: string, domain: string): Promise<LinkChoice> {
  const saas = runtime.config.linkHosts!, host = saas.fallbackHost;
  const { rows: [state] } = await db.execute<{ dns: string | null; full: boolean; eligible: boolean; used: number }>(sql`SELECT h.public_dns->>'state' AS dns,
      h.custom_hostname_id IS NULL AND (h.quota_full_at IS NOT NULL OR EXISTS (SELECT 1 FROM link_hosts q WHERE q.quota_full_at > now() - ${QUOTA_BACKOFF}::interval)) AS full,
      ${fallbackEligible(workspaceId)} AS eligible,
      coalesce((SELECT t.recipients FROM link_fallback_totals t WHERE t.workspace_id=${workspaceId} AND t.day=${fallbackDay}),0)::int AS used
    FROM (SELECT 1) one LEFT JOIN link_hosts h ON h.workspace_id=${workspaceId} AND h.domain=${domain}`);
  if (state?.dns !== 'found') throw linkRecordRequired(saas.target, domain);
  if (!host || !state.eligible) throw linkHostWaiting(domain, state.full);
  return { origin: `https://${host}`, fallback: { host, left: LINK_FALLBACK.dailyRecipients - Number(state.used) } };
}

/** The origin of the links in mail from `from` (an address or a domain): without link hosts, PUBLIC_URL; with them, the
 *  active link host of its domain (or of the workspace's domain it is under), else PUBLIC_URL when self-hosted. Hosted
 *  without one: the shared fallback host within its guardrails (fallbackChoice), else LINK_RECORD_REQUIRED. Doesn't count
 *  the fallback's allowance: a caller sending on it reserves its recipients (reserveFallback). */
export const linkOrigin = async (runtime: Runtime, db: DbExecutor, workspaceId: string, from: string, purpose: LinkPurpose = 'campaign') =>
  (await linkChoice(runtime, db, workspaceId, from, purpose)).origin;
export async function linkChoice(runtime: Runtime, db: DbExecutor, workspaceId: string, from: string, purpose: LinkPurpose = 'campaign'): Promise<LinkChoice> {
  const sender = domainOf(from), config = runtime.config;
  if (!config.linkHosts) return { origin: config.publicUrl.replace(/\/$/, '') };
  // A built-in domain has no DNS of its own to publish a link record in.
  if (isBuiltinHost(config, sender)) throw builtinLinkRefusal(config, sender, purpose);
  // The workspace's domains the sender is, or is under (its link hosts', and its domains' that have none yet), longest first.
  const { rows } = await db.execute<{ name: string; hostname: string | null }>(sql`SELECT d.name, h.hostname
    FROM (SELECT domain AS name FROM link_hosts WHERE workspace_id=${workspaceId} AND status<>'retired' UNION SELECT name FROM operation_domains WHERE workspace_id=${workspaceId}) d
    LEFT JOIN link_hosts h ON h.workspace_id=${workspaceId} AND h.domain=d.name AND h.status='active'
    WHERE d.name=${sender} OR right(${sender},length(d.name)+1)='.'||d.name ORDER BY length(d.name) DESC`);
  const active = rows.find(row => row.hostname);
  if (active) return { origin: `https://${active.hostname}` };
  if (!config.multiTenant) return { origin: config.publicUrl.replace(/\/$/, '') };
  const choice = await fallbackChoice(runtime, db, workspaceId, rows[0]?.name ?? sender);
  // A forward's stop link counts no recipients, but its use lets the shared host serve the link.
  if (purpose === 'forward' && choice.fallback) await reserveFallback(db, workspaceId, choice.fallback.host, 0);
  return choice;
}
/** linkChoice for several marketing messages: one lookup per sender domain. */
export function linkChoices(runtime: Runtime, db: DbExecutor, workspaceId: string) {
  const known = new Map<string, Promise<LinkChoice>>();
  return (from: string) => {
    const domain = domainOf(from);
    let choice = known.get(domain);
    if (!choice) { choice = linkChoice(runtime, db, workspaceId, domain, 'marketing'); known.set(domain, choice); }
    return choice;
  };
}
/** The link origin a campaign read found with it (`found`, its active link host's or its launch's), else what is left
 *  without a lookup: with link hosts, refused on Hosted; otherwise the installation's own origin. */
export function foundLinkOrigin(config: Config, from: string, found: string | null | undefined) {
  if (found) return found;
  if (!config.linkHosts) return config.publicUrl.replace(/\/$/, '');
  const sender = domainOf(from);
  if (isBuiltinHost(config, sender)) throw builtinLinkRefusal(config, sender, 'campaign');
  if (config.multiTenant) throw linkRecordRequired(config.linkHosts.target, sender);
  return config.publicUrl.replace(/\/$/, '');
}

/**
 * Whether a link page (unsubscribe, forwarding) may answer on the request's host for a link of `workspaceId`: this
 * installation's own origin (links sent before link hosts), that workspace's own active link host (or retired one, for
 * LINK_RETENTION_DAYS after its domain was deleted), or the shared fallback host if the workspace linked on it. So
 * links.a.com never serves workspace B's links.
 */
export async function servesWorkspace(runtime: Pick<Runtime, 'config' | 'db'>, requestUrl: string, workspaceId: string) {
  const host = new URL(requestUrl).hostname.toLowerCase().replace(/\.$/, ''), config = runtime.config;
  if (!config.linkHosts || [config.publicUrl, ...config.previousOrigins ?? []].some(origin => new URL(origin).hostname === host)) return true;
  // A retired host (its domain deleted) keeps serving the links it carried for LINK_RETENTION_DAYS; the shared fallback host
  // serves the links of the workspaces that used it, even once it is off for new mail.
  return !!(await runtime.db.execute(sql`SELECT 1 FROM link_hosts h WHERE h.workspace_id=${workspaceId} AND h.hostname=${host} AND (h.status='active' OR ${retained(sql`h`)})
    UNION ALL SELECT 1 FROM link_fallback_days WHERE workspace_id=${workspaceId} AND host=${host} LIMIT 1`)).rowCount;
}

// ----- Custom hostnames (Cloudflare for SaaS) ---------------------------------------------------------------------

type Saas = NonNullable<Config['linkHosts']>;
type CustomHostname = { id: string; status?: string; ssl?: { status?: string; validation_errors?: { message?: string }[] } | null; verification_errors?: string[] };
class CloudflareUnavailable extends Error { constructor(readonly status?: number) { super('Cloudflare unavailable'); } }
/**
 * A custom hostname this installation didn't make: another installation sharing the zone (production and dev share
 * nightmailedge.com) has the name. A custom hostname is this installation's only if one of its link_hosts rows records its
 * id, which works on every plan (per-hostname origins and metadata are Enterprise add-ons), so it never adopts, and so
 * never deletes, another's.
 */
class NotOurs extends Error {}
/** 1405: the zone's custom hostname quota is used up (a 30-day preview allows one; more are a request to Cloudflare). */
class QuotaFull extends Error { constructor(readonly answered: boolean) { super('Custom hostname quota full'); } }
/** After a 1405, no installation-wide attempt to make a custom hostname for this long: checks keep their own pace without
 *  asking Cloudflare again, and the first check after it tries once more. */
const QUOTA_BACKOFF = '1 hour';
/** One call to the zone's custom hostnames API (https://developers.cloudflare.com/api/resources/custom_hostnames/). */
async function customHostnames(saas: Saas, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/zones/${saas.zoneId}/custom_hostnames${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${saas.token}`, ...body ? { 'content-type': 'application/json' } : {} }, ...body ? { body: JSON.stringify(body) } : {} });
  } catch { throw new CloudflareUnavailable(); }
  const json = await response.json().catch(() => null) as { success?: boolean; result?: unknown; errors?: { code?: number }[] } | null;
  if (response.status >= 500 || response.status === 429 || !json) throw new CloudflareUnavailable(response.status);
  return { status: response.status, success: json.success === true, result: json.result, codes: (json.errors ?? []).map(error => error.code) };
}
/** The custom hostname for `hostname`, created with an HTTP-validated certificate if the zone has none yet. */
async function ensureCustomHostname(runtime: Runtime, saas: Saas, hostname: string): Promise<CustomHostname> {
  const { rows: [full] } = await runtime.db.execute<{ full: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM link_hosts WHERE quota_full_at > now() - ${QUOTA_BACKOFF}::interval) AS full`);
  if (full?.full) throw new QuotaFull(false);
  const created = await customHostnames(saas, 'POST', '', { hostname, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } });
  if (created.success) return created.result as CustomHostname;
  if (created.codes.includes(1405)) throw new QuotaFull(true);
  // 1406: the zone already has it: another workspace here with the domain (adopted), or another installation sharing the
  // zone (refused).
  if (created.codes.includes(1406)) {
    const found = await customHostnames(saas, 'GET', `?hostname=${encodeURIComponent(hostname)}`);
    const [existing] = found.success && Array.isArray(found.result) ? found.result as CustomHostname[] : [];
    if (!existing) throw new CloudflareUnavailable(found.status);
    const { rows: [mine] } = await runtime.db.execute<{ mine: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM link_hosts WHERE custom_hostname_id=${existing.id}) AS mine`);
    if (!mine?.mine) throw new NotOurs();
    return existing;
  }
  throw new CloudflareUnavailable(created.status);
}
const served = (custom: CustomHostname) => custom.status === 'active' && custom.ssl?.status === 'active';
function waiting(custom: CustomHostname) {
  const error = custom.ssl?.validation_errors?.[0]?.message ?? custom.verification_errors?.[0];
  return (error ? `Cloudflare: ${error}` : 'The CNAME is in place and the certificate is being issued, usually within a few minutes.').slice(0, 500);
}
type Seen = { state: 'found' | 'missing' | 'wrong_value'; values: string[]; checkedAt: string };

/**
 * The check of a domain's link host, with the domain's own (Check now, and the background checks). Public DNS must show
 * links.<domain> as a CNAME to the target; the first check that sees it makes it a custom hostname of the SaaS zone, and
 * the host is active once Cloudflare has validated it and issued its certificate. The CNAME is the proof: whoever can
 * point it at the target controls the domain's DNS. A host Cloudflare already serves stays active when public DNS hides
 * its CNAME (a record proxied by the customer's own Cloudflare zone). Never throws: an unanswered lookup keeps the last status.
 */
export async function checkLinkHost(runtime: Runtime, workspaceId: string, domain: string) {
  const saas = runtime.config.linkHosts;
  if (!saas || isBuiltinHost(runtime.config, domain)) return;
  const hostname = linkHostName(domain), checkedAt = new Date().toISOString();
  const { rows: [row] } = await runtime.db.execute<{ custom_hostname_id: string | null; status: 'pending' | 'active' | 'retired'; public_dns: Seen | null }>(sql`SELECT custom_hostname_id, status, public_dns FROM link_hosts WHERE workspace_id=${workspaceId} AND domain=${domain}`);
  // A retired host (its domain deleted, now added again) is checked afresh: active once Cloudflare serves it, pending until then.
  let id = row?.custom_hostname_id ?? null, status: 'pending' | 'active' = row?.status === 'active' ? 'active' : 'pending', detail: string | null = null, seen: Seen | null = row?.public_dns ?? null;
  // 'hit': Cloudflare just answered 1405 (the backoff starts now); 'waiting': within the backoff, nothing was asked.
  let quota: 'hit' | 'waiting' | null = null;
  // Hosted: only a domain this workspace has proven it controls gets a custom hostname (self-hosted: the operator's own): a pending claim (anyone can add one, and a
  // wildcard CNAME answers for any name under a domain they own) would otherwise make hostnames in the SaaS zone at will.
  const { rows: [claim] } = await runtime.db.execute<{ proven: boolean }>(sql`SELECT ever_proven OR sending_state IN ('verified','lost') AS proven FROM domain_claims WHERE workspace_id=${workspaceId} AND name=${domain}`);
  const proven = !runtime.config.multiTenant || claim?.proven === true;
  let target: string | null | undefined;
  try { target = await cname(hostname, AbortSignal.timeout(5000)); } catch { target = undefined; }
  if (target !== undefined) seen = target === null ? { state: 'missing', values: [], checkedAt } : fqdn(target) === saas.target ? { state: 'found', values: [], checkedAt } : { state: 'wrong_value', values: [fqdn(target)], checkedAt };
  try {
    if (seen?.state === 'found' || id) {
      let custom: CustomHostname | null = null;
      if (id) { const read = await customHostnames(saas, 'GET', `/${encodeURIComponent(id)}`); custom = read.success ? read.result as CustomHostname : null; if (!custom && read.status !== 404) throw new CloudflareUnavailable(read.status); }
      if (!custom && seen?.state === 'found' && proven) custom = await ensureCustomHostname(runtime, saas, hostname);
      id = custom?.id ?? null;
      status = custom && served(custom) ? 'active' : 'pending';
      if (custom && status !== 'active') detail = waiting(custom);
      else if (!custom && seen?.state === 'found') detail = 'The CNAME is in place. The link host is set up once the domain verifies.';
    } else status = 'pending';
  } catch (error) {
    if (error instanceof NotOurs) {
      id = null; status = 'pending';
      detail = `${hostname} is already a custom hostname of another installation on this zone, so it isn\u2019t set up here.`;
      log('warn', { code: 'LINK_HOST_NOT_OURS', workspaceId });
    } else if (error instanceof QuotaFull) {
      id = null; status = 'pending'; quota = error.answered ? 'hit' : 'waiting';
      detail = 'The CNAME is in place. Link hosts are at capacity right now; this one is set up automatically when there is room, with nothing to do on your side.';
      log('warn', { code: 'LINK_HOST_QUOTA_FULL', workspaceId });
    } else {
      if (!(error instanceof CloudflareUnavailable)) throw error;
      log('warn', { code: 'LINK_HOST_CHECK_UNAVAILABLE', workspaceId, status: error.status });
      detail = 'Cloudflare didn\u2019t answer. Check again in a minute.';
    }
  }
  const woke = status === 'active' && row?.status !== 'active';
  await runtime.db.execute(sql`INSERT INTO link_hosts(workspace_id, domain, hostname, custom_hostname_id, status, detail, public_dns, verified_at, quota_full_at)
    VALUES(${workspaceId}, ${domain}, ${hostname}, ${id}, ${status}, ${detail}, ${seen ? JSON.stringify(seen) : null}::jsonb, CASE WHEN ${status}='active' THEN now() END, CASE WHEN ${quota}='hit' THEN now() END)
    ON CONFLICT (workspace_id, domain) DO UPDATE SET custom_hostname_id=excluded.custom_hostname_id, status=excluded.status, detail=excluded.detail,
      public_dns=excluded.public_dns, checked_at=now(), verified_at=CASE WHEN excluded.status='active' THEN coalesce(link_hosts.verified_at, now()) END,
      quota_full_at=CASE WHEN ${quota}='hit' THEN now() WHEN ${quota}='waiting' THEN link_hosts.quota_full_at END, retired_at=NULL`);
  if (woke) await wakeLinkRecordHolds(runtime, workspaceId);
}
/** A link host just became active: the workspace's campaigns waiting for a link record (releaseStep, 'link_record') look
 *  again now instead of at their next 15-minute check. */
async function wakeLinkRecordHolds(runtime: Runtime, workspaceId: string) {
  const { rowCount } = await runtime.db.execute(sql`UPDATE jobs SET available_at=now() WHERE workspace_id=${workspaceId} AND status='pending' AND available_at>now()
    AND id IN (SELECT 'campaign.run:'||id FROM sending_campaigns WHERE workspace_id=${workspaceId} AND state='sending' AND waiting_reason='link_record')`);
  if (rowCount) try { await runtime.wake?.(rowCount); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'The campaign run is durable; the scheduler will run it.' }); }
}

type Readable = { name: string; dns: { name: string; type: 'CNAME' | 'TXT' | 'MX'; value: string; purpose: string; status: 'pending' | 'verified'; note?: string; publicDns?: Seen | null }[] };
/**
 * Each domain's link record, after its sending records: a standard record of its setup, which campaign and marketing
 * mail from the domain waits for and transactional mail doesn't (so it is not part of whether the domain is ready). Its
 * publicDns is what the last check of it saw; a domain never checked since link hosts came has none.
 */
export async function withLinkRecords<T extends Readable>(runtime: Runtime, workspaceId: string, reports: T[]): Promise<T[]> {
  const saas = runtime.config.linkHosts;
  if (!saas || !reports.length) return reports;
  const { rows } = await runtime.db.execute<{ domain: string; status: 'pending' | 'active'; detail: string | null; public_dns: Seen | null }>(sql`SELECT domain, status, detail, public_dns FROM link_hosts WHERE workspace_id=${workspaceId} AND domain=ANY(${sql.param(reports.map(report => report.name))}::text[])`);
  const found = new Map(rows.map(row => [row.domain, row]));
  // A domain whose CNAME is in place while its own host waits links on the shared host meanwhile, if the workspace may.
  const waiting = rows.some(row => row.status !== 'active' && row.public_dns?.state === 'found');
  const shared = waiting && !!saas.fallbackHost && runtime.config.multiTenant
    && !!(await runtime.db.execute<{ ok: boolean }>(sql`SELECT ${fallbackEligible(workspaceId)} AS ok`)).rows[0]?.ok;
  for (const report of reports) {
    // A built-in domain has no DNS of its own; a report that has its link record already keeps it.
    if (isBuiltinHost(runtime.config, report.name) || report.dns.some(record => record.purpose === 'links')) continue;
    const row = found.get(report.name), active = row?.status === 'active', at = report.dns.findLastIndex(record => record.purpose === 'sending') + 1;
    const record: T['dns'][number] = { name: linkHostName(report.name), type: 'CNAME', value: saas.target, purpose: 'links', status: active ? 'verified' : 'pending',
      ...active ? {} : { note: shared && row?.public_dns?.state === 'found'
        ? `${row.detail ?? 'The CNAME is in place.'} Until it is set up, links in campaign and marketing mail from ${report.name} use a shared link host.`.slice(0, 500)
        : row?.detail ?? `Campaign and marketing mail from ${report.name} carries its unsubscribe link on this host, and is refused until it verifies. If the domain's DNS is on Cloudflare, set the record to DNS only.`, ...row?.public_dns ? { publicDns: row.public_dns } : {} } };
    report.dns.splice(at, 0, record);
  }
  return reports;
}

/**
 * Link hosts of domains gone from their workspace (no operation_domains row of that name: a deleted, released or detached
 * claim, or a deleted workspace). An active one retires first: it goes on answering the links in mail its domain already
 * sent for LINK_RETENTION_DAYS. The rest (never active, or retired that long ago) go in pages of 1,000, at most 20 a run:
 * each custom hostname no live or retained row still uses is deleted at Cloudflare, then the rows. A row whose hostname
 * Cloudflare didn't delete stays for the next run.
 */
export async function cleanUpLinkHosts(runtime: Runtime) {
  const saas = runtime.config.linkHosts;
  if (!saas) return 0;
  const { rowCount: retiring } = await runtime.db.execute(sql`UPDATE link_hosts h SET status='retired', retired_at=now(), detail=NULL
    WHERE h.status='active' AND NOT EXISTS (SELECT 1 FROM operation_domains d WHERE d.workspace_id=h.workspace_id AND d.name=h.domain)`);
  if (retiring) log('info', { code: 'LINK_HOSTS_RETIRED', count: retiring });
  let total = 0;
  for (let page = 0; page < 20; page++) {
    const { selected, deleted } = await cleanUpLinkHostPage(runtime, saas);
    total += deleted;
    if (selected < 1000) break;
  }
  return total;
}
async function cleanUpLinkHostPage(runtime: Runtime, saas: Saas) {
  const live = sql`(EXISTS (SELECT 1 FROM operation_domains d WHERE d.workspace_id=o.workspace_id AND d.name=o.domain) OR ${retained(sql`o`)})`;
  const { rows } = await runtime.db.execute<{ workspace_id: string; domain: string; custom_hostname_id: string | null; shared: boolean }>(sql`SELECT h.workspace_id, h.domain, h.custom_hostname_id,
      EXISTS (SELECT 1 FROM link_hosts o WHERE o.custom_hostname_id=h.custom_hostname_id AND ${live}) AS shared
    FROM link_hosts h WHERE NOT EXISTS (SELECT 1 FROM operation_domains d WHERE d.workspace_id=h.workspace_id AND d.name=h.domain) AND NOT ${retained(sql`h`)} LIMIT 1000`);
  const kept = new Set<string>();
  for (const id of new Set(rows.flatMap(row => row.custom_hostname_id && !row.shared ? [row.custom_hostname_id] : []))) {
    if (!await deleteOwnHostname(saas, id)) kept.add(id);
  }
  if (kept.size) log('warn', { code: 'LINK_HOST_DELETE_FAILED', count: kept.size });
  const gone = rows.filter(row => !row.custom_hostname_id || !kept.has(row.custom_hostname_id));
  if (gone.length) await runtime.db.execute(sql`DELETE FROM link_hosts h USING jsonb_to_recordset(${JSON.stringify(gone.map(row => ({ w: row.workspace_id, d: row.domain })))}::jsonb) x(w text, d text)
    WHERE h.workspace_id=x.w AND h.domain=x.d AND NOT EXISTS (SELECT 1 FROM operation_domains d WHERE d.workspace_id=h.workspace_id AND d.name=h.domain) AND NOT ${retained(sql`h`)}`);
  return { selected: rows.length, deleted: gone.length };
}
/**
 * A deleted domain's link host. An active one retires: it goes on answering the links in mail the domain already sent for
 * LINK_RETENTION_DAYS, and cleanUpLinkHosts removes it after. One that never became active (no mail linked on it) goes
 * now: its row, and its custom hostname unless another row still uses it. Best effort.
 */
export async function forgetLinkHost(runtime: Runtime, workspaceId: string, domain: string) {
  const { rowCount: retired } = await runtime.db.execute(sql`UPDATE link_hosts SET status='retired', retired_at=now(), detail=NULL WHERE workspace_id=${workspaceId} AND domain=${domain} AND status='active'`);
  if (retired) return;
  const { rows: [row] } = await runtime.db.execute<{ custom_hostname_id: string | null; shared: boolean }>(sql`DELETE FROM link_hosts h WHERE workspace_id=${workspaceId} AND domain=${domain} AND status<>'retired'
    RETURNING custom_hostname_id, EXISTS (SELECT 1 FROM link_hosts o WHERE o.custom_hostname_id=h.custom_hostname_id AND NOT (o.workspace_id=h.workspace_id AND o.domain=h.domain)) AS shared`);
  const saas = runtime.config.linkHosts;
  if (!saas || !row?.custom_hostname_id || row.shared) return;
  if (!await deleteOwnHostname(saas, row.custom_hostname_id)) log('warn', { code: 'LINK_HOST_DELETE_FAILED', workspaceId });
}
/** Deletes a custom hostname of this installation's (only ids its link_hosts rows recorded reach here: NotOurs). True when
 *  it is gone; false when Cloudflare didn't answer. */
async function deleteOwnHostname(saas: Saas, id: string) {
  try {
    const done = await customHostnames(saas, 'DELETE', `/${encodeURIComponent(id)}`);
    return done.success || done.status === 404;
  } catch { return false; }
}
