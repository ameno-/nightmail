// Whether a domain can receive mail, from DNS over HTTPS (RFC 8484's JSON form, as Cloudflare and Google serve it): the
// domain level of list hygiene (src/list-hygiene.ts). One MX query, and an A/AAAA query when there is no MX. Never SMTP,
// never per address. NIGHTMAIL_HYGIENE_DNS names the resolver (off turns the check off).
export type MailDomain = { verdict: 'ok' | 'no_mail' | 'unknown'; detail: 'nxdomain' | 'null_mx' | 'no_mx' | null; mx: string[] };
type Answer = { type: number; data: string };
type DnsJson = { Status: number; Answer?: Answer[] };
const TYPE = { A: 1, MX: 15, AAAA: 28 } as const;
const NOERROR = 0, NXDOMAIN = 3;

async function query(url: string, name: string, type: keyof typeof TYPE, timeoutMs: number): Promise<DnsJson> {
  const response = await fetch(`${url}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`DNS HTTP ${response.status}`);
  return await response.json() as DnsJson;
}
/**
 * The domain's mail verdict. no_mail: NXDOMAIN, a null MX (RFC 7505: one MX of preference 0 and exchange "."), or no MX
 * and no address to fall back to (RFC 5321 5.1). unknown: the resolver failed or timed out (SERVFAIL, REFUSED): never
 * flags anyone, and is asked again later.
 */
export async function resolveMailDomain(url: string, domain: string, timeoutMs = 2_000): Promise<MailDomain> {
  try {
    const mx = await query(url, domain, 'MX', timeoutMs);
    if (mx.Status === NXDOMAIN) return { verdict: 'no_mail', detail: 'nxdomain', mx: [] };
    if (mx.Status !== NOERROR) return { verdict: 'unknown', detail: null, mx: [] };
    const records = (mx.Answer ?? []).filter(a => a.type === TYPE.MX).map(a => { const [pref, host = ''] = a.data.trim().split(/\s+/); return { pref: Number(pref), host: host.toLowerCase().replace(/\.$/, '') }; });
    if (records.length === 1 && records[0]!.pref === 0 && records[0]!.host === '') return { verdict: 'no_mail', detail: 'null_mx', mx: [] };
    const hosts = [...new Set(records.map(r => r.host).filter(Boolean))].sort();
    if (hosts.length) return { verdict: 'ok', detail: null, mx: hosts };
    for (const type of ['A', 'AAAA'] as const) {
      const address = await query(url, domain, type, timeoutMs);
      if (address.Status === NXDOMAIN) return { verdict: 'no_mail', detail: 'nxdomain', mx: [] };
      if (address.Status !== NOERROR) return { verdict: 'unknown', detail: null, mx: [] };
      if ((address.Answer ?? []).some(a => a.type === TYPE[type])) return { verdict: 'ok', detail: null, mx: [] };
    }
    return { verdict: 'no_mail', detail: 'no_mx', mx: [] };
  } catch {
    return { verdict: 'unknown', detail: null, mx: [] };
  }
}
/** Many domains, at most `concurrency` at once, stopping new lookups at the deadline (the rest stay unasked). */
export async function resolveMailDomains(url: string, domains: string[], deadline: number, concurrency = 24, timeoutMs = 2_000) {
  const out = new Map<string, MailDomain>();
  let next = 0;
  const worker = async () => {
    while (next < domains.length && Date.now() < deadline) {
      const domain = domains[next++]!;
      out.set(domain, await resolveMailDomain(url, domain, Math.max(250, Math.min(timeoutMs, deadline - Date.now()))));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, domains.length) }, worker));
  return out;
}
