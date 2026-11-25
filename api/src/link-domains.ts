import { sql } from 'drizzle-orm';
import { ApiError, log, type Config, type DbExecutor, type Runtime } from './core.js';
import { builtinRefusal, isBuiltinHost } from './builtin-domain.js';
import { LINK_LABEL } from './link-hosts.js';
import { cname, fqdn } from './public-dns.js';

/**
 * Where the links Nightmail puts in customer mail live: the unsubscribe link (footer, text part and List-Unsubscribe),
 * forwarding's confirm and stop links, and linked images. Never on this installation's own domain, which a blocklist
 * would then list for every customer's mail at once.
 *
 * Each sending domain has its own link host, links.<domain>: a standard record of the domain's setup, a CNAME to the
 * installation's target (config.linkHosts.target, edge.nightmail.dev on Hosted), which is a name in its Cloudflare for
 * SaaS zone. Once public DNS shows the CNAME, the domain's check makes it a custom hostname of that zone (checkLinkHost),
 * and once Cloudflare has issued its certificate, the host is active: mail from the domain links there, served by the
 * Worker on the customer's own name. Hosted refuses campaign and marketing mail from a domain whose link host isn't
 * active (LINK_RECORD_REQUIRED); a self-hosted installation links on its own origin, PUBLIC_URL, instead.
 */
export const linkHostName = (domain: string) => `${LINK_LABEL}.${domain}`;
export const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase().replace(/\.$/, '');

/** What the link is for: a campaign (and its test), a `kind: marketing` send, or a forward. */
export type LinkPurpose = 'campaign' | 'marketing' | 'forward';
/** Mail from a built-in domain that needs a link host: refused as the built-in domain's own rules refuse it. */
export function builtinLinkRefusal(config: Config, host: string, purpose: LinkPurpose) {
  return purpose === 'forward'
    ? new ApiError(422, 'BUILTIN_DOMAIN_UNSUPPORTED', 'The built-in domain has no link host for the stop link every forwarded message carries, so it can\u2019t forward. Verify a domain of your own for that.', 'from')
    : builtinRefusal(config, { code: 'BUILTIN_DOMAIN_UNSUPPORTED', field: purpose === 'marketing' ? 'kind' : 'campaign', host });
}
export function linkRecordRequired(config: Config, domain: string, field = 'from') {
  return new ApiError(409, 'LINK_RECORD_REQUIRED', config.linkHosts
    ? `Campaign and marketing mail from ${domain} needs the domain's link record, which carries its unsubscribe link: add a CNAME at ${linkHostName(domain)} pointing to ${config.linkHosts.target}, then check the domain.`
    : 'Campaign and marketing mail carries an unsubscribe link on the sending domain\u2019s link host, and this installation has none set up, so it can\u2019t send that mail yet.', field);
}

/** The origin of the links in mail from `from` (an address or a domain): the active link host of its domain (or of the
 *  workspace's domain it is under), else PUBLIC_URL when self-hosted. Hosted without one: LINK_RECORD_REQUIRED. */
export async function linkOrigin(runtime: Runtime, db: DbExecutor, workspaceId: string, from: string, purpose: LinkPurpose = 'campaign'): Promise<string> {
  const sender = domainOf(from), config = runtime.config;
  // A built-in domain has no DNS of its own to publish a link record in.
  if (isBuiltinHost(config, sender)) throw builtinLinkRefusal(config, sender, purpose);
  // Self-hosted without link hosts links on its own origin, with nothing to look up. Hosted always looks: only a check
  // with link hosts on makes an active one, so without them it refuses.
  if (!config.multiTenant && !config.linkHosts) return config.publicUrl.replace(/\/$/, '');
  // The workspace's domains the sender is, or is under (its link hosts', and its domains' that have none yet), longest first.
  const { rows } = await db.execute<{ name: string; hostname: string | null }>(sql`SELECT d.name, h.hostname
    FROM (SELECT domain AS name FROM link_hosts WHERE workspace_id=${workspaceId} UNION SELECT name FROM operation_domains WHERE workspace_id=${workspaceId}) d
    LEFT JOIN link_hosts h ON h.workspace_id=${workspaceId} AND h.domain=d.name AND h.status='active'
    WHERE d.name=${sender} OR right(${sender},length(d.name)+1)='.'||d.name ORDER BY length(d.name) DESC`);
  const active = rows.find(row => row.hostname);
  if (active) return `https://${active.hostname}`;
  if (config.multiTenant) throw linkRecordRequired(config, rows[0]?.name ?? sender);
  return config.publicUrl.replace(/\/$/, '');
}
/** linkOrigin for several marketing messages: one lookup per sender domain. */
export function linkOrigins(runtime: Runtime, db: DbExecutor, workspaceId: string) {
  const known = new Map<string, Promise<string>>();
  return (from: string) => {
    const domain = domainOf(from);
    let origin = known.get(domain);
    if (!origin) { origin = linkOrigin(runtime, db, workspaceId, domain, 'marketing'); known.set(domain, origin); }
    return origin;
  };
}
/** The link origin a campaign read found with it (`found`, its active link host's or its launch's), else what is left
 *  without a lookup: refused on Hosted, the installation's own origin when self-hosted. */
export function foundLinkOrigin(config: Config, from: string, found: string | null | undefined) {
  if (found) return found;
  const sender = domainOf(from);
  if (isBuiltinHost(config, sender)) throw builtinLinkRefusal(config, sender, 'campaign');
  if (config.multiTenant) throw linkRecordRequired(config, sender);
  return config.publicUrl.replace(/\/$/, '');
}

// ----- Custom hostnames (Cloudflare for SaaS) ---------------------------------------------------------------------

type Saas = NonNullable<Config['linkHosts']>;
type CustomHostname = { id: string; status?: string; ssl?: { status?: string; validation_errors?: { message?: string }[] } | null; verification_errors?: string[] };
class CloudflareUnavailable extends Error { constructor(readonly status?: number) { super('Cloudflare unavailable'); } }
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
async function ensureCustomHostname(saas: Saas, hostname: string): Promise<CustomHostname> {
  const created = await customHostnames(saas, 'POST', '', { hostname, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } });
  if (created.success) return created.result as CustomHostname;
  // 1406: the zone already has it (an earlier check, or another workspace with the domain).
  if (created.codes.includes(1406)) {
    const found = await customHostnames(saas, 'GET', `?hostname=${encodeURIComponent(hostname)}`);
    const [existing] = found.success && Array.isArray(found.result) ? found.result as CustomHostname[] : [];
    if (existing) return existing;
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
  const { rows: [row] } = await runtime.db.execute<{ custom_hostname_id: string | null; status: 'pending' | 'active'; public_dns: Seen | null }>(sql`SELECT custom_hostname_id, status, public_dns FROM link_hosts WHERE workspace_id=${workspaceId} AND domain=${domain}`);
  let id = row?.custom_hostname_id ?? null, status = row?.status ?? 'pending', detail: string | null = null, seen: Seen | null = row?.public_dns ?? null;
  let target: string | null | undefined;
  try { target = await cname(hostname, AbortSignal.timeout(5000)); } catch { target = undefined; }
  if (target !== undefined) seen = target === null ? { state: 'missing', values: [], checkedAt } : fqdn(target) === saas.target ? { state: 'found', values: [], checkedAt } : { state: 'wrong_value', values: [fqdn(target)], checkedAt };
  try {
    if (seen?.state === 'found' || id) {
      let custom: CustomHostname | null = null;
      if (id) { const read = await customHostnames(saas, 'GET', `/${encodeURIComponent(id)}`); custom = read.success ? read.result as CustomHostname : null; if (!custom && read.status !== 404) throw new CloudflareUnavailable(read.status); }
      if (!custom && seen?.state === 'found') custom = await ensureCustomHostname(saas, hostname);
      id = custom?.id ?? null;
      status = custom && served(custom) ? 'active' : 'pending';
      if (custom && status !== 'active') detail = waiting(custom);
    } else status = 'pending';
  } catch (error) {
    if (!(error instanceof CloudflareUnavailable)) throw error;
    log('warn', { code: 'LINK_HOST_CHECK_UNAVAILABLE', workspaceId, status: error.status });
    detail = 'Cloudflare didn\u2019t answer. Check again in a minute.';
  }
  await runtime.db.execute(sql`INSERT INTO link_hosts(workspace_id, domain, hostname, custom_hostname_id, status, detail, public_dns, verified_at)
    VALUES(${workspaceId}, ${domain}, ${hostname}, ${id}, ${status}, ${detail}, ${seen ? JSON.stringify(seen) : null}::jsonb, CASE WHEN ${status}='active' THEN now() END)
    ON CONFLICT (workspace_id, domain) DO UPDATE SET custom_hostname_id=excluded.custom_hostname_id, status=excluded.status, detail=excluded.detail,
      public_dns=excluded.public_dns, checked_at=now(), verified_at=CASE WHEN excluded.status='active' THEN coalesce(link_hosts.verified_at, now()) END`);
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
  for (const report of reports) {
    // A built-in domain has no DNS of its own; a report that has its link record already keeps it.
    if (isBuiltinHost(runtime.config, report.name) || report.dns.some(record => record.purpose === 'links')) continue;
    const row = found.get(report.name), active = row?.status === 'active', at = report.dns.findLastIndex(record => record.purpose === 'sending') + 1;
    const record: T['dns'][number] = { name: linkHostName(report.name), type: 'CNAME', value: saas.target, purpose: 'links', status: active ? 'verified' : 'pending',
      ...active ? {} : { note: row?.detail ?? `Campaign and marketing mail from ${report.name} carries its unsubscribe link on this host, and is refused until it verifies. If the domain's DNS is on Cloudflare, set the record to DNS only.`, ...row?.public_dns ? { publicDns: row.public_dns } : {} } };
    report.dns.splice(at, 0, record);
  }
  return reports;
}

/** A deleted domain's link host: its row, and its custom hostname unless another workspace's row still uses it. Best effort. */
export async function forgetLinkHost(runtime: Runtime, workspaceId: string, domain: string) {
  const { rows: [row] } = await runtime.db.execute<{ custom_hostname_id: string | null; shared: boolean }>(sql`DELETE FROM link_hosts h WHERE workspace_id=${workspaceId} AND domain=${domain}
    RETURNING custom_hostname_id, EXISTS (SELECT 1 FROM link_hosts o WHERE o.custom_hostname_id=h.custom_hostname_id AND NOT (o.workspace_id=h.workspace_id AND o.domain=h.domain)) AS shared`);
  const saas = runtime.config.linkHosts;
  if (!saas || !row?.custom_hostname_id || row.shared) return;
  try { await customHostnames(saas, 'DELETE', `/${encodeURIComponent(row.custom_hostname_id)}`); }
  catch { log('warn', { code: 'LINK_HOST_DELETE_FAILED', workspaceId }); }
}
