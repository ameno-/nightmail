import { createHmac, hkdfSync } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ipNetwork, userAgentFamily } from './audit.js';
import { clientIpHeader, clientNetworkHeader } from './brand.js';
import { isBuiltinHost } from './builtin-domain.js';
import { log, type DbExecutor, type Runtime } from './core.js';
import { placementRoot } from './domain-registry.js';
import { isKnownDisposable, PUBLIC_MAILBOXES } from './list-hygiene.js';

// Abuse and fraud monitoring for hosted installations: small facts ("signals") about users, workspaces and refused
// sign-ins, kept so that related accounts can be recognised by a person later.
//
// Monitoring only. Nothing here blocks, pauses or limits anyone, and nothing is derived from the signals yet.
// - Off unless NIGHTMAIL_ABUSE_MONITORING names an activation time that has passed. Nothing created before the
//   database first ran with that setting is ever read. Expiry runs whether it is on or off.
// - One writer. The hourly job, under a lease, is the only code that writes a signal. It reads three durable records:
//   the sign-in log (a sign-in adds what it observed, already pseudonymised, to the row it writes anyway), the
//   payment records and the sending log. No request waits on, queues for or connects to anything here, and the send
//   path runs no code and no statement of this module.
// - Erasure and exclusion hold. Every write happens in a transaction that first takes the entity's lock and then
//   checks its exclusions and its floor (the instant of its last erasure); the privacy command takes the same lock.
//   No cursor is reset by an erasure, so nothing observed before it can come back.
// - Bounded. Every statement runs with a short statement and lock timeout, in work-limited slices that continue from
//   stored cursors.
//
// A stored value is a keyed one-way hash (an address, a network, a card, a domain, a content fingerprint) or a value
// that names no person (an ASN, a country, a browser from a closed list, a flag). The service holds the key, so it can
// test a candidate value against the store; nobody without the key can.

export type Hosted = Pick<Runtime, 'db' | 'config'>;
export type Entity = { type: 'user' | 'workspace' | 'attempt'; id: string };
/** One fact. `at`: when it was true (the provider accepted the mail, the payment changed); now when absent. */
export type Signal = { kind: string; value: string; detail?: Record<string, string | number | boolean>; at?: string };
/** The client as the entry point saw it (clientIpHeader, clientNetworkHeader) and its browser. */
export type RequestNetwork = { ip: string | null; userAgent: string | null; asn: string | null; country: string | null };
/** Whether monitoring is on: a hosted installation whose configured activation time has passed. */
export const monitoring = (config: Runtime['config'], now = Date.now()) => config.multiTenant && !!config.abuseMonitoring && Date.parse(config.abuseMonitoring.since) <= now;

// Fingerprints of sent mail are kept as long as the sent-mail records (30 days); everything else 90 days after it was
// last seen. Runs whether monitoring is on or off (maintenance.ts).
const MAIL_KINDS = ['content', 'link', 'send_domain'];
export const abuseExpired = sql`last_at < now() - interval '30 days' AND (kind = ANY(${sql.param(MAIL_KINDS)}::text[]) OR last_at < now() - interval '90 days')`;
// An entity keeps at most this many values of one kind; the least recently seen leave first.
const ENTITY_KIND_MOST = 100;
const STATEMENT_MS = 2000, LOCK_MS = 500;

let derived: { secret: string; key: Buffer } | undefined;
/** A keyed one-way hash: HMAC-SHA-256 under a key derived from the root secret, 128 bits. Rotating the secret starts a
 *  new epoch: new hashes match nothing stored before, and the old rows expire. */
export function signalHash(config: Pick<Runtime['config'], 'authSecret'>, kind: string, value: string) {
  if (derived?.secret !== config.authSecret) derived = { secret: config.authSecret, key: Buffer.from(hkdfSync('sha256', config.authSecret, 'nightmail:abuse:v1', 'signals', 32)) };
  return createHmac('sha256', derived.key).update(`${kind}\n${value}`).digest('hex').slice(0, 32);
}

// ----- Addresses ---------------------------------------------------------------------------------------------------------
// Providers that document how they read an address: case never matters, a plus tag is ignored, and for Gmail dots are
// too. Anywhere else only the exact address is compared. `as`: the provider's other name for the same mailboxes.
const ALIASES: Record<string, { dots?: true; as?: string }> = { 'gmail.com': { dots: true }, 'googlemail.com': { dots: true, as: 'gmail.com' },
  'outlook.com': {}, 'hotmail.com': {}, 'live.com': {}, 'icloud.com': {}, 'proton.me': {}, 'protonmail.com': {}, 'fastmail.com': {} };
/**
 * An address as it is compared. `exact`: the address with its domain lowercased, nothing else changed. `alias`: the
 * mailbox it names at a provider that documents its equivalences (ALIASES), or null anywhere else. `tagged`: such a
 * provider ignored a plus tag in it.
 */
export function readAddress(address: string) {
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return null;
  const local = address.slice(0, at), domain = address.slice(at + 1).toLowerCase().replace(/\.$/, ''), rule = ALIASES[domain];
  let mailbox = local.toLowerCase();
  const plus = mailbox.indexOf('+'), tagged = !!rule && plus > 0;
  if (tagged) mailbox = mailbox.slice(0, plus);
  if (rule?.dots) mailbox = mailbox.replaceAll('.', '');
  return { exact: `${local}@${domain}`, alias: rule ? `${mailbox}@${rule.as ?? domain}` : null, tagged, domain, disposable: isKnownDisposable(domain), publicMailbox: PUBLIC_MAILBOXES.has(domain) };
}
const DNS_NAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
/** The registrable domain of a DNS host name under a known public suffix, or null: never an IP literal, a bare label,
 *  a name under an unknown suffix or a public suffix itself. */
export async function registrableDomain(host: string) {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (!DNS_NAME.test(name)) return null;
  const { root, known } = await placementRoot(name);
  return known ? root : null;
}

// ----- Requests ----------------------------------------------------------------------------------------------------------
/** Who is asking, from the headers the entry point set (server.ts, worker.ts). */
export function requestNetwork(headers: Headers): RequestNetwork {
  const [asn = '', country = ''] = (headers.get(clientNetworkHeader) ?? '').split(';');
  return { ip: headers.get(clientIpHeader), userAgent: headers.get('user-agent'), asn: /^AS\d{1,10}$/.test(asn) ? asn : null, country: /^[A-Z]{2}$/.test(country) ? country : null };
}
const BROWSER = /^(?:Chrome|Firefox|Safari|Edge) \d{1,3}(?: on (?:Windows|macOS|Linux|iOS|Android))?$/;
/** A browser from a closed list (four families, a major version of at most three digits, five systems), or "other":
 *  never a token copied from the user agent. */
export function browserFamily(agent: string | null | undefined) {
  const family = userAgentFamily(agent);
  return family && BROWSER.test(family) ? family : 'other';
}
/** The network as a keyed hash of its /24 (or /48), its ASN and country, and the browser from the closed list. */
function networkSignals(config: Runtime['config'], network: RequestNetwork | null | undefined): Signal[] {
  if (!network) return [];
  const out: Signal[] = [], net = ipNetwork(network.ip);
  if (net) out.push({ kind: 'net', value: signalHash(config, 'net', net) });
  if (network.asn) out.push({ kind: 'asn', value: network.asn, ...(network.country ? { detail: { country: network.country } } : {}) });
  if (network.userAgent) out.push({ kind: 'browser', value: browserFamily(network.userAgent) });
  return out;
}

// ----- The store ---------------------------------------------------------------------------------------------------------
/** A key that exclusions, floors and locks are held under: a user, a workspace, or a sign-in subject ("issuer subject",
 *  which unlike a refused sign-in's hashed entity survives a change of the root secret). */
export type Guard = { type: 'user' | 'workspace' | 'subject'; id: string };
const subjectGuard = (issuer: string, subject: string): Guard => ({ type: 'subject', id: `${issuer} ${subject}` });
/** One short transaction with the module's statement and lock timeouts: a slow or blocked statement ends, it never waits. */
export function bounded<T>(runtime: Hosted, work: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return runtime.db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('statement_timeout',${String(STATEMENT_MS)},true),set_config('lock_timeout',${String(LOCK_MS)},true)`);
    return work(tx);
  });
}
/** Takes the guards' locks for the rest of the transaction, always in the same order. Writers and the privacy command
 *  take them before they read or write anything about the entity, so neither can miss the other's change. */
async function lockGuards(tx: DbExecutor, guards: Guard[]) {
  for (const key of [...new Set(guards.map(guard => `abuse:${guard.type}:${guard.id}`))].sort()) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`);
}
const guardPairs = (guards: Guard[]) => sql.join(guards.map(guard => sql`(${guard.type},${guard.id})`), sql`, `);
/** Whether a workspace is excluded: by an exclusion of its own, or by one of a current owner's. */
export const workspaceExcluded = (workspaceId: SQL) => sql`(EXISTS (SELECT FROM abuse_exclusions x WHERE x.entity_type='workspace' AND x.entity_id=${workspaceId})
  OR EXISTS (SELECT FROM abuse_exclusions x JOIN workspace_members m ON m.user_id=x.entity_id AND m.role='owner' WHERE x.entity_type='user' AND m.workspace_id=${workspaceId}))`;
/** Whether any of these guards is excluded (a workspace also through its owners). */
const excluded = (guards: Guard[]) => sql`(EXISTS (SELECT FROM abuse_exclusions x WHERE (x.entity_type,x.entity_id) IN (${guardPairs(guards)}))${
  sql.join(guards.filter(guard => guard.type === 'workspace').map(guard => sql` OR ${workspaceExcluded(sql`${guard.id}`)}`), sql``)})`;
/** The latest erasure among these guards: nothing observed at or before it is ever recorded. */
const floorOf = (guards: Guard[]) => sql`coalesce((SELECT max(f.ignore_through) FROM abuse_floors f WHERE (f.entity_type,f.entity_id) IN (${guardPairs(guards)})),'-infinity'::timestamptz)`;
/**
 * Notes signals for one entity, inside the caller's transaction and after lockGuards: a new row, or a later sighting
 * of a row it has. Nothing is written when a guard is excluded, and nothing observed at or before a guard's floor.
 * Returns the number of new rows.
 */
async function writeSignals(tx: DbExecutor, entity: Entity, guards: Guard[], signals: Signal[], count: boolean) {
  const rows = [...new Map(signals.filter(s => s.value && s.value.length <= 255).map(s => [`${s.kind}\n${s.value}`, { kind: s.kind, value: s.value, detail: s.detail ?? null, at: s.at ?? null }])).values()];
  if (!rows.length) return 0;
  const { rows: [written] } = await tx.execute<{ added: number }>(sql`WITH incoming AS (
      SELECT r.kind,r.value,r.detail,coalesce(r.at,now()) AS at FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(kind text,value text,detail jsonb,at timestamptz)
      WHERE NOT ${excluded(guards)} AND coalesce(r.at,now())>${floorOf(guards)}),
    written AS (INSERT INTO abuse_signals(entity_type,entity_id,kind,value,detail,first_at,last_at) SELECT ${entity.type},${entity.id},kind,value,detail,at,at FROM incoming
      ON CONFLICT (entity_type,entity_id,kind,value) DO UPDATE SET seen=abuse_signals.seen+${count ? 1 : 0},last_at=greatest(abuse_signals.last_at,excluded.last_at),detail=coalesce(excluded.detail,abuse_signals.detail)
      RETURNING (xmax=0) AS fresh)
    SELECT count(*) FILTER (WHERE fresh)::int AS added FROM written`);
  return written?.added ?? 0;
}
/** Past ENTITY_KIND_MOST values of one kind, the least recently seen leave. The last statement of a write, under the
 *  entity's lock, so the limit holds whatever else is writing. */
const trimSignals = (tx: DbExecutor, entity: Entity) => tx.execute(sql`DELETE FROM abuse_signals s USING (SELECT kind,value,row_number() OVER (PARTITION BY kind ORDER BY last_at DESC,value) AS n
    FROM abuse_signals WHERE entity_type=${entity.type} AND entity_id=${entity.id}) old
  WHERE s.entity_type=${entity.type} AND s.entity_id=${entity.id} AND s.kind=old.kind AND s.value=old.value AND old.n>${ENTITY_KIND_MOST}`);

// ----- Links -------------------------------------------------------------------------------------------------------------
// Values two entities can share. A value held by more than LINK_HOLDERS_MOST entities is common infrastructure (a campus
// network, a popular link shortener) and links nobody: not when a link is written, and not later, when a value that
// was rare then has become common (src/abuse-clusters.ts reads links through this too).
export const LINK_KINDS = ['email', 'email_alias', 'email_domain', 'provider', 'net', 'card', 'send_domain', 'content', 'link'];
const LINK_HOLDERS_MOST = 25, LINK_PARTNERS_MOST = 100;
export const rare = (kind: SQL, value: SQL) => sql`(SELECT count(*) FROM (SELECT FROM abuse_signals h WHERE h.kind=${kind} AND h.value=${value} LIMIT ${LINK_HOLDERS_MOST + 1}) held)<=${LINK_HOLDERS_MOST}`;
/** A link expires with the signals it came from: its last_at is the latest moment both sides held a shared value. */
export const linkExpired = sql`last_at < now() - interval '30 days' AND (kind = ANY(${sql.param(MAIL_KINDS)}::text[]) OR last_at < now() - interval '90 days')`;
/**
 * Links one entity to the others that hold a value it was just given, inside the transaction that wrote the values:
 * at most LINK_PARTNERS_MOST other entities, each pair with the number of rare values of that kind they share now.
 * Incremental by construction: only the values just written are looked at, never the whole store.
 */
async function linkEntity(tx: DbExecutor, entity: Entity, signals: Signal[]) {
  const values = [...new Map(signals.filter(s => LINK_KINDS.includes(s.kind)).map(s => [`${s.kind}\n${s.value}`, { kind: s.kind, value: s.value }])).values()];
  if (!values.length) return;
  const mine = sql`mine.entity_type=${entity.type} AND mine.entity_id=${entity.id}`;
  await tx.execute(sql`WITH touched AS (SELECT t.kind,t.value FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS t(kind text,value text)
      WHERE EXISTS (SELECT FROM abuse_signals mine WHERE ${mine} AND mine.kind=t.kind AND mine.value=t.value) AND ${rare(sql`t.kind`, sql`t.value`)}),
    partners AS (SELECT DISTINCT o.entity_type,o.entity_id,o.kind FROM touched t JOIN abuse_signals o ON o.kind=t.kind AND o.value=t.value
      WHERE (o.entity_type,o.entity_id)<>(${entity.type},${entity.id}) LIMIT ${LINK_PARTNERS_MOST}),
    pairs AS (SELECT p.entity_type,p.entity_id,p.kind,count(*)::int AS shared,min(greatest(mine.first_at,theirs.first_at)) AS first_at,max(least(mine.last_at,theirs.last_at)) AS last_at
      FROM partners p JOIN abuse_signals mine ON ${mine} AND mine.kind=p.kind
      JOIN abuse_signals theirs ON theirs.entity_type=p.entity_type AND theirs.entity_id=p.entity_id AND theirs.kind=mine.kind AND theirs.value=mine.value
      WHERE ${rare(sql`mine.kind`, sql`mine.value`)} GROUP BY 1,2,3)
    INSERT INTO identity_links(a_type,a_id,b_type,b_id,kind,shared,first_at,last_at)
    SELECT CASE WHEN first THEN ${entity.type} ELSE entity_type END,CASE WHEN first THEN ${entity.id} ELSE entity_id END,
      CASE WHEN first THEN entity_type ELSE ${entity.type} END,CASE WHEN first THEN entity_id ELSE ${entity.id} END,kind,shared,first_at,last_at
    FROM (SELECT p.*,(${entity.type}::text,${entity.id}::text)<(p.entity_type,p.entity_id) AS first FROM pairs p) ordered
    ON CONFLICT (a_type,a_id,b_type,b_id,kind) DO UPDATE SET shared=excluded.shared,first_at=least(identity_links.first_at,excluded.first_at),
      last_at=greatest(identity_links.last_at,excluded.last_at),pending=identity_links.pending OR identity_links.shared<>excluded.shared`);
}

// ----- Sign-ins ----------------------------------------------------------------------------------------------------------
const attemptEntity = (config: Runtime['config'], issuer: string, subject: string) => `att_${signalHash(config, 'attempt', `${issuer}\n${subject}`)}`;
export type SignInObserved = {
  outcome: string;
  /** The address the issuer verified, or null. */
  email: string | null;
  provider: { provider: string; sub: string } | null;
  network?: RequestNetwork | null;
};
/**
 * What a verified sign-in shows, admitted or refused, as the sign-in log keeps it (nightmail_signin_attempts.observed):
 * its address, the account behind it and where it came from, hashed here, in the request. Null while monitoring is
 * off. Pure: it reads and writes nothing; the hourly job reads the log later.
 */
export function signInSignals(config: Runtime['config'], o: SignInObserved): Signal[] | null {
  if (!monitoring(config)) return null;
  const signals = networkSignals(config, o.network), email = o.email ? readAddress(o.email) : null;
  if (email) {
    signals.push({ kind: 'email', value: signalHash(config, 'email', email.exact) });
    if (email.alias) signals.push({ kind: 'email_alias', value: signalHash(config, 'email_alias', email.alias) });
    if (!email.publicMailbox) signals.push({ kind: 'email_domain', value: signalHash(config, 'email_domain', email.domain), detail: { class: email.disposable ? 'disposable' : 'own' } });
    if (email.disposable) signals.push({ kind: 'flag', value: 'disposable_email' });
    if (email.tagged) signals.push({ kind: 'flag', value: 'plus_alias' });
  }
  if (o.provider) signals.push({ kind: 'provider', value: signalHash(config, 'provider', `${o.provider.provider}\n${o.provider.sub}`) });
  if (o.outcome === 'not_approved') signals.push({ kind: 'flag', value: 'waitlisted' });
  return signals;
}
// What the job accepts from the sign-in log: exactly the kinds and value shapes signInSignals writes, nothing else.
const hash = z.string().regex(/^[0-9a-f]{32}$/), bare = <K extends string, V extends z.ZodType>(kind: K, value: V) => z.object({ kind: z.literal(kind), value }).strict();
const ObservedSignal = z.union([bare('email', hash), bare('email_alias', hash), bare('provider', hash), bare('net', hash),
  z.object({ kind: z.literal('email_domain'), value: hash, detail: z.object({ class: z.enum(['own', 'disposable']) }).strict() }).strict(),
  z.object({ kind: z.literal('asn'), value: z.string().regex(/^AS\d{1,10}$/), detail: z.object({ country: z.string().regex(/^[A-Z]{2}$/) }).strict().optional() }).strict(),
  bare('browser', z.string().regex(new RegExp(`${BROWSER.source}|^other$`))), bare('flag', z.enum(['disposable_email', 'plus_alias', 'waitlisted']))]);
const Observed = z.array(ObservedSignal).max(12);

// ----- Fingerprints of sent mail -----------------------------------------------------------------------------------------
const MAIL_BYTES = 64 * 1024, MAX_WORDS = 4000, MIN_WORDS = 20, HASHES = 24, BANDS = 3, LINKS_MOST = 10, LINK_CANDIDATES = 200;
/** At most `bytes` UTF-8 bytes of a string, cut at a character. */
function clip(value: string | null | undefined, bytes: number) {
  if (!value || bytes <= 0) return '';
  const buffer = Buffer.from(value);
  if (buffer.length <= bytes) return value;
  let end = bytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.toString('utf8', 0, end);
}
/** A message's HTML and text parts within one combined byte budget, HTML first. */
function mailParts(html?: string | null, text?: string | null) {
  const markup = clip(html, MAIL_BYTES);
  return { html: markup, text: clip(text, MAIL_BYTES - Buffer.byteLength(markup)) };
}
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
/** The words a fingerprint is made of: case, numbers, links and addresses removed, so an order number changes nothing. */
export function contentWords(subject: string, html?: string | null, text?: string | null): string[] {
  const parts = mailParts(html, text), body = parts.html ? htmlText(parts.html) : parts.text, words: string[] = [];
  for (const chunk of `${subject.slice(0, 1000)} ${body}`.normalize('NFKC').toLowerCase().split(/\s+/)) {
    if (chunk.length > 40 || chunk.includes('@') || chunk.includes('://')) continue;
    for (const word of chunk.replace(/\d+/g, '0').match(/[\p{L}\p{N}]+/gu) ?? []) { words.push(word); if (words.length >= MAX_WORDS) return words; }
  }
  return words;
}
const fmix = (h: number) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0; };
const SEEDS = Array.from({ length: HASHES }, (_, i) => fmix(0x9e3779b9 * (i + 1)));
/**
 * A message's content fingerprint: MinHash over its three-word shingles (the minima use fixed seeds), grouped into
 * bands, each band stored as a keyed hash. One band is evidence on its own: two messages share a band only when
 * their wording agrees almost throughout, so a shared value always describes one pair of messages. Null for a
 * message too short to tell apart from boilerplate.
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
/**
 * The registrable domains a message links to or loads: each http(s) URL is read with the URL parser, and only a DNS
 * host name under a known public suffix counts. A URL with credentials, an IP literal or a malformed name is skipped
 * whole. The caller stores them hashed; they are never logged.
 */
export async function linkDomains(html?: string | null, text?: string | null): Promise<string[]> {
  const parts = mailParts(html, text), roots = new Set<string>();
  let candidates = 0;
  for (const match of `${parts.html} ${parts.text}`.matchAll(/https?:\/\/[^\s"'<>()\\]{4,2048}/gi)) {
    if (++candidates > LINK_CANDIDATES || roots.size >= LINKS_MOST) break;
    let url: URL;
    try { url = new URL(match[0]); } catch { continue; }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) continue;
    const root = await registrableDomain(url.hostname);
    if (root) roots.add(root);
  }
  return [...roots];
}

// ----- The hourly job ----------------------------------------------------------------------------------------------------
// Work limits of one run. Each stage stops at its limit or its share of the time and continues from its cursor.
const SIGN_INS_A_RUN = 200, PAYMENTS_A_RUN = 200, WORKSPACE_PAGE = 200, WORKSPACE_PAGES = 10, SAMPLED_A_RUN = 100, MESSAGES_A_WORKSPACE = 6, NEW_ROWS_A_RUN = 5000, LEASE = sql`interval '5 minutes'`;
type Cursors = { signIns?: { at: string; key: string }; payments?: { at: string; id: string }; workspaces?: string };
type Run = { since: string; cursors: Cursors; added: number; deadline: number };
const spent = (run: Run) => Date.now() >= run.deadline || run.added >= NEW_ROWS_A_RUN;
export const utc = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Sign-ins from the sign-in log, in the order they happened: what each observed (signInSignals), dated by the sign-in,
 * on the user it is or, for a refused one, on a keyed hash of its subject. A user takes over what its refused
 * sign-ins left. Only sign-ins since monitoring started; each version of a row is read once.
 */
async function foldSignIns(runtime: Hosted, run: Run) {
  // The cursor names the last row by a digest, never by its subject, so the job's state holds nothing of a person.
  const after = run.cursors.signIns ?? { at: run.since, key: '' }, key = sql`md5(a.issuer||' '||a.subject)`;
  const { rows } = await bounded(runtime, tx => tx.execute<{ issuer: string; subject: string; observed: unknown; at: string; key: string; user_id: string | null }>(sql`SELECT a.issuer,a.subject,a.observed,${utc(sql`a.last_at`)} AS at,${key} AS key,i.user_id
    FROM nightmail_signin_attempts a LEFT JOIN nightmail_oidc_identities i ON i.issuer=a.issuer AND i.subject=a.subject
    WHERE a.observed IS NOT NULL AND (a.last_at,${key})>(${after.at}::timestamptz,${after.key}) AND a.last_at>${run.since}::timestamptz
    ORDER BY a.last_at,${key} LIMIT ${SIGN_INS_A_RUN}`));
  for (const row of rows) {
    if (spent(run)) break;
    const signals = Observed.safeParse(row.observed).data, attempt: Entity = { type: 'attempt', id: attemptEntity(runtime.config, row.issuer, row.subject) }, subject = subjectGuard(row.issuer, row.subject);
    // A row that is malformed, or whose write fails or times out, is passed over: the cursor never waits on one row.
    try {
      if (!signals) throw new Error('malformed');
      const dated = signals.map(signal => ({ ...signal, at: row.at }));
      run.added += await bounded(runtime, async tx => {
        if (!row.user_id) { await lockGuards(tx, [subject]); const added = await writeSignals(tx, attempt, [subject], dated, true); await trimSignals(tx, attempt); await linkEntity(tx, attempt, dated); return added; }
        const user: Entity = { type: 'user', id: row.user_id }, guards: Guard[] = [user as Guard, subject];
        await lockGuards(tx, guards);
        const added = await writeSignals(tx, user, guards, dated, true);
        // What this subject's refused sign-ins left now belongs to the user it became, unless excluded or erased since.
        await tx.execute(sql`WITH moved AS (DELETE FROM abuse_signals WHERE entity_type='attempt' AND entity_id=${attempt.id} RETURNING *)
          INSERT INTO abuse_signals(entity_type,entity_id,kind,value,seen,detail,first_at,last_at) SELECT 'user',${user.id},kind,value,seen,detail,first_at,last_at FROM moved
          WHERE NOT ${excluded(guards)} AND last_at>${floorOf(guards)}
          ON CONFLICT (entity_type,entity_id,kind,value) DO UPDATE SET seen=abuse_signals.seen+excluded.seen,first_at=least(abuse_signals.first_at,excluded.first_at),last_at=greatest(abuse_signals.last_at,excluded.last_at)`);
        await trimSignals(tx, user);
        // Everything the user holds now, the adopted rows included.
        await linkEntity(tx, user, (await tx.execute<Signal>(sql`SELECT kind,value FROM abuse_signals WHERE entity_type='user' AND entity_id=${user.id} AND kind=ANY(${sql.param(LINK_KINDS)}::text[])`)).rows);
        return added;
      });
    } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: 'signIn' }); }
    run.cursors.signIns = { at: row.at, key: row.key };
  }
  return rows.length;
}
/**
 * Cards from the payment records (billing_payment_attempts), in the order they last changed: each as a keyed hash on
 * its workspace, dated when the payment changed. Only payments made since monitoring started. An excluded
 * workspace's fingerprint is not read.
 */
async function foldPayments(runtime: Hosted, run: Run) {
  const after = run.cursors.payments ?? { at: run.since, id: '' };
  const { rows } = await bounded(runtime, tx => tx.execute<{ id: string; workspace_id: string; fingerprint: string | null; at: string }>(sql`SELECT p.id,p.workspace_id,
      CASE WHEN NOT ${workspaceExcluded(sql`p.workspace_id`)} THEN p.card_fingerprint END AS fingerprint,${utc(sql`p.updated_at`)} AS at FROM billing_payment_attempts p
    WHERE (p.updated_at,p.id)>(${after.at}::timestamptz,${after.id}) AND p.created_at>=${run.since}::timestamptz ORDER BY p.updated_at,p.id LIMIT ${PAYMENTS_A_RUN}`));
  for (const row of rows) {
    if (spent(run)) break;
    const workspace: Entity = { type: 'workspace', id: row.workspace_id };
    // A payment whose write fails or times out is passed over: the cursor never waits on one row.
    if (row.fingerprint) try { run.added += await bounded(runtime, async tx => {
      await lockGuards(tx, [workspace as Guard]);
      const card = [{ kind: 'card', value: signalHash(runtime.config, 'card', row.fingerprint!), at: row.at }];
      const added = await writeSignals(tx, workspace, [workspace as Guard], card, false);
      await trimSignals(tx, workspace);
      await linkEntity(tx, workspace, card);
      return added;
    }); } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: 'payment' }); }
    run.cursors.payments = { at: row.at, id: row.id };
  }
  return rows.length;
}
// Mail the provider accepted through the Hosted pool: not simulated, with the provider's message ID, and dispatched
// on a feedback topic recorded as a Hosted pool's. Mail without that record (scheduled, canceled, suppressed, rejected,
// a connected account's, or older than the record) never qualifies.
const hostedAccepted = (mail: SQL) => sql`NOT ${mail}.simulated AND ${mail}.provider_id IS NOT NULL AND ${mail}.status NOT IN ('scheduled','queued','attempting','canceled','suppressed','rejected','rendering_failed','acceptance_unknown','simulated')
  AND EXISTS (SELECT FROM provider_feedback_history h WHERE h.topic_arn=${mail}.feedback_topic_arn AND h.kind='shared')`;
// Mail that reaches no one outside the workspace, much of it the same for every new workspace, says nothing about what
// the workspace sends and is never fingerprinted: Nightmail's own words (the dashboard's test email, and onboarding's
// setup email sent unchanged: screened as 'platform'), a campaign test, and anything addressed only to the members' own
// verified sign-in addresses (onboarding's setup email as edited, every send from the built-in domain while it sends to
// members only). The members rule is the built-in domain's (send_admission).
const ownMail = (mail: SQL) => sql`(${mail}.snapshot @> '{"screenVerdict":{"status":"platform"}}'::jsonb OR ${mail}.snapshot->>'testCampaignId' IS NOT NULL
  OR NOT EXISTS (SELECT FROM jsonb_array_elements_text(${mail}.to_addresses||${mail}.cc_addresses||${mail}.bcc_addresses) r(address) WHERE NOT EXISTS (
    SELECT FROM workspace_members m JOIN nightmail_users u ON u.id=m.user_id WHERE m.workspace_id=${mail}.workspace_id AND u.email_verified AND lower(u.email)=lower(r.address))))`;
/**
 * Fingerprints a bounded sample of the mail each workspace had accepted since it was last sampled, its own mail
 * (ownMail) left out: content bands and the hashed domains it links to and sends from (never the built-in domain, whose
 * root every workspace shares), dated by the acceptance. Never mail accepted before monitoring
 * started, before the workspace's last erasure or more than a day ago, and never a message (or a campaign's frozen
 * review) created before monitoring started, so nothing scheduled earlier is read. Workspaces are visited in ID order
 * from a stored cursor, a page at a time.
 */
async function sampleSends(runtime: Hosted, run: Run) {
  let sampled = 0;
  const floor = (workspaceId: SQL) => sql`greatest(coalesce((SELECT s.sampled_through FROM abuse_sampling s WHERE s.workspace_id=${workspaceId}),'-infinity'::timestamptz),
    coalesce((SELECT f.ignore_through FROM abuse_floors f WHERE f.entity_type='workspace' AND f.entity_id=${workspaceId}),'-infinity'::timestamptz),${run.since}::timestamptz,now()-interval '1 day')`;
  for (let page = 0; page < WORKSPACE_PAGES && sampled < SAMPLED_A_RUN && !spent(run); page++) {
    const start = run.cursors.workspaces ?? '';
    const { rows: ids } = await bounded(runtime, tx => tx.execute<{ id: string }>(sql`SELECT id FROM workspaces WHERE id>${start} ORDER BY id LIMIT ${WORKSPACE_PAGE}`));
    if (!ids.length) { run.cursors.workspaces = ''; break; }
    const { rows: due } = await bounded(runtime, tx => tx.execute<{ id: string }>(sql`SELECT w.id FROM unnest(${sql.param(ids.map(row => row.id))}::text[]) AS w(id)
      WHERE NOT ${workspaceExcluded(sql`w.id`)}
        AND EXISTS (SELECT FROM sending_email_events v WHERE v.workspace_id=w.id AND v.type='accepted' AND NOT v.simulated AND v.created_at>${floor(sql`w.id`)})
      ORDER BY w.id`));
    for (const workspace of due) {
      // Out of time or work: the next run starts at this workspace.
      if (sampled >= SAMPLED_A_RUN || spent(run)) { const at = ids.findIndex(row => row.id === workspace.id); run.cursors.workspaces = at > 0 ? ids[at - 1]!.id : start; return sampled; }
      // A workspace whose sample fails or times out is skipped until the cursor comes round again.
      try { if (await bounded(runtime, tx => sampleWorkspace(runtime, tx, run, workspace.id, floor(sql`${workspace.id}`)))) sampled++; } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: 'workspace' }); }
    }
    run.cursors.workspaces = ids.length < WORKSPACE_PAGE ? '' : ids.at(-1)!.id;
    if (ids.length < WORKSPACE_PAGE) break;
  }
  return sampled;
}
async function sampleWorkspace(runtime: Hosted, tx: DbExecutor, run: Run, workspaceId: string, floor: SQL) {
  const workspace: Entity = { type: 'workspace', id: workspaceId }, guards = [workspace as Guard];
  // Under the workspace's lock, its exclusions and floor are read again before any content is.
  await lockGuards(tx, guards);
  const { rows: recent } = await tx.execute<{ id: string; review_id: string | null; campaign_id: string | null; subject: string; at: string }>(sql`SELECT e.id,e.review_id,e.campaign_id,e.subject,${utc(sql`v.created_at`)} AS at
    FROM sending_email_events v JOIN sending_emails e ON e.workspace_id=v.workspace_id AND e.id=v.email_id
    LEFT JOIN sending_campaign_reviews r ON r.workspace_id=e.workspace_id AND r.id=e.review_id
    WHERE v.workspace_id=${workspaceId} AND v.type='accepted' AND NOT v.simulated AND v.created_at>${floor} AND NOT ${excluded(guards)} AND ${hostedAccepted(sql`e`)} AND NOT ${ownMail(sql`e`)}
      AND e.created_at>=${run.since}::timestamptz AND (e.review_id IS NULL OR r.created_at>=${run.since}::timestamptz)
    ORDER BY v.created_at DESC LIMIT 40`);
  if (!recent.length) return false;
  // One message per campaign or subject first, so a single large campaign doesn't use up the sample.
  const picked = [...new Map(recent.map(row => [row.review_id ?? row.campaign_id ?? row.subject, row])).values()].slice(0, MESSAGES_A_WORKSPACE);
  const { rows: mail } = await tx.execute<{ id: string; sender: string; html: string | null; text: string | null }>(sql`SELECT e.id,e.from_address AS sender,
      left(coalesce(r.rendered->>'html',e.snapshot->>'html'),24000) AS html,left(coalesce(r.rendered->>'text',e.snapshot->>'text'),8000) AS text
    FROM sending_emails e LEFT JOIN sending_campaign_reviews r ON r.workspace_id=e.workspace_id AND r.id=e.review_id
    WHERE e.workspace_id=${workspaceId} AND e.id=ANY(${sql.param(picked.map(row => row.id))}::text[]) AND ${hostedAccepted(sql`e`)}`);
  const signals: Signal[] = [];
  for (const message of mail) {
    const { subject, at } = picked.find(row => row.id === message.id)!;
    for (const band of contentFingerprint(runtime.config, subject, message.html, message.text) ?? []) signals.push({ kind: 'content', value: band, at });
    for (const domain of await linkDomains(message.html, message.text)) signals.push({ kind: 'link', value: signalHash(runtime.config, 'link', domain), at });
    const host = message.sender.slice(message.sender.lastIndexOf('@') + 1), sender = isBuiltinHost(runtime.config, host) ? null : await registrableDomain(host);
    if (sender) signals.push({ kind: 'send_domain', value: signalHash(runtime.config, 'send_domain', sender), at });
  }
  run.added += await writeSignals(tx, workspace, guards, signals, false);
  await trimSignals(tx, workspace);
  await linkEntity(tx, workspace, signals);
  await tx.execute(sql`INSERT INTO abuse_sampling(workspace_id,sampled_through) VALUES(${workspaceId},${recent[0]!.at}::timestamptz)
    ON CONFLICT (workspace_id) DO UPDATE SET sampled_through=excluded.sampled_through,sampled_at=now()`);
  return true;
}
/**
 * The hourly job (maintenance.ts hourlyUpkeep, last of its steps), the only writer of signals. Off, it forgets when
 * monitoring started, so turning it on again starts from that moment. On, it takes the lease (a run in progress makes
 * this one return), then reads the sign-in log and the payment records, samples accepted mail, and groups what
 * changed, each within its share of the time. A failing stage is logged and skipped. Returns what it did, or null when it did not run.
 */
export async function abuseHourly(runtime: Hosted, options: { budgetMs?: number; post?: import('./abuse-alerts.js').SlackPost } = {}) {
  if (!runtime.config.multiTenant) return null;
  if (!monitoring(runtime.config)) {
    try { await bounded(runtime, tx => tx.execute(sql`DELETE FROM abuse_state WHERE lease_until IS NULL OR lease_until<=now()`)); } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: 'state' }); }
    return null;
  }
  const since = runtime.config.abuseMonitoring!.since, budget = options.budgetMs ?? 20_000, started = Date.now(), result = { signIns: 0, payments: 0, sampled: 0, added: 0 };
  let run: Run;
  try {
    // The instant this database first ran with this activation time is the floor of everything read: a deployment
    // later than the configured time, or a setting changed or turned back on, starts from now.
    const { rows: [state] } = await bounded(runtime, tx => tx.execute<{ since: string; cursors: Cursors }>(sql`INSERT INTO abuse_state AS s(id,configured,active_since,lease_until)
      VALUES('monitor',${since}::timestamptz,greatest(${since}::timestamptz,now()),now()+${LEASE})
      ON CONFLICT (id) DO UPDATE SET lease_until=excluded.lease_until,configured=excluded.configured,
        active_since=CASE WHEN s.configured=excluded.configured THEN s.active_since ELSE excluded.active_since END,
        cursors=CASE WHEN s.configured=excluded.configured THEN s.cursors ELSE '{}'::jsonb END
      WHERE s.lease_until IS NULL OR s.lease_until<=now()
      RETURNING ${utc(sql`active_since`)} AS since,cursors`));
    if (!state) { log('info', { code: 'ABUSE_HOURLY_BUSY' }); return null; }
    run = { since: state.since, cursors: state.cursors ?? {}, added: 0, deadline: started };
  } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: 'lease' }); return null; }
  const stage = async (name: string, deadline: number, work: () => Promise<void>) => {
    run.deadline = deadline;
    try { await work(); } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: name }); }
    try { await bounded(runtime, tx => tx.execute(sql`UPDATE abuse_state SET cursors=${JSON.stringify(run.cursors)}::jsonb WHERE id='monitor'`)); } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: 'cursor' }); }
  };
  await stage('signIns', started + budget * .2, async () => { result.signIns = await foldSignIns(runtime, run); });
  await stage('payments', started + budget * .4, async () => { result.payments = await foldPayments(runtime, run); });
  await stage('sample', started + budget * .75, async () => { result.sampled = await sampleSends(runtime, run); });
  // Groups the entities whose links changed and rescores the clusters longest unscored (src/abuse-clusters.ts).
  // A change worth a person's look leaves an alert in the outbox; stored alerts are posted to Slack, a few an hour,
  // when the abuse or the operator alerts' webhook is configured (src/abuse-alerts.ts).
  const clusters = { grouped: 0, rescored: 0, alerts: 0, posted: 0 };
  await stage('clusters', started + budget, async () => {
    const [{ refreshClusters }, { noteAlert, deliverAlerts }] = await Promise.all([import('./abuse-clusters.js'), import('./abuse-alerts.js')]);
    Object.assign(clusters, await refreshClusters(runtime, started + budget, async change => { if (await noteAlert(runtime, change)) clusters.alerts++; }));
    clusters.posted = await deliverAlerts(runtime, started + budget, options.post);
  });
  try { await bounded(runtime, tx => tx.execute(sql`UPDATE abuse_state SET lease_until=NULL WHERE id='monitor'`)); } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: 'release' }); }
  result.added = run.added;
  log('info', { code: 'ABUSE_HOURLY', ...result, ...clusters, ms: Date.now() - started });
  return result;
}

// ----- A person's or a workspace's own signals ---------------------------------------------------------------------------
/** Whose signals a request is about: a user (with the workspaces they own and their sign-in subjects), one workspace,
 *  or a sign-in subject that was never admitted. */
export type SubjectTarget = { user: string } | { workspace: string } | { subject: { issuer: string; subject: string } };
/** Why an entity is excluded. One entity can be excluded for several reasons at once; each is lifted on its own. */
export const EXCLUSION_SOURCES = ['objection', 'agreement', 'operator'] as const;
export type ExclusionSource = (typeof EXCLUSION_SOURCES)[number];
/**
 * For an access, objection or erasure request (scripts/abuse-subject.ts), in one transaction under the entities' locks,
 * so no writer can add to what it removes:
 * - show: what is held, by kind and never by value, and the sources that exclude it;
 * - erase: deletes it and sets the floor, so nothing observed until now is recorded later either;
 * - exclude: erases, and records an exclusion under `source`. A user's exclusion covers the workspaces they own for
 *   as long as they own them; it is not copied onto the workspaces;
 * - include: lifts the exclusion of that `source` only, and sets the floor so the excluded time is never read.
 */
export async function abuseSubject(runtime: Hosted, target: SubjectTarget, action: 'show' | 'erase' | 'exclude' | 'include', options: { source?: ExclusionSource; reason?: string } = {}) {
  return runtime.db.transaction(async tx => {
    const subjects = 'user' in target ? (await tx.execute<{ issuer: string; subject: string }>(sql`SELECT issuer,subject FROM nightmail_oidc_identities WHERE user_id=${target.user}`)).rows : 'subject' in target ? [target.subject] : [];
    const owned = 'user' in target ? (await tx.execute<{ workspace_id: string }>(sql`SELECT workspace_id FROM workspace_members WHERE user_id=${target.user} AND role='owner'`)).rows.map(row => row.workspace_id)
      : 'workspace' in target ? [target.workspace] : [];
    // Exclusions sit on the user, the workspace or the subject itself; floors and locks also on what a user owns.
    const own: Guard[] = ['user' in target ? { type: 'user', id: target.user } : 'workspace' in target ? { type: 'workspace', id: target.workspace } : subjectGuard(target.subject.issuer, target.subject.subject),
      ...('user' in target ? subjects.map(s => subjectGuard(s.issuer, s.subject)) : [])];
    const guards: Guard[] = [...own, ...('user' in target ? owned.map(id => ({ type: 'workspace' as const, id })) : [])];
    const entities: Entity[] = [...('user' in target ? [{ type: 'user' as const, id: target.user }] : []), ...owned.map(id => ({ type: 'workspace' as const, id })),
      ...subjects.map(s => ({ type: 'attempt' as const, id: attemptEntity(runtime.config, s.issuer, s.subject) }))];
    const pairs = sql.join(entities.map(entity => sql`(${entity.type},${entity.id})`), sql`, `), source = options.source ?? 'objection';
    await lockGuards(tx, guards);
    if (action === 'exclude') for (const guard of own) await tx.execute(sql`INSERT INTO abuse_exclusions(entity_type,entity_id,source,reason) VALUES(${guard.type},${guard.id},${source},${options.reason ?? ''})
      ON CONFLICT (entity_type,entity_id,source) DO UPDATE SET reason=excluded.reason`);
    if (action === 'include') await tx.execute(sql`DELETE FROM abuse_exclusions WHERE (entity_type,entity_id) IN (${guardPairs(own)}) AND source=${source}`);
    if (action !== 'show') for (const guard of guards) await tx.execute(sql`INSERT INTO abuse_floors(entity_type,entity_id,ignore_through) VALUES(${guard.type},${guard.id},clock_timestamp())
      ON CONFLICT (entity_type,entity_id) DO UPDATE SET ignore_through=excluded.ignore_through`);
    if (action === 'erase' || action === 'exclude') {
      await tx.execute(sql`DELETE FROM abuse_signals WHERE (entity_type,entity_id) IN (${pairs})`);
      // What was derived from them: their links, every alert about them, and the clusters they were in (the other members are grouped again).
      await tx.execute(sql`DELETE FROM identity_links WHERE (a_type,a_id) IN (${pairs}) OR (b_type,b_id) IN (${pairs})`);
      await tx.execute(sql`DELETE FROM abuse_alerts WHERE cluster_id IN (SELECT m.cluster_id FROM abuse_cluster_members m WHERE (m.entity_type,m.entity_id) IN (${pairs}))
        OR members && ${sql.param(entities.map(entity => `${entity.type}:${entity.id}`))}::text[]`);
      await tx.execute(sql`WITH left_behind AS (DELETE FROM abuse_clusters c USING abuse_cluster_members m WHERE m.cluster_id=c.id AND (m.entity_type,m.entity_id) IN (${pairs}) RETURNING c.members)
        UPDATE identity_links l SET pending=true FROM left_behind b, jsonb_to_recordset(b.members) AS e(type text,id text)
        WHERE NOT l.pending AND ((l.a_type,l.a_id)=(e.type,e.id) OR (l.b_type,l.b_id)=(e.type,e.id))`);
      // What a sign-in observed and the job has not read yet.
      for (const s of subjects) await tx.execute(sql`UPDATE nightmail_signin_attempts SET observed=NULL WHERE issuer=${s.issuer} AND subject=${s.subject} AND observed IS NOT NULL`);
    }
    const { rows: held } = await tx.execute<{ kind: string; values: number; first: string; last: string }>(sql`SELECT kind,count(*)::int AS values,min(first_at)::text AS first,max(last_at)::text AS last
      FROM abuse_signals WHERE (entity_type,entity_id) IN (${pairs}) GROUP BY kind ORDER BY kind`);
    const { rows: sources } = await tx.execute<{ source: string }>(sql`SELECT DISTINCT source FROM abuse_exclusions WHERE (entity_type,entity_id) IN (${guardPairs(own)}) ORDER BY source`);
    // recording: false while anything excludes it, its own exclusions or, for a workspace, an owner's.
    const { rows: [state] } = await tx.execute<{ excluded: boolean }>(sql`SELECT ${excluded(own)} AS excluded`);
    return { held, excluded: sources.map(row => row.source), recording: !state!.excluded, entities: entities.length };
  });
}
