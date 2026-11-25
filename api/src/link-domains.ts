import { sql } from 'drizzle-orm';
import { ApiError, log, type Config, type DbExecutor, type Runtime } from './core.js';
import { LINK_LABEL } from './link-hosts.js';
import { cname, fqdn } from './public-dns.js';

/**
 * Where the links Nightmail puts in customer mail live: the unsubscribe link (footer, text part and List-Unsubscribe),
 * forwarding's confirm and stop links, and linked images. Never on the installation's own domain, which a blocklist
 * would then list for every customer's mail at once. In order:
 *  1. the sender's own link host, links.<domain>, once its check finds it served (a Cloudflare for SaaS custom hostname
 *     on the link domain's zone: checkLinkHost);
 *  2. the shared link domain, NIGHTMAIL_LINK_DOMAIN;
 *  3. a self-hosted installation's own origin, PUBLIC_URL, which is the operator's domain.
 * Hosted with neither of the first two refuses mail that needs a link (linkDomainRequired), and never falls back to its own.
 */
export const linkHostName = (domain: string) => `${LINK_LABEL}.${domain}`;
const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase().replace(/\.$/, '');

/** The origin of the links in mail that has no link host of its own: the shared link domain, else a self-hosted
 *  installation's own origin. Null on Hosted without a link domain. */
export function sharedLinkOrigin(config: Config): string | null {
  if (config.links) return `https://${config.links.domain}`;
  return config.multiTenant ? null : config.publicUrl.replace(/\/$/, '');
}
export function linkDomainRequired(config: Config, domain: string, field = 'from') {
  return new ApiError(409, 'LINK_DOMAIN_REQUIRED', config.links?.saas
    ? `Mail from ${domain} needs a link host for its unsubscribe link. Publish the Link domain record (${linkHostName(domain)}) on the domain's page and check it.`
    : 'Campaign and marketing mail carries an unsubscribe link, and this installation has no link domain for it yet, so it can\u2019t send that mail.', field);
}

/** The verified link host of the sender's domain (or of a domain it is under), if any. */
async function ownLinkHost(runtime: Runtime, db: DbExecutor, workspaceId: string, domain: string) {
  if (!runtime.config.links?.saas) return null;
  const { rows: [row] } = await db.execute<{ hostname: string }>(sql`SELECT hostname FROM link_hosts WHERE workspace_id=${workspaceId} AND status='active'
    AND (domain=${domain} OR right(${domain},length(domain)+1)='.'||domain) ORDER BY length(domain) DESC LIMIT 1`);
  return row?.hostname ?? null;
}
/** The origin of the links in mail from `from` (an address or a domain), or LINK_DOMAIN_REQUIRED. */
export async function linkOrigin(runtime: Runtime, db: DbExecutor, workspaceId: string, from: string, field?: string): Promise<string> {
  const domain = domainOf(from), own = await ownLinkHost(runtime, db, workspaceId, domain);
  const origin = own ? `https://${own}` : sharedLinkOrigin(runtime.config);
  if (!origin) throw linkDomainRequired(runtime.config, domain, field);
  return origin;
}
/** linkOrigin for several messages: one lookup per sender domain. */
export function linkOrigins(runtime: Runtime, db: DbExecutor, workspaceId: string) {
  const known = new Map<string, Promise<string>>();
  return (from: string, field?: string) => {
    const domain = domainOf(from);
    let origin = known.get(domain);
    if (!origin) { origin = linkOrigin(runtime, db, workspaceId, domain, field); known.set(domain, origin); }
    return origin;
  };
}

// ----- Customers' link hosts: Cloudflare for SaaS custom hostnames ---------------------------------------------------

type Saas = NonNullable<NonNullable<Config['links']>['saas']>;
type CustomHostname = { id: string; status?: string; ssl?: { status?: string; validation_errors?: { message?: string }[] } | null; verification_errors?: string[] };
class CloudflareUnavailable extends Error {}
/** One call to the zone's custom hostnames API (https://developers.cloudflare.com/api/resources/custom_hostnames/). */
async function customHostnames(saas: Saas, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/zones/${saas.zoneId}/custom_hostnames${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${saas.token}`, ...body ? { 'content-type': 'application/json' } : {} }, ...body ? { body: JSON.stringify(body) } : {} });
  } catch { throw new CloudflareUnavailable(); }
  const json = await response.json().catch(() => null) as { success?: boolean; result?: unknown; errors?: { code?: number }[] } | null;
  if (response.status >= 500 || response.status === 429 || !json) throw new CloudflareUnavailable();
  return { status: response.status, success: json.success === true, result: json.result, codes: (json.errors ?? []).map(error => error.code) };
}
/** The custom hostname for `hostname`, created with an HTTP-validated certificate if the zone has none yet. */
async function ensureCustomHostname(saas: Saas, hostname: string): Promise<CustomHostname> {
  const created = await customHostnames(saas, 'POST', '', { hostname, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } });
  if (created.success) return created.result as CustomHostname;
  // 1406: the zone already has it (an earlier check, or another workspace of a self-hosted installation with the domain).
  if (created.codes.includes(1406)) {
    const found = await customHostnames(saas, 'GET', `?hostname=${encodeURIComponent(hostname)}`);
    const [existing] = found.success && Array.isArray(found.result) ? found.result as CustomHostname[] : [];
    if (existing) return existing;
  }
  throw new CloudflareUnavailable();
}
const served = (custom: CustomHostname) => custom.status === 'active' && custom.ssl?.status === 'active';
function waiting(custom: CustomHostname) {
  const error = custom.ssl?.validation_errors?.[0]?.message ?? custom.verification_errors?.[0];
  return (error ? `Cloudflare: ${error}` : 'The certificate is being issued, usually within a few minutes. Check again shortly.').slice(0, 500);
}

/**
 * The check of a domain's link host, run with the domain's own (verifyDomain). Public DNS must show links.<domain> as a
 * CNAME to edge.<link domain>; then the zone gets a custom hostname for it, which is active once Cloudflare has validated
 * it and issued its certificate. Only a domain verified for sending gets one (`sending`): a domain this workspace
 * hasn't proven is never put on the zone. A host Cloudflare already serves stays active when public DNS hides its CNAME
 * (a record proxied by the customer's own Cloudflare zone). Never throws: an unanswered lookup keeps the last status.
 */
export async function checkLinkHost(runtime: Runtime, workspaceId: string, domain: string, sending: boolean) {
  const saas = runtime.config.links?.saas;
  if (!saas) return;
  const hostname = linkHostName(domain);
  const { rows: [row] } = await runtime.db.execute<{ custom_hostname_id: string | null; status: 'pending' | 'active' }>(sql`SELECT custom_hostname_id, status FROM link_hosts WHERE workspace_id=${workspaceId} AND domain=${domain}`);
  let id = row?.custom_hostname_id ?? null, status = row?.status ?? 'pending', detail: string;
  let target: string | null | undefined;
  try { target = await cname(hostname, AbortSignal.timeout(5000)); } catch { target = undefined; }
  const pointed = !!target && fqdn(target) === saas.target;
  try {
    if (!sending) { status = 'pending'; detail = 'Verify the domain for sending first; its link host is checked after that.'; }
    else if (pointed || id) {
      let custom: CustomHostname | null = null;
      if (id) { const read = await customHostnames(saas, 'GET', `/${encodeURIComponent(id)}`); custom = read.success ? read.result as CustomHostname : null; if (!custom && read.status !== 404) throw new CloudflareUnavailable(); }
      if (!custom && pointed) custom = await ensureCustomHostname(saas, hostname);
      id = custom?.id ?? null;
      status = custom && served(custom) ? 'active' : 'pending';
      detail = status === 'active' ? `Links in campaign and marketing mail from ${domain} use ${hostname}.`
        : custom ? waiting(custom) : unpointed(saas, hostname, target);
    } else { status = 'pending'; detail = unpointed(saas, hostname, target); }
  } catch (error) {
    if (!(error instanceof CloudflareUnavailable)) throw error;
    log('warn', { code: 'LINK_HOST_CHECK_UNAVAILABLE', workspaceId });
    detail = 'Cloudflare didn\u2019t answer. Check again in a minute.';
  }
  await runtime.db.execute(sql`INSERT INTO link_hosts(workspace_id, domain, hostname, custom_hostname_id, status, detail, verified_at)
    VALUES(${workspaceId}, ${domain}, ${hostname}, ${id}, ${status}, ${detail}, CASE WHEN ${status}='active' THEN now() END)
    ON CONFLICT (workspace_id, domain) DO UPDATE SET custom_hostname_id=excluded.custom_hostname_id, status=excluded.status, detail=excluded.detail, checked_at=now(),
      verified_at=CASE WHEN excluded.status='active' THEN coalesce(link_hosts.verified_at, now()) END`);
}
function unpointed(saas: Saas, hostname: string, target: string | null | undefined) {
  if (target === undefined) return 'Public DNS didn\u2019t answer. Check again in a minute.';
  return target ? `${hostname} is a CNAME to ${fqdn(target)}. Point it at ${saas.target}.` : `Public DNS has no CNAME at ${hostname}. If the domain's DNS is on Cloudflare, set the record to DNS only.`;
}

type Readable = { name: string; dns: { name: string; type: 'CNAME' | 'TXT' | 'MX'; value: string; purpose: string; status: 'pending' | 'verified'; note?: string }[] };
/** Each domain's link host record, last in its records: optional, so never part of whether the domain is ready. */
export async function withLinkRecords<T extends Readable>(runtime: Runtime, workspaceId: string, reports: T[]): Promise<T[]> {
  const saas = runtime.config.links?.saas;
  if (!saas || !reports.length) return reports;
  const { rows } = await runtime.db.execute<{ domain: string; status: 'pending' | 'active'; detail: string | null }>(sql`SELECT domain, status, detail FROM link_hosts WHERE workspace_id=${workspaceId} AND domain=ANY(${sql.param(reports.map(report => report.name))}::text[])`);
  const found = new Map(rows.map(row => [row.domain, row]));
  for (const report of reports) {
    const row = found.get(report.name);
    report.dns.push({ name: linkHostName(report.name), type: 'CNAME', value: saas.target, purpose: 'links', status: row?.status === 'active' ? 'verified' : 'pending',
      note: row?.detail ?? `Optional. Campaign and marketing mail from ${report.name} then links its unsubscribe page through ${linkHostName(report.name)}, on your own domain.` });
  }
  return reports;
}

/** A deleted domain's link host: its row, and its custom hostname unless another workspace's row still uses it. Best effort. */
export async function forgetLinkHost(runtime: Runtime, workspaceId: string, domain: string) {
  const { rows: [row] } = await runtime.db.execute<{ custom_hostname_id: string | null; shared: boolean }>(sql`DELETE FROM link_hosts h WHERE workspace_id=${workspaceId} AND domain=${domain}
    RETURNING custom_hostname_id, EXISTS (SELECT 1 FROM link_hosts o WHERE o.custom_hostname_id=h.custom_hostname_id AND NOT (o.workspace_id=h.workspace_id AND o.domain=h.domain)) AS shared`);
  const saas = runtime.config.links?.saas;
  if (!saas || !row?.custom_hostname_id || row.shared) return;
  try { await customHostnames(saas, 'DELETE', `/${encodeURIComponent(row.custom_hostname_id)}`); }
  catch { log('warn', { code: 'LINK_HOST_DELETE_FAILED', workspaceId }); }
}
