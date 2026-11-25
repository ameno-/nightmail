import { cname, dns, fqdn } from './public-dns.js';
import { placementRoot } from './domain-registry.js';

// What public DNS shows for each record a domain still waits for, so Check now can say which one is missing or
// different, not just that SES hasn't verified yet. SES reports DKIM for the three CNAMEs together; this reads each.
// Cloudflare's resolver (1.1.1.1) over HTTPS, one bounded lookup per record, answers kept for 30 seconds per isolate so
// pressing Check now again and again costs nothing. A record DNS didn't answer for gets publicDns null.

/** wildcard: the name has no record of this type, but a wildcard (`*.<domain>`) answers it with an address, as it answers a random name beside it. */
export type PublicDns = { state: 'found' | 'missing' | 'wrong_value'; values: string[]; checkedAt: string; wildcard?: string };
type CheckedRecord = { name: string; type: 'CNAME' | 'TXT' | 'MX'; value: string; purpose: string; status: string; publicDns?: PublicDns | null };

const TTL_MS = 30_000, MAX_ENTRIES = 500, BUDGET_MS = 3_000, MAX_VALUES = 5, MAX_VALUE_LENGTH = 255;
// Plain answers only, never a pending promise: a Worker can't await I/O another request started.
const cache = new Map<string, { at: number; values: string[] }>();

// A TXT answer is one or more quoted strings; receivers read them joined.
const txtText = (data: string) => { const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]!.replace(/\\(.)/g, '$1')); return parts.length ? parts.join('') : data; };
const mxHost = (data: string) => fqdn(data.trim().split(/\s+/).at(-1) ?? '');

async function answer(name: string, type: CheckedRecord['type'] | 'A', signal: AbortSignal) {
  const key = `${type} ${fqdn(name)}`, hit = cache.get(key), now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.values;
  const values = type === 'CNAME' ? await cname(name, signal).then(target => target ? [fqdn(target)] : [])
    : (await dns(name, type, signal)).values.map(type === 'TXT' ? txtText : data => data.trim().replace(/\.$/, '').toLowerCase());
  cache.delete(key); cache.set(key, { at: now, values });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return values;
}

function compare(record: CheckedRecord, values: string[]): Omit<PublicDns, 'checkedAt'> {
  const spf = record.type === 'TXT' && record.value.startsWith('v=spf1');
  // An SPF record that includes amazonses.com does what this one asks, whatever else it allows.
  const relevant = spf ? values.filter(v => v.toLowerCase().startsWith('v=spf1')) : values;
  const matches = (v: string) => record.type === 'TXT' ? v === record.value || (spf && /(^|\s)include:amazonses\.com(\s|$)/i.test(v)) : record.type === 'MX' ? mxHost(v) === fqdn(record.value) : fqdn(v) === fqdn(record.value);
  const shown = relevant.slice(0, MAX_VALUES).map(v => v.slice(0, MAX_VALUE_LENGTH));
  return relevant.some(matches) ? { state: 'found', values: [] } : relevant.length ? { state: 'wrong_value', values: shown } : { state: 'missing', values: [] };
}

// Where a domain's DNS is hosted, from its zone's NS records, so the dashboard and the setup reminder can say where to add
// the records and link that provider's DNS page. Only providers whose nameservers are theirs alone; any other is null.
export type DnsHost = { name: string; zone: string; url: string | null };
const PROVIDERS: [RegExp, string, ((zone: string) => string) | null][] = [
  [/\.ns\.cloudflare\.com$/, 'Cloudflare', zone => `https://dash.cloudflare.com/?to=/:account/${zone}/dns/records`],
  [/\.vercel-dns\.com$/, 'Vercel', () => 'https://vercel.com/dashboard/domains'],
  [/\.awsdns-\d+\.(?:com|net|org|co\.uk)$/, 'Route 53', () => 'https://console.aws.amazon.com/route53/v2/hostedzones'],
  [/\.domaincontrol\.com$/, 'GoDaddy', zone => `https://dcc.godaddy.com/control/portfolio/${zone}/settings?tab=dns`],
  [/\.registrar-servers\.com$/, 'Namecheap', zone => `https://ap.www.namecheap.com/Domains/DomainControlPanel/${zone}/advancedns`],
  [/\.digitalocean\.com$/, 'DigitalOcean', zone => `https://cloud.digitalocean.com/networking/domains/${zone}`],
  [/\.ui-dns\.(?:com|de|org|biz)$/, 'IONOS', null], [/\.porkbun\.com$/, 'Porkbun', null], [/\.hover\.com$/, 'Hover', null],
  [/\.gandi\.net$/, 'Gandi', null], [/\.ovh\.net$/, 'OVHcloud', null], [/\.hetzner\.(?:com|de)$/, 'Hetzner', null],
  [/\.azure-dns\.(?:com|net|org|info)$/, 'Azure DNS', null], [/\.dnsimple\.com$/, 'DNSimple', null], [/\.dreamhost\.com$/, 'DreamHost', null], [/\.name\.com$/, 'Name.com', null],
];
const HOST_TTL_MS = 30 * 60_000;
export type DnsZone = { host: DnsHost | null; noDns: boolean };
const hostCache = new Map<string, { at: number } & DnsZone>();
/**
 * The zone that answers for `name`: the NS records at the name, or at the zone its SOA names. `host`: its provider, null
 * when unknown. `noDns`, only on a definitive answer: no nameservers serve the name's own registered domain, because the
 * closest zone DNS knows is its top-level domain or public suffix (acme.co → co, acme.co.uk → co.uk), or there is none.
 * A subdomain that has no records yet (mail.acme.com under a served acme.com) has DNS. Resolver errors and timeouts throw:
 * callers treat them as unknown, never as no DNS.
 */
export async function dnsZone(name: string, signal: AbortSignal): Promise<DnsZone> {
  const key = fqdn(name), hit = hostCache.get(key);
  if (hit && Date.now() - hit.at < HOST_TTL_MS) return { host: hit.host, noDns: hit.noDns };
  let zone = key, answer = await dns(zone, 'NS', signal);
  const soa = answer.values.length ? '' : fqdn(answer.authority.find(r => r.type === 6)?.name ?? '');
  if (soa.includes('.') && key.endsWith(`.${soa}`)) { zone = soa; answer = await dns(zone, 'NS', signal); }
  const servers = answer.values.map(fqdn), found = PROVIDERS.find(([pattern]) => servers.length > 0 && servers.every(server => pattern.test(server)));
  const host = found ? { name: found[1], zone, url: found[2]?.(zone) ?? null } : null;
  // Served, but by a zone above the name's registered domain (a public suffix such as co.uk): nobody serves the domain.
  const root = servers.length && zone !== key ? await placementRoot(key).catch(() => null) : null;
  const noDns = servers.length ? !!root?.known && !!root.root && root.root !== zone && root.root.endsWith(`.${zone}`)
    : answer.status === 3 || !!soa;
  hostCache.delete(key); hostCache.set(key, { at: Date.now(), host, noDns });
  while (hostCache.size > MAX_ENTRIES) hostCache.delete(hostCache.keys().next().value!);
  return { host, noDns };
}
/** One bounded lookup when a domain is added: whether anyone serves DNS for it. Never throws; unknown is false. */
export const noDnsAt = (name: string, timeoutMs = 2_000) => dnsZone(name, AbortSignal.timeout(timeoutMs)).then(zone => zone.noDns, () => false);

const sameSet = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every(v => b.includes(v));
/**
 * A CNAME that is missing at a name which answers with an address anyway: a wildcard (`*.<domain>`) is answering for it,
 * as it does for a random name beside it (same parent, a label nobody would publish). Cloudflare's proxied `*` record is the
 * usual one. The record is still missing, and it still needs adding: any exact record wins over the wildcard.
 */
async function wildcardFor(name: string, domain: string, sibling: (parent: string) => Promise<string[]>, signal: AbortSignal) {
  const values = await answer(name, 'A', signal);
  if (!values.length) return undefined;
  return sameSet(values, await sibling(name.slice(name.indexOf('.') + 1))) ? `*.${domain}` : undefined;
}
/** Adds publicDns to every pending sending and MAIL FROM record (DMARC is a recommendation; receiving has its own MX check). */
export async function withPublicDns<T extends { name?: string; dns: CheckedRecord[] }>(report: T): Promise<T> {
  const signal = AbortSignal.timeout(BUDGET_MS), checkedAt = new Date().toISOString();
  // One random name per parent (e.g. _domainkey.<domain>), asked once however many CNAMEs share it.
  const siblings = new Map<string, Promise<string[]>>();
  const sibling = (parent: string) => { let probe = siblings.get(parent); if (!probe) siblings.set(parent, probe = answer(`nm-${crypto.randomUUID().slice(0, 12)}.${parent}`, 'A', signal)); return probe; };
  await Promise.all(report.dns.map(async record => {
    if (record.status === 'verified' || (record.purpose !== 'sending' && record.purpose !== 'mail_from')) return;
    try {
      const seen = compare(record, await answer(record.name, record.type, signal));
      const wildcard = seen.state === 'missing' && record.type === 'CNAME' ? await wildcardFor(fqdn(record.name), fqdn(report.name ?? record.name.split('.').slice(-2).join('.')), sibling, signal).catch(() => undefined) : undefined;
      record.publicDns = { ...seen, checkedAt, ...(wildcard ? { wildcard } : {}) };
    }
    catch { record.publicDns = null; }
  }));
  return report;
}
/** The wildcard answering for a domain's missing CNAMEs, if one does (withPublicDns); dns-messages.ts words it. */
export const wildcardOf = (records: { publicDns?: PublicDns | null }[]) => records.find(r => r.publicDns?.state === 'missing' && r.publicDns.wildcard)?.publicDns?.wildcard;

/**
 * A pending domain's DNS as the background check saw it (domain_claims.setup_check): each pending record's publicDns
 * and where the zone is hosted. Reads show it until the next check (src/domain-setup.ts), so no read asks DNS itself.
 */
export type SetupCheck = { checkedAt: string; host: DnsHost | null; /** Nobody serves DNS for the domain (dnsZone). */ noDns?: boolean; records: { type: string; name: string; value: string; publicDns: PublicDns | null }[] };
/** withPublicDns and dnsHost together, within the same three seconds: the report gains publicDns, the answer is what to store. */
export async function checkSetup<T extends { name: string; dns: CheckedRecord[] }>(report: T): Promise<SetupCheck> {
  // A domain with nothing left to publish needs no host either.
  const waiting = report.dns.some(r => r.status !== 'verified' && (r.purpose === 'sending' || r.purpose === 'mail_from'));
  const [, zone] = await Promise.all([withPublicDns(report), waiting ? dnsZone(report.name, AbortSignal.timeout(BUDGET_MS)).catch(() => null) : null]);
  return { checkedAt: new Date().toISOString(), host: zone?.host ?? null, ...(zone?.noDns ? { noDns: true } : {}), records: report.dns.flatMap(r => r.publicDns === undefined ? [] : [{ type: r.type, name: r.name, value: r.value, publicDns: r.publicDns }]) };
}
