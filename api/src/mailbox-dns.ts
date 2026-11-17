import type { MxReport } from './db/mailbox.js';
import { productName } from './brand.js';

// Known inbound mail hosts. Used only to name what currently receives a domain's mail.
const PROVIDERS: [RegExp, string][] = [
  [/(?:^|\.)(?:aspmx\.l\.google\.com|googlemail\.com|google\.com|smtp\.google\.com)$/, 'Google Workspace'],
  [/\.mail\.protection\.outlook\.com$/, 'Microsoft 365'],
  [/(?:^|\.)zoho(?:mail)?\.(?:com|eu|in|com\.au|jp|com\.cn)$/, 'Zoho Mail'],
  [/(?:^|\.)(?:protonmail\.ch|proton\.me)$/, 'Proton Mail'],
  [/(?:^|\.)messagingengine\.com$/, 'Fastmail'],
  [/(?:^|\.)mail\.icloud\.com$/, 'iCloud Mail'],
  [/(?:^|\.)mx\.cloudflare\.net$/, 'Cloudflare Email Routing'],
  [/(?:^|\.)mailgun\.org$/, 'Mailgun'],
  [/(?:^|\.)sendgrid\.net$/, 'SendGrid'],
  [/(?:^|\.)postmarkapp\.com$/, 'Postmark'],
  [/(?:^|\.)improvmx\.com$/, 'ImprovMX'],
  [/(?:^|\.)forwardemail\.net$/, 'Forward Email'],
  [/(?:^|\.)secureserver\.net$/, 'GoDaddy'],
  [/(?:^|\.)(?:privateemail\.com|registrar-servers\.com)$/, 'Namecheap'],
  [/(?:^|\.)mimecast\.com$/, 'Mimecast'],
  [/(?:^|\.)(?:pphosted\.com|ppe-hosted\.com)$/, 'Proofpoint'],
  [/(?:^|\.)barracudanetworks\.com$/, 'Barracuda'],
  [/(?:^|\.)yahoodns\.net$/, 'Yahoo'],
  [/(?:^|\.)migadu\.com$/, 'Migadu'],
  [/(?:^|\.)mxrouting\.net$/, 'MXroute'],
  [/^inbound-smtp\.[a-z0-9-]+\.amazonaws\.com$/, 'Amazon SES'],
];

export const inboundHost = (region: string) => `inbound-smtp.${region}.amazonaws.com`;
export const expectedMx = (domain: string, region: string): MxReport['expected'] => ({ type: 'MX', name: domain, value: inboundHost(region), priority: 10 });
const provider = (host: string) => PROVIDERS.find(([pattern]) => pattern.test(host))?.[1] ?? null;

type DohAnswer = { name: string; type: number; data: string };
// `signal` lets a caller share one time budget across several lookups; alone, each lookup gets 5 seconds.
async function resolve(name: string, type: 'MX' | 'CNAME' | 'NS', signal?: AbortSignal): Promise<{ status: number; answers: DohAnswer[] }> {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: signal ?? AbortSignal.timeout(5000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`DNS_HTTP_${response.status}`); }
  const body = await response.json() as { Status?: number; TC?: boolean; Answer?: DohAnswer[] };
  return { status: body.TC ? -1 : body.Status ?? -1, answers: (body.Answer ?? []).filter(rr=>rr.name.toLowerCase().replace(/\.$/,'')===name) };
}

/** True when `name` has NS records of its own (a delegated zone), false when it has none, null when DNS failed. */
export async function delegatedZone(name: string, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const ns = await resolve(name, 'NS', signal);
    return ns.status === 0 || ns.status === 3 ? ns.status === 0 && ns.answers.some(answer => answer.type === 2) : null;
  } catch { return null; }
}

/** Reads public MX/CNAME records over DNS-over-HTTPS and classifies who receives the domain's mail. Read-only. */
export async function checkMx(domain: string, region: string, signal?: AbortSignal): Promise<MxReport> {
  const expected = expectedMx(domain, region);
  const base = { expected, checkedAt: new Date().toISOString() };
  let mx: { status: number; answers: DohAnswer[] };
  try { mx = await resolve(domain, 'MX', signal); }
  catch { return { ...base, state: 'error', records: [], providers: [], message: 'DNS lookup failed. Retry the check.' }; }
  if (mx.status !== 0 && mx.status !== 3) return { ...base, state: 'error', records: [], providers: [], message: `DNS lookup returned status ${mx.status}. Retry the check.` };
  // DoH follows a CNAME at the name and reports it in the answer; an MX cannot coexist with it.
  const cname = mx.answers.find(answer => answer.type === 5);
  if (cname) {
    const target = cname.data.trim().replace(/\.$/, '').toLowerCase();
    return { ...base, state: 'cname', records: [], providers: [], target, message: `${domain} is a CNAME to ${target}, so it can’t also have an MX record (RFC 1034). Use a different subdomain for inbound mail.` };
  }
  const records = mx.answers.filter(answer => mx.status===0 && answer.type === 15).map(answer => {
    const [priority, host = ''] = answer.data.trim().split(/\s+/);
    const name = host.replace(/\.$/, '').toLowerCase();
    return { priority: Number(priority) || 0, host: name, provider: provider(name) };
  }).sort((a, b) => a.priority - b.priority);
  const providers = [...new Set(records.map(record => record.provider ?? record.host))];
  if (!records.length) return { ...base, state: 'missing', records, providers, message: `No MX record yet. Add ${expected.value} (priority ${expected.priority}) to start receiving.` };
  if (records.length === 1 && !records[0]!.host) return { ...base, state: 'null_mx', records, providers, message: `${domain} publishes a null MX, which tells senders it accepts no mail. Replace it with ${expected.value}.` };
  const ours = records.filter(record => record.host === expected.value);
  if (ours.length === records.length) return { ...base, state: 'active', records, providers, message: 'MX points to Amazon SES in this region. Mail is being received.' };
  const others = records.filter(record => record.host !== expected.value), named = [...new Set(others.map(record => record.provider ?? record.host))].join(', ');
  if (ours.length) {
    // Senders try the lowest preference first: the same best priority splits the mail; otherwise the better one gets it first.
    const share = mxShare({ records, expected });
    return { ...base, state: 'mixed', records, providers, ...(share === 'split' ? { split: true } : {}),
      message: share === 'split' ? `Mail is split with ${named}.` : share === 'backup' ? `Mail goes to ${named} first. Remove its MX records to finish the move.` : `${named} is the backup.` };
  }
  if (records.every(record => /^inbound-smtp\.[a-z0-9-]+\.amazonaws\.com$/.test(record.host))) return { ...base, state: 'wrong_region', records, providers, message: `MX points to Amazon SES in another region. Change it to ${expected.value}.` };
  const split = records.length > 1;
  return { ...base, state: 'conflict', records, providers, ...(split ? { split } : {}), message: `${providers.join(', ')} currently receives mail for ${domain}${split ? ` through ${records.length} MX records` : ''}. Changing the MX record moves all of its mail to ${productName}; use a subdomain to keep the existing mailboxes.` };
}

/**
 * How a mixed MX shares mail: `split` when another host has the same best priority as Amazon SES, `backup` when
 * another host's is better (a staged move: SES only gets what fails over), `primary` when SES's is better.
 */
function mxShare(report: Pick<MxReport, 'records' | 'expected'>): 'split' | 'backup' | 'primary' {
  const best = (mine: boolean) => Math.min(...report.records.filter(record => (record.host === report.expected.value) === mine).map(record => record.priority));
  const ours = best(true), theirs = best(false);
  return theirs === ours ? 'split' : theirs < ours ? 'backup' : 'primary';
}

export const mxBlocksEnable = (report: MxReport) => ['conflict', 'mixed', 'wrong_region', 'null_mx', 'cname'].includes(report.state);
