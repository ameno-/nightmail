import { createHmac, hkdfSync } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ipNetwork } from './audit.js';
import { clientIpHeader, clientNetworkHeader } from './brand.js';
import { log, type Runtime } from './core.js';
import { placementRoot } from './domain-registry.js';

// Abuse and fraud monitoring for hosted installations: collectors that note small facts ("signals") about users,
// workspaces and refused sign-ins, and an hourly job that samples sent mail and links entities sharing a signal.
// Monitoring only. Nothing here runs on the send path, and nothing blocks, pauses or limits anyone: a collector that
// fails is logged and forgotten. Self-hosted installations collect nothing.
//
// What a signal's value is: a keyed one-way hash for anything that could identify a person (an address, a network, a
// browser, a card, a recipient) or reveal content (a fingerprint of the wording); the value itself only when it names
// no person (a domain, an ASN, a country, a flag). No raw IP, address, user agent, card detail or message text is stored.

type Hosted = Pick<Runtime, 'db' | 'config'>;
export type Entity = { type: 'user' | 'workspace' | 'attempt'; id: string };
export type Signal = { kind: string; value: string; detail?: Record<string, string | number | boolean> };
/** The client as the entry point saw it (clientIpHeader, clientNetworkHeader) and its browser. */
export type RequestNetwork = { ip: string | null; userAgent: string | null; asn: string | null; country: string | null };

// How long a signal is kept after it was last seen, by kind: networks and browsers go stale fast; fingerprints of
// sent mail follow the sent-mail records (30 days); the rest covers patterns that repeat by the month.
const SHORT = ['net', 'asn', 'ua'], MAIL = ['content', 'link', 'rcpt'];
export const abuseExpired = sql`last_at < now() - interval '30 days' AND last_at < now() - CASE WHEN kind = ANY(${sql.param(SHORT)}::text[]) THEN interval '90 days'
  WHEN kind = ANY(${sql.param(MAIL)}::text[]) THEN interval '30 days' ELSE interval '1 year' END`;
// Values two entities can share. A value held by more than LINK_MOST entities is common infrastructure and links nobody.
const LINK_KINDS = ['email', 'provider', 'email_domain', 'mx', 'net', 'ua', 'card', 'send_domain', 'content', 'link', 'rcpt'];
const LINK_MOST = 25;

const keys = new Map<string, Buffer>();
/** A keyed one-way hash (HMAC-SHA-256 under a key derived from the root secret, 128 bits). Rotating the secret changes it. */
export function signalHash(config: Pick<Runtime['config'], 'authSecret'>, kind: string, value: string) {
  const key = keys.get(config.authSecret) ?? Buffer.from(hkdfSync('sha256', config.authSecret, 'nightmail:abuse:v1', 'signals', 32));
  keys.set(config.authSecret, key);
  return createHmac('sha256', key).update(`${kind}\n${value}`).digest('hex').slice(0, 32);
}

// ----- Addresses ---------------------------------------------------------------------------------------------------------
const GOOGLE_MAIL = new Set(['gmail.com', 'googlemail.com']);
// Mailbox providers anyone can sign up with: sharing one of these domains says nothing about two accounts.
const PUBLIC_MAILBOXES = new Set(`gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com rocketmail.com icloud.com me.com mac.com
  aol.com proton.me protonmail.com pm.me gmx.com gmx.net gmx.de web.de mail.com zoho.com zohomail.com yandex.com yandex.ru mail.ru qq.com 163.com 126.com sina.com
  fastmail.com fastmail.fm hey.com tutanota.com tuta.io tuta.com tutamail.com duck.com hotmail.co.uk hotmail.fr hotmail.de hotmail.it hotmail.es outlook.fr outlook.de
  outlook.es outlook.it live.co.uk live.fr yahoo.co.uk yahoo.fr yahoo.de yahoo.es yahoo.it yahoo.co.jp yahoo.co.in yahoo.com.br yahoo.ca comcast.net verizon.net
  att.net sbcglobal.net cox.net orange.fr free.fr laposte.net t-online.de libero.it naver.com daum.net seznam.cz wp.pl o2.pl btinternet.com sky.com`.split(/\s+/));
// A starting list of disposable-address services; the MX root (below) catches the many domains that front for them.
const DISPOSABLE = new Set(`mailinator.com guerrillamail.com guerrillamail.net guerrillamail.org guerrillamail.biz guerrillamailblock.com sharklasers.com grr.la
  pokemail.net spam4.me 10minutemail.com 10minutemail.net 10minemail.com tempmail.com temp-mail.org temp-mail.io tempmail.net tempmail.dev tempmailo.com tempail.com
  tempr.email tmpmail.org tmpmail.net tmpeml.com yopmail.com yopmail.fr yopmail.net trashmail.com trashmail.net trashmail.de trash-mail.com getnada.com nada.email
  dispostable.com maildrop.cc throwawaymail.com fakeinbox.com fakemail.net mohmal.com emailondeck.com mintemail.com mytemp.email burnermail.io spamgourmet.com
  mailnesia.com mailcatch.com inboxkitten.com moakt.com 1secmail.com 1secmail.org 1secmail.net discard.email discardmail.com mailsac.com harakirimail.com
  getairmail.com mailpoof.com emailfake.com email-fake.com generator.email luxusmail.org minuteinbox.com tempinbox.com temp-inbox.com inboxbear.com mail.tm mail.gw
  dropmail.me mailnull.com spambox.us jetable.org mailexpire.com byom.de anonbox.net`.split(/\s+/));
// MX roots so common that sharing one says nothing.
const COMMON_MX = new Set(`google.com googlemail.com outlook.com office365.us icloud.com apple.com zoho.com zoho.eu zohomail.com protonmail.ch proton.me
  messagingengine.com fastmail.com yahoodns.net amazonaws.com cloudflare.net improvmx.com forwardemail.net mailgun.org sendgrid.net secureserver.net ovh.net gandi.net
  yandex.net yandex.ru mail.ru mimecast.com pphosted.com ppe-hosted.com barracudanetworks.com mxroute.com migadu.com mailbox.org ionos.com ionos.de kundenserver.de
  1and1.com namecheap.com privateemail.com registrar-servers.com hostinger.com titan.email rackspace.com emailsrvr.com qq.com 163.com aliyun.com`.split(/\s+/));

/**
 * An address as its mailbox reads it: lowercased, a plus tag dropped, and for Gmail the dots dropped and googlemail
 * folded to gmail. `alias`: the address carried a plus tag.
 */
export function normalizeEmail(address: string) {
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return null;
  let local = address.slice(0, at).normalize('NFKC').toLowerCase(), domain = address.slice(at + 1).toLowerCase().replace(/\.$/, '');
  const plus = local.indexOf('+'), alias = plus > 0;
  if (alias) local = local.slice(0, plus);
  if (GOOGLE_MAIL.has(domain)) { local = local.replaceAll('.', ''); domain = 'gmail.com'; }
  return { normal: `${local}@${domain}`, domain, alias, disposable: DISPOSABLE.has(domain), publicMailbox: PUBLIC_MAILBOXES.has(domain) };
}

// ----- Requests ----------------------------------------------------------------------------------------------------------
/** Who is asking, from the headers the entry point set (server.ts, worker.ts). */
export function requestNetwork(headers: Headers): RequestNetwork {
  const [asn = '', country = ''] = (headers.get(clientNetworkHeader) ?? '').split(';');
  return { ip: headers.get(clientIpHeader), userAgent: headers.get('user-agent'), asn: /^AS\d{1,10}$/.test(asn) ? asn : null, country: /^[A-Z]{2}$/.test(country) ? country : null };
}
function networkSignals(config: Runtime['config'], network: RequestNetwork | null | undefined): Signal[] {
  if (!network) return [];
  const out: Signal[] = [], net = ipNetwork(network.ip);
  if (net) out.push({ kind: 'net', value: signalHash(config, 'net', net) });
  if (network.asn) out.push({ kind: 'asn', value: network.asn, ...(network.country ? { detail: { country: network.country } } : {}) });
  if (network.userAgent) out.push({ kind: 'ua', value: signalHash(config, 'ua', network.userAgent.slice(0, 1000)) });
  return out;
}

// ----- The store ---------------------------------------------------------------------------------------------------------
/**
 * Notes signals for one entity: a new row, or one more sighting of a row it has. In its own transaction (a savepoint
 * inside a caller's), so a failure here never touches the caller's work. `count: false` only refreshes last seen.
 */
export async function recordSignals(runtime: Hosted, entity: Entity, signals: Signal[], count = true) {
  const rows = [...new Map(signals.filter(s => s.value && s.value.length <= 255).map(s => [`${s.kind}\n${s.value}`, s])).values()];
  if (!rows.length) return;
  await runtime.db.transaction(tx => tx.execute(sql`INSERT INTO abuse_signals(entity_type,entity_id,kind,value,detail)
    SELECT ${entity.type},${entity.id},r.kind,r.value,r.detail FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(kind text,value text,detail jsonb)
    ON CONFLICT (entity_type,entity_id,kind,value) DO UPDATE SET seen=abuse_signals.seen+${count ? 1 : 0},last_at=now(),detail=coalesce(abuse_signals.detail,'{}')||coalesce(excluded.detail,'{}')`));
}
/** Runs a collector for a hosted installation; whatever it throws is logged by code and dropped. */
async function collect(runtime: Hosted, collector: string, work: () => Promise<void>) {
  if (!runtime.config.multiTenant) return;
  try { await work(); } catch { log('warn', { code: 'ABUSE_COLLECT_FAILED', collector }); }
}

// ----- Collectors --------------------------------------------------------------------------------------------------------
const attemptId = (config: Runtime['config'], issuer: string, subject: string) => `att_${signalHash(config, 'attempt', `${issuer}\n${subject}`)}`;
export type SignInObserved = {
  issuer: string; subject: string;
  /** The user this sign-in is, or null when it was refused before one existed. `created`: this sign-in made the user. */
  userId: string | null; created: boolean; outcome: string;
  /** The address the issuer verified, or null. */
  email: string | null;
  provider: { provider: string; sub: string } | null;
  network?: RequestNetwork | null;
};
/** A verified sign-in, admitted or refused: its address, the account behind it, where it came from and how it ended. */
export const observeSignIn = (runtime: Hosted, o: SignInObserved) => collect(runtime, 'signIn', async () => {
  const { config } = runtime, signals = networkSignals(config, o.network), attempt: Entity = { type: 'attempt', id: attemptId(config, o.issuer, o.subject) };
  const email = o.email ? normalizeEmail(o.email) : null;
  if (email) {
    signals.push({ kind: 'email', value: signalHash(config, 'email', email.normal) });
    if (!email.publicMailbox) signals.push({ kind: 'email_domain', value: email.domain, detail: { class: email.disposable ? 'disposable' : 'custom' } });
    if (email.disposable) signals.push({ kind: 'flag', value: 'disposable_email' });
    if (email.alias) signals.push({ kind: 'flag', value: 'plus_alias' });
  }
  if (o.provider) signals.push({ kind: 'provider', value: signalHash(config, 'provider', `${o.provider.provider}\n${o.provider.sub}`) });
  if (o.outcome === 'not_approved') signals.push({ kind: 'flag', value: 'waitlisted' });
  if (!o.userId) return recordSignals(runtime, attempt, signals);
  const user: Entity = { type: 'user', id: o.userId };
  await recordSignals(runtime, user, signals);
  // What its refused attempts left behind now belongs to the user they became.
  if (o.created) await runtime.db.transaction(tx => tx.execute(sql`WITH moved AS (DELETE FROM abuse_signals WHERE entity_type='attempt' AND entity_id=${attempt.id} RETURNING *)
    INSERT INTO abuse_signals(entity_type,entity_id,kind,value,seen,detail,first_at,last_at) SELECT 'user',${user.id},kind,value,seen,detail,first_at,last_at FROM moved
    ON CONFLICT (entity_type,entity_id,kind,value) DO UPDATE SET seen=abuse_signals.seen+excluded.seen,first_at=least(abuse_signals.first_at,excluded.first_at),last_at=greatest(abuse_signals.last_at,excluded.last_at)`));
});
/** A workspace made from the dashboard: where the request came from. Its owner links it to the account. */
export const observeWorkspaceCreated = (runtime: Hosted, workspaceId: string, network: RequestNetwork) =>
  collect(runtime, 'workspace', () => recordSignals(runtime, { type: 'workspace', id: workspaceId }, networkSignals(runtime.config, network)));
/** A card Stripe read for a workspace's payment or card setup: its fingerprint (hashed) and country. */
export const observeCard = (runtime: Hosted, workspaceId: string, card: { fingerprint: string | null; country?: string | null; blocked?: boolean }) =>
  collect(runtime, 'card', () => recordSignals(runtime, { type: 'workspace', id: workspaceId }, [
    ...(card.fingerprint ? [{ kind: 'card', value: signalHash(runtime.config, 'card', card.fingerprint) }] : []),
    ...(card.country && /^[A-Z]{2}$/.test(card.country) ? [{ kind: 'card_country', value: card.country }] : []),
    ...(card.blocked ? [{ kind: 'flag', value: 'card_blocked' }] : []),
  ]));
/** A payment event that speaks to risk: a dispute, an early fraud warning, a failed payment. */
export const observeBilling = (runtime: Hosted, workspaceId: string, flag: 'dispute' | 'fraud_warning' | 'payment_failed') =>
  // A dispute or warning may be delivered more than once; a failed payment is reported once per attempt, so only it counts.
  collect(runtime, 'billing', () => recordSignals(runtime, { type: 'workspace', id: workspaceId }, [{ kind: 'flag', value: flag }], flag === 'payment_failed'));

// ----- Fingerprints of sent mail -----------------------------------------------------------------------------------------
const MAX_BODY = 64 * 1024, MAX_WORDS = 4000, MIN_WORDS = 20, HASHES = 16, BANDS = 4, MAX_LINKS = 20, MAX_RECIPIENTS = 5;
/** The text of an HTML part without its markup, style sheets, scripts and head. One pass; never a parse. */
function htmlText(html: string) {
  const lower = html.toLowerCase();
  let out = '', i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += `${html.slice(i, lt)} `;
    if (lower.startsWith('<!--', lt)) { const end = html.indexOf('-->', lt + 4); i = end < 0 ? html.length : end + 3; continue; }
    const gt = html.indexOf('>', lt);
    if (gt < 0) break;
    const block = /^<(style|script|head|title)[\s>]/.exec(lower.slice(lt, lt + 8))?.[1];
    if (block) { const close = lower.indexOf(`</${block}`, gt); i = close < 0 ? html.length : close; }
    else i = gt + 1;
  }
  return out.replace(/&[a-z0-9#]{1,10};/gi, ' ');
}
/** The words a fingerprint is made of: case, numbers, links and addresses removed, so a name or an order number changes nothing. */
export function contentWords(subject: string, html?: string | null, text?: string | null): string[] {
  const body = html ? htmlText(html.slice(0, MAX_BODY)) : (text ?? '').slice(0, MAX_BODY), words: string[] = [];
  for (const chunk of `${subject.slice(0, 1000)} ${body}`.normalize('NFKC').toLowerCase().split(/\s+/)) {
    if (chunk.length > 40 || chunk.includes('@') || chunk.includes('://')) continue;
    for (const word of chunk.replace(/\d+/g, '0').match(/[\p{L}\p{N}]+/gu) ?? []) { words.push(word); if (words.length >= MAX_WORDS) return words; }
  }
  return words;
}
const fmix = (h: number) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0; };
const SEEDS = Array.from({ length: HASHES }, (_, i) => fmix(0x9e3779b9 * (i + 1)));
/**
 * A message's content fingerprint: MinHash over its three-word shingles, in four bands, each a keyed hash. Two messages
 * whose wording mostly agrees share bands; unrelated messages share none. Null for a message too short to tell apart
 * from boilerplate. The wording can't be read back from it.
 */
export function contentFingerprint(config: Pick<Runtime['config'], 'authSecret'>, subject: string, html?: string | null, text?: string | null): string[] | null {
  const words = contentWords(subject, html, text);
  if (words.length < MIN_WORDS) return null;
  const minima = new Uint32Array(HASHES).fill(0xffffffff);
  for (let i = 0; i + 2 < words.length; i++) {
    const shingle = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    let h = 0x811c9dc5;
    for (let c = 0; c < shingle.length; c++) h = Math.imul(h ^ shingle.charCodeAt(c), 0x01000193);
    for (let k = 0; k < HASHES; k++) { const v = fmix(h ^ SEEDS[k]!); if (v < minima[k]!) minima[k] = v; }
  }
  const size = HASHES / BANDS;
  return Array.from({ length: BANDS }, (_, band) => signalHash(config, 'content', `${band}:${Array.from(minima.slice(band * size, (band + 1) * size)).join(',')}`).slice(0, 16));
}
/** The registrable domains a message links to or loads, as written in its HTML and text. */
export async function linkDomains(html?: string | null, text?: string | null): Promise<string[]> {
  const hosts = new Set<string>();
  for (const m of `${(html ?? '').slice(0, MAX_BODY)} ${(text ?? '').slice(0, MAX_BODY)}`.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]{0,252})/gi)) {
    const host = m[1]!.toLowerCase().replace(/\.+$/, '');
    if (host.includes('.') && !/^[\d.]+$/.test(host)) hosts.add(host);
    if (hosts.size >= MAX_LINKS * 4) break;
  }
  const roots = new Set<string>();
  for (const host of hosts) { roots.add((await placementRoot(host)).root ?? host); if (roots.size >= MAX_LINKS) break; }
  return [...roots];
}

// ----- The hourly job ----------------------------------------------------------------------------------------------------
const SAMPLE_WORKSPACES = 200, SAMPLE_MESSAGES = 6, CONTENT_ROWS_MOST = 2000;
/**
 * Fingerprints a bounded sample of the mail Hosted-sending workspaces sent since they were last sampled: content bands,
 * link domains and hashed recipients. It reads rows the send path already wrote and adds nothing to that path.
 */
export async function sampleSends(runtime: Hosted, deadline: number) {
  const { rows: workspaces } = await runtime.db.execute<{ id: string; since: string }>(sql`SELECT pc.workspace_id AS id,
      greatest(coalesce(s.sampled_through,'-infinity'::timestamptz),now()-interval '1 day')::text AS since
    FROM provider_connections pc LEFT JOIN abuse_sampling s ON s.workspace_id=pc.workspace_id
    WHERE pc.kind='shared' AND EXISTS (SELECT FROM sending_emails e WHERE e.workspace_id=pc.workspace_id
      AND e.created_at>greatest(coalesce(s.sampled_through,'-infinity'::timestamptz),now()-interval '1 day'))
    ORDER BY s.sampled_through NULLS FIRST LIMIT ${SAMPLE_WORKSPACES}`);
  let sampled = 0;
  for (const workspace of workspaces) {
    if (Date.now() >= deadline) break;
    const { rows: recent } = await runtime.db.execute<{ id: string; campaign_id: string | null; subject: string; at: string }>(sql`SELECT id,campaign_id,subject,created_at::text AS at
      FROM sending_emails WHERE workspace_id=${workspace.id} AND created_at>${workspace.since}::timestamptz ORDER BY created_at DESC,id DESC LIMIT 40`);
    if (!recent.length) continue;
    // One message per campaign or subject first, so a single large campaign doesn't use up the sample.
    const picked = [...new Map(recent.map(row => [row.campaign_id ?? row.subject, row])).values()].slice(0, SAMPLE_MESSAGES);
    const { rows: mail } = await runtime.db.execute<{ subject: string; html: string | null; text: string | null; recipients: string[] }>(sql`SELECT subject,left(snapshot->>'html',${MAX_BODY}) AS html,
      left(snapshot->>'text',${MAX_BODY}) AS text,to_addresses AS recipients FROM sending_emails WHERE workspace_id=${workspace.id} AND id=ANY(${sql.param(picked.map(row => row.id))}::text[])`);
    const { rows: [held] } = await runtime.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM abuse_signals WHERE entity_type='workspace' AND entity_id=${workspace.id} AND kind='content'`);
    const signals: Signal[] = [];
    for (const message of mail) {
      const bands = (held?.n ?? 0) < CONTENT_ROWS_MOST ? contentFingerprint(runtime.config, message.subject, message.html, message.text) : null;
      for (const band of bands ?? []) signals.push({ kind: 'content', value: band });
      for (const domain of await linkDomains(message.html, message.text)) signals.push({ kind: 'link', value: domain });
      for (const recipient of (Array.isArray(message.recipients) ? message.recipients : []).slice(0, MAX_RECIPIENTS)) {
        const address = typeof recipient === 'string' ? normalizeEmail(recipient) : null;
        if (address) signals.push({ kind: 'rcpt', value: signalHash(runtime.config, 'rcpt', address.normal) });
      }
    }
    await recordSignals(runtime, { type: 'workspace', id: workspace.id }, signals);
    await runtime.db.execute(sql`INSERT INTO abuse_sampling(workspace_id,sampled_through) VALUES(${workspace.id},${recent[0]!.at}::timestamptz)
      ON CONFLICT (workspace_id) DO UPDATE SET sampled_through=excluded.sampled_through,sampled_at=now()`);
    sampled++;
  }
  return sampled;
}
/** Each workspace's sending domains, as registrable roots, so a domain that moves between workspaces is remembered. Only
 *  domains without a signal from the last day are written. */
export async function collectSendingDomains(runtime: Hosted) {
  const { rows: claims } = await runtime.db.execute<{ workspace_id: string; name: string }>(sql`SELECT workspace_id,name FROM domain_claims ORDER BY workspace_id LIMIT 20000`);
  const { rows: fresh } = await runtime.db.execute<{ entity_id: string; value: string }>(sql`SELECT entity_id,value FROM abuse_signals WHERE entity_type='workspace' AND kind='send_domain' AND last_at>now()-interval '1 day'`);
  const known = new Set(fresh.map(row => `${row.entity_id}\n${row.value}`)), due = new Map<string, Signal[]>();
  for (const claim of claims) {
    const root = (await placementRoot(claim.name)).root ?? claim.name;
    if (known.has(`${claim.workspace_id}\n${root}`)) continue;
    due.set(claim.workspace_id, [...due.get(claim.workspace_id) ?? [], { kind: 'send_domain', value: root }]);
  }
  for (const [workspaceId, signals] of due) await recordSignals(runtime, { type: 'workspace', id: workspaceId }, signals, false);
  return due.size;
}
export type MxResolver = (domain: string) => Promise<string[]>;
const publicMx: MxResolver = async domain => {
  const { dns, fqdn } = await import('./public-dns.js');
  const answer = await dns(domain, 'MX', AbortSignal.timeout(5000));
  return answer.values.map(value => value.trim().split(/\s+/)).filter(parts => parts.length === 2 && parts[1] !== '.')
    .sort((a, b) => Number(a[0]) - Number(b[0])).map(parts => fqdn(parts[1]!));
};
/** Where the mail of a sign-up's own domain goes: its MX root (unless everyone's), or a flag when it takes no mail. */
export async function resolveEmailDomains(runtime: Hosted, deadline: number, resolve: MxResolver = publicMx) {
  const { rows } = await runtime.db.execute<{ value: string }>(sql`SELECT DISTINCT value FROM abuse_signals WHERE kind='email_domain' AND NOT coalesce(detail ? 'mx',false) LIMIT 50`);
  let resolved = 0;
  for (const { value: domain } of rows) {
    if (Date.now() >= deadline) break;
    let hosts: string[];
    try { hosts = await resolve(domain); } catch { continue; }
    const root = hosts[0] ? (await placementRoot(hosts[0])).root ?? hosts[0] : '';
    const signal = !root ? sql`'flag','no_mx'` : COMMON_MX.has(root) ? null : sql`'mx',${root}`;
    await runtime.db.transaction(async tx => {
      if (signal) await tx.execute(sql`INSERT INTO abuse_signals(entity_type,entity_id,kind,value) SELECT entity_type,entity_id,${signal} FROM abuse_signals WHERE kind='email_domain' AND value=${domain}
        ON CONFLICT (entity_type,entity_id,kind,value) DO UPDATE SET last_at=now()`);
      await tx.execute(sql`UPDATE abuse_signals SET detail=coalesce(detail,'{}')||jsonb_build_object('mx',${root}::text) WHERE kind='email_domain' AND value=${domain}`);
    });
    resolved++;
  }
  return resolved;
}
/**
 * Rebuilds identity_links from the signals as they are now: every value held by 2 to LINK_MOST entities links each pair
 * of them, by kind, with the number of values they share. A link whose signals are gone is deleted.
 */
export async function refreshLinks(runtime: Hosted) {
  const { rows: [row] } = await runtime.db.execute<{ links: number; removed: number }>(sql`WITH shared AS MATERIALIZED (
      SELECT kind,value FROM abuse_signals WHERE kind=ANY(${sql.param(LINK_KINDS)}::text[]) GROUP BY kind,value HAVING count(*) BETWEEN 2 AND ${LINK_MOST}),
    pairs AS MATERIALIZED (SELECT a.entity_type AS a_type,a.entity_id AS a_id,b.entity_type AS b_type,b.entity_id AS b_id,a.kind,count(*)::int AS shared,
        min(greatest(a.first_at,b.first_at)) AS first_at,max(least(a.last_at,b.last_at)) AS last_at
      FROM shared s JOIN abuse_signals a ON a.kind=s.kind AND a.value=s.value
      JOIN abuse_signals b ON b.kind=s.kind AND b.value=s.value AND (a.entity_type,a.entity_id)<(b.entity_type,b.entity_id) GROUP BY 1,2,3,4,5),
    gone AS (DELETE FROM identity_links l WHERE NOT EXISTS (SELECT FROM pairs p WHERE (p.a_type,p.a_id,p.b_type,p.b_id,p.kind)=(l.a_type,l.a_id,l.b_type,l.b_id,l.kind)) RETURNING 1),
    kept AS (INSERT INTO identity_links(a_type,a_id,b_type,b_id,kind,shared,first_at,last_at) SELECT a_type,a_id,b_type,b_id,kind,shared,first_at,last_at FROM pairs
      ON CONFLICT (a_type,a_id,b_type,b_id,kind) DO UPDATE SET shared=excluded.shared,first_at=least(identity_links.first_at,excluded.first_at),last_at=excluded.last_at
      WHERE (identity_links.shared,identity_links.last_at) IS DISTINCT FROM (excluded.shared,excluded.last_at) RETURNING 1)
    SELECT (SELECT count(*)::int FROM pairs) AS links,(SELECT count(*)::int FROM gone) AS removed`);
  return { links: row?.links ?? 0, removed: row?.removed ?? 0 };
}
/**
 * The hourly job (maintenance.ts hourlyUpkeep), hosted only: sample sent mail, note sending and sign-up domains, then
 * rebuild the links. Each step is bounded and best-effort; the next hour continues where a step stopped.
 */
export async function abuseHourly(runtime: Hosted, options: { budgetMs?: number; resolveMx?: MxResolver } = {}) {
  if (!runtime.config.multiTenant) return null;
  const deadline = Date.now() + (options.budgetMs ?? 20_000), result = { sampled: 0, domains: 0, resolved: 0, links: 0, removed: 0 };
  const step = async (name: string, work: () => Promise<void>) => { try { await work(); } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: name }); } };
  await step('sample', async () => { result.sampled = await sampleSends(runtime, deadline); });
  await step('domains', async () => { result.domains = await collectSendingDomains(runtime); });
  await step('mx', async () => { result.resolved = await resolveEmailDomains(runtime, deadline, options.resolveMx); });
  await step('links', async () => { Object.assign(result, await refreshLinks(runtime)); });
  log('info', { code: 'ABUSE_HOURLY', ...result });
  return result;
}
