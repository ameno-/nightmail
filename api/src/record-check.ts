import { cname, dns, fqdn } from './public-dns.js';

// What public DNS shows for each record a domain still waits for, so Check now can say which one is missing or
// different, not just that SES hasn't verified yet. SES reports DKIM for the three CNAMEs together; this reads each.
// Cloudflare's resolver (1.1.1.1) over HTTPS, one bounded lookup per record, answers kept for 30 seconds per isolate so
// pressing Check now again and again costs nothing. A record DNS didn't answer for gets publicDns null.

export type PublicDns = { state: 'found' | 'missing' | 'wrong_value'; values: string[]; checkedAt: string };
type CheckedRecord = { name: string; type: 'CNAME' | 'TXT' | 'MX'; value: string; purpose: string; status: string; publicDns?: PublicDns | null };

const TTL_MS = 30_000, MAX_ENTRIES = 500, BUDGET_MS = 3_000, MAX_VALUES = 5, MAX_VALUE_LENGTH = 255;
// Plain answers only, never a pending promise: a Worker can't await I/O another request started.
const cache = new Map<string, { at: number; values: string[] }>();

// A TXT answer is one or more quoted strings; receivers read them joined.
const txtText = (data: string) => { const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]!.replace(/\\(.)/g, '$1')); return parts.length ? parts.join('') : data; };
const mxHost = (data: string) => fqdn(data.trim().split(/\s+/).at(-1) ?? '');

async function answer(name: string, type: CheckedRecord['type'], signal: AbortSignal) {
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

/** Adds publicDns to every pending sending and MAIL FROM record (DMARC is a recommendation; receiving has its own MX check). */
export async function withPublicDns<T extends { dns: CheckedRecord[] }>(report: T): Promise<T> {
  const signal = AbortSignal.timeout(BUDGET_MS), checkedAt = new Date().toISOString();
  await Promise.all(report.dns.map(async record => {
    if (record.status === 'verified' || (record.purpose !== 'sending' && record.purpose !== 'mail_from')) return;
    try { record.publicDns = { ...compare(record, await answer(record.name, record.type, signal)), checkedAt }; }
    catch { record.publicDns = null; }
  }));
  return report;
}
