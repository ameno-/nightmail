import { createHmac, hkdfSync } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ipNetwork, userAgentFamily } from './audit.js';
import { clientIpHeader, clientNetworkHeader } from './brand.js';
import { log, type DbExecutor, type Runtime } from './core.js';
import { placementRoot } from './domain-registry.js';

// Abuse and fraud monitoring for hosted installations: small facts ("signals") about users, workspaces and refused
// sign-ins, kept so that related accounts can be recognised by a person later.
//
// Monitoring only. Nothing here blocks, pauses or limits anyone, and nothing is derived from the signals yet.
// - Off unless NIGHTMAIL_ABUSE_MONITORING names an activation time that has passed. Nothing created before the
//   database first ran with that setting is ever read. Expiry runs whether it is on or off.
// - No caller waits. A sign-in or a new workspace hands over one small event, already pseudonymised, and returns:
//   the event goes to a queue (the Worker) or a bounded in-process buffer (Node) with its own consumer, and is dropped
//   when either is busy. Payments are read later from the payment records; sent mail from the sending log.
// - The send path runs no code and no statement of this module.
// - Every statement of the consumer and the hourly job runs with a short statement and lock timeout, in work-limited
//   slices that continue from stored cursors, under a lease.
//
// A stored value is a keyed one-way hash (an address, a network, a card, a domain, a content fingerprint) or a value
// that names no person (an ASN, a country, a browser family, a flag). The service holds the key, so it can test a
// candidate value against the store; nobody without the key can.

type Hosted = Pick<Runtime, 'db' | 'config'> & Pick<Partial<Runtime>, 'abuseEvents'>;
export type Entity = { type: 'user' | 'workspace' | 'attempt'; id: string };
/** One fact. `at`: when it was true (the provider accepted the mail, the payment changed); now when absent. */
export type Signal = { kind: string; value: string; detail?: Record<string, string | number | boolean>; at?: string };
/** The client as the entry point saw it (clientIpHeader, clientNetworkHeader) and its browser. */
export type RequestNetwork = { ip: string | null; userAgent: string | null; asn: string | null; country: string | null };
/** What a request hands over: an entity and its signals, hashed already. `adopt`: a refused sign-in's entity whose
 *  signals now belong to this user. */
export type AbuseEvent = { entity: Entity; signals: Signal[]; adopt?: string };

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
// Mailbox providers anyone can sign up with: sharing one of these domains says nothing about two accounts.
const PUBLIC_MAILBOXES = new Set(`gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com rocketmail.com icloud.com me.com mac.com
  aol.com proton.me protonmail.com pm.me gmx.com gmx.net gmx.de web.de mail.com zoho.com zohomail.com yandex.com yandex.ru mail.ru qq.com 163.com 126.com sina.com
  fastmail.com fastmail.fm hey.com tutanota.com tuta.io tuta.com tutamail.com duck.com hotmail.co.uk hotmail.fr hotmail.de hotmail.it hotmail.es outlook.fr outlook.de
  outlook.es outlook.it live.co.uk live.fr yahoo.co.uk yahoo.fr yahoo.de yahoo.es yahoo.it yahoo.co.jp yahoo.co.in yahoo.com.br yahoo.ca comcast.net verizon.net
  att.net sbcglobal.net cox.net orange.fr free.fr laposte.net t-online.de libero.it naver.com daum.net seznam.cz wp.pl o2.pl btinternet.com sky.com`.split(/\s+/));
// A starting list of disposable-address services.
const DISPOSABLE = new Set(`mailinator.com guerrillamail.com guerrillamail.net guerrillamail.org guerrillamail.biz guerrillamailblock.com sharklasers.com grr.la
  pokemail.net spam4.me 10minutemail.com 10minutemail.net 10minemail.com tempmail.com temp-mail.org temp-mail.io tempmail.net tempmail.dev tempmailo.com tempail.com
  tempr.email tmpmail.org tmpmail.net tmpeml.com yopmail.com yopmail.fr yopmail.net trashmail.com trashmail.net trashmail.de trash-mail.com getnada.com nada.email
  dispostable.com maildrop.cc throwawaymail.com fakeinbox.com fakemail.net mohmal.com emailondeck.com mintemail.com mytemp.email burnermail.io spamgourmet.com
  mailnesia.com mailcatch.com inboxkitten.com moakt.com 1secmail.com 1secmail.org 1secmail.net discard.email discardmail.com mailsac.com harakirimail.com
  getairmail.com mailpoof.com emailfake.com email-fake.com generator.email luxusmail.org minuteinbox.com tempinbox.com temp-inbox.com inboxbear.com mail.tm mail.gw
  dropmail.me mailnull.com spambox.us jetable.org mailexpire.com byom.de anonbox.net`.split(/\s+/));

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
  return { exact: `${local}@${domain}`, alias: rule ? `${mailbox}@${rule.as ?? domain}` : null, tagged, domain, disposable: DISPOSABLE.has(domain), publicMailbox: PUBLIC_MAILBOXES.has(domain) };
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
/** The network as a keyed hash of its /24 (or /48), its ASN and country, and the browser's family, never its user agent. */
function networkSignals(config: Runtime['config'], network: RequestNetwork | null | undefined): Signal[] {
  if (!network) return [];
  const out: Signal[] = [], net = ipNetwork(network.ip), browser = userAgentFamily(network.userAgent);
  if (net) out.push({ kind: 'net', value: signalHash(config, 'net', net) });
  if (network.asn) out.push({ kind: 'asn', value: network.asn, ...(network.country ? { detail: { country: network.country } } : {}) });
  if (browser) out.push({ kind: 'browser', value: browser });
  return out;
}

// ----- The store ---------------------------------------------------------------------------------------------------------
/** One short transaction with the module's statement and lock timeouts: a slow or blocked statement ends, it never waits. */
function bounded<T>(runtime: Hosted, work: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return runtime.db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('statement_timeout',${String(STATEMENT_MS)},true),set_config('lock_timeout',${String(LOCK_MS)},true)`);
    return work(tx);
  });
}
/**
 * Notes signals for one entity: a new row, or a later sighting of a row it has. Nothing is written for an excluded
 * entity. Past ENTITY_KIND_MOST values of one kind, the least recently seen leave. Returns the number of new rows.
 */
async function writeSignals(tx: DbExecutor, entity: Entity, signals: Signal[], count: boolean) {
  const rows = [...new Map(signals.filter(s => s.value && s.value.length <= 255).map(s => [`${s.kind}\n${s.value}`, { kind: s.kind, value: s.value, detail: s.detail ?? null, at: s.at ?? null }])).values()];
  if (!rows.length) return 0;
  const { rows: [written] } = await tx.execute<{ added: number }>(sql`WITH incoming AS (
      SELECT r.kind,r.value,r.detail,coalesce(r.at,now()) AS at FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(kind text,value text,detail jsonb,at timestamptz)
      WHERE NOT EXISTS (SELECT FROM abuse_exclusions x WHERE x.entity_type=${entity.type} AND x.entity_id=${entity.id})),
    written AS (INSERT INTO abuse_signals(entity_type,entity_id,kind,value,detail,first_at,last_at) SELECT ${entity.type},${entity.id},kind,value,detail,at,at FROM incoming
      ON CONFLICT (entity_type,entity_id,kind,value) DO UPDATE SET seen=abuse_signals.seen+${count ? 1 : 0},last_at=greatest(abuse_signals.last_at,excluded.last_at),detail=coalesce(excluded.detail,abuse_signals.detail)
      RETURNING (xmax=0) AS fresh)
    SELECT count(*) FILTER (WHERE fresh)::int AS added FROM written`);
  const added = written?.added ?? 0;
  if (added) await tx.execute(sql`DELETE FROM abuse_signals s USING (SELECT kind,value,row_number() OVER (PARTITION BY kind ORDER BY last_at DESC,value) AS n
      FROM abuse_signals WHERE entity_type=${entity.type} AND entity_id=${entity.id}) old
    WHERE s.entity_type=${entity.type} AND s.entity_id=${entity.id} AND s.kind=old.kind AND s.value=old.value AND old.n>${ENTITY_KIND_MOST}`);
  return added;
}

// ----- Request events ----------------------------------------------------------------------------------------------------
const EVENT_SIGNALS_MOST = 16, EVENTS_A_MINUTE = 120, BUFFER_MOST = 256;
const EventSchema = z.object({ entity: z.object({ type: z.enum(['user', 'workspace', 'attempt']), id: z.string().min(1).max(200) }).strict(),
  signals: z.array(z.object({ kind: z.string().regex(/^[a-z_]{1,32}$/), value: z.string().min(1).max(255), detail: z.record(z.string().max(32), z.union([z.string().max(100), z.number(), z.boolean()])).optional() }).strict()).max(EVENT_SIGNALS_MOST),
  adopt: z.string().regex(/^att_[0-9a-f]{32}$/).optional() }).strict();
/**
 * The consumer: writes events one by one, each in its own short transaction. Called by the Worker's queue handler and
 * by the in-process buffer. An event that is malformed, or whose write fails or times out, is dropped.
 */
export async function applyAbuseEvents(runtime: Hosted, events: readonly unknown[]) {
  if (!monitoring(runtime.config)) return 0;
  let applied = 0;
  for (const candidate of events) {
    const event = EventSchema.safeParse(candidate).data;
    try {
      if (!event) throw new Error('malformed');
      await bounded(runtime, async tx => {
        await writeSignals(tx, event.entity, event.signals, true);
        // What a subject's refused sign-ins left now belongs to the user it became.
        if (event.adopt && event.entity.type === 'user') await tx.execute(sql`WITH moved AS (DELETE FROM abuse_signals WHERE entity_type='attempt' AND entity_id=${event.adopt} RETURNING *)
          INSERT INTO abuse_signals(entity_type,entity_id,kind,value,seen,detail,first_at,last_at) SELECT 'user',${event.entity.id},kind,value,seen,detail,first_at,last_at FROM moved
          WHERE NOT EXISTS (SELECT FROM abuse_exclusions x WHERE x.entity_type='user' AND x.entity_id=${event.entity.id})
          ON CONFLICT (entity_type,entity_id,kind,value) DO UPDATE SET seen=abuse_signals.seen+excluded.seen,first_at=least(abuse_signals.first_at,excluded.first_at),last_at=greatest(abuse_signals.last_at,excluded.last_at)`);
      });
      applied++;
    } catch { log('warn', { code: 'ABUSE_EVENT_FAILED' }); }
  }
  return applied;
}
// The in-process buffer, for a runtime without a queue (Node). One consumer per database handle.
const buffers = new WeakMap<object, { events: AbuseEvent[]; draining: Promise<void> | null }>();
let minute = 0, handed = 0, droppedAt = 0;
/** Events dropped by this process since it started (the queue was busy, the buffer full, or too many in a minute). */
export const abuseDropped = { count: 0 };
function drop(reason: string) {
  abuseDropped.count++;
  if (droppedAt !== minute) { droppedAt = minute; log('warn', { code: 'ABUSE_EVENT_DROPPED', reason }); }
}
/**
 * Hands one event over and returns at once: nothing here waits, reads or writes. The Worker's sink sends it to a
 * queue after the response; without a sink it joins a bounded buffer that one consumer empties. Past the rate, with a
 * full buffer or a failing sink, the event is dropped.
 */
function emit(runtime: Hosted, event: AbuseEvent): void {
  if (!monitoring(runtime.config) || !event.signals.length) return;
  const now = Math.floor(Date.now() / 60_000);
  if (now !== minute) { minute = now; handed = 0; }
  if (++handed > EVENTS_A_MINUTE) return drop('rate');
  const bound = { ...event, signals: event.signals.slice(0, EVENT_SIGNALS_MOST) };
  if (runtime.abuseEvents) {
    try { void Promise.resolve(runtime.abuseEvents(bound)).catch(() => drop('sink')); } catch { drop('sink'); }
    return;
  }
  let buffer = buffers.get(runtime.db);
  if (!buffer) buffers.set(runtime.db, buffer = { events: [], draining: null });
  if (buffer.events.length >= BUFFER_MOST) return drop('full');
  buffer.events.push(bound);
  const state = buffer;
  state.draining ??= (async () => { while (state.events.length) await applyAbuseEvents(runtime, state.events.splice(0, 20)); })().catch(() => {}).finally(() => { state.draining = null; });
}
/** Resolves when this runtime's in-process buffer is empty. For tests and shutdown. */
export const abuseSettled = (runtime: Pick<Runtime, 'db'>) => buffers.get(runtime.db)?.draining ?? Promise.resolve();

const attemptEntity = (config: Runtime['config'], issuer: string, subject: string) => `att_${signalHash(config, 'attempt', `${issuer}\n${subject}`)}`;
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
export function observeSignIn(runtime: Hosted, o: SignInObserved): void {
  if (!monitoring(runtime.config)) return;
  const { config } = runtime, signals = networkSignals(config, o.network), attempt = attemptEntity(config, o.issuer, o.subject);
  const email = o.email ? readAddress(o.email) : null;
  if (email) {
    signals.push({ kind: 'email', value: signalHash(config, 'email', email.exact) });
    if (email.alias) signals.push({ kind: 'email_alias', value: signalHash(config, 'email_alias', email.alias) });
    if (!email.publicMailbox) signals.push({ kind: 'email_domain', value: signalHash(config, 'email_domain', email.domain), detail: { class: email.disposable ? 'disposable' : 'own' } });
    if (email.disposable) signals.push({ kind: 'flag', value: 'disposable_email' });
    if (email.tagged) signals.push({ kind: 'flag', value: 'plus_alias' });
  }
  if (o.provider) signals.push({ kind: 'provider', value: signalHash(config, 'provider', `${o.provider.provider}\n${o.provider.sub}`) });
  if (o.outcome === 'not_approved') signals.push({ kind: 'flag', value: 'waitlisted' });
  emit(runtime, o.userId ? { entity: { type: 'user', id: o.userId }, signals, ...(o.created ? { adopt: attempt } : {}) } : { entity: { type: 'attempt', id: attempt }, signals });
}
/** A workspace made from the dashboard: where the request came from. */
export function observeWorkspaceCreated(runtime: Hosted, workspaceId: string, network: RequestNetwork): void {
  emit(runtime, { entity: { type: 'workspace', id: workspaceId }, signals: networkSignals(runtime.config, network) });
}

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
const PAYMENTS_A_RUN = 200, WORKSPACE_PAGE = 200, WORKSPACE_PAGES = 10, SAMPLED_A_RUN = 100, MESSAGES_A_WORKSPACE = 6, NEW_ROWS_A_RUN = 5000, LEASE = sql`interval '5 minutes'`;
type Cursors = { payments?: { at: string; id: string }; workspaces?: string };
type Run = { since: string; cursors: Cursors; added: number; deadline: number };
const spent = (run: Run) => Date.now() >= run.deadline || run.added >= NEW_ROWS_A_RUN;

/**
 * Cards from the payment records (billing_payment_attempts), in the order they last changed: each as a keyed hash on
 * its workspace, dated when the payment changed. Only payments made since monitoring started.
 */
async function foldPayments(runtime: Hosted, run: Run) {
  const after = run.cursors.payments ?? { at: run.since, id: '' };
  const { rows } = await bounded(runtime, tx => tx.execute<{ id: string; workspace_id: string; fingerprint: string; at: string }>(sql`SELECT id,workspace_id,card_fingerprint AS fingerprint,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM billing_payment_attempts
    WHERE (updated_at,id)>(${after.at}::timestamptz,${after.id}) AND created_at>=${run.since}::timestamptz ORDER BY updated_at,id LIMIT ${PAYMENTS_A_RUN}`));
  for (const row of rows) {
    if (spent(run)) break;
    // A payment whose write fails or times out is passed over: the cursor never waits on one row.
    if (row.fingerprint) try { run.added += await bounded(runtime, tx => writeSignals(tx, { type: 'workspace', id: row.workspace_id }, [{ kind: 'card', value: signalHash(runtime.config, 'card', row.fingerprint), at: row.at }], false)); }
      catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: 'payment' }); }
    run.cursors.payments = { at: row.at, id: row.id };
  }
  return rows.length;
}
// Mail the provider accepted through the Hosted pool: not simulated, with the provider's message ID, and dispatched
// on a feedback topic recorded as a Hosted pool's. Mail without that record (scheduled, canceled, suppressed, rejected,
// a connected account's, or older than the record) never qualifies.
const hostedAccepted = (mail: SQL) => sql`NOT ${mail}.simulated AND ${mail}.provider_id IS NOT NULL AND ${mail}.status NOT IN ('scheduled','queued','attempting','canceled','suppressed','rejected','rendering_failed','acceptance_unknown','simulated')
  AND EXISTS (SELECT FROM provider_feedback_history h WHERE h.topic_arn=${mail}.feedback_topic_arn AND h.kind='shared')`;
/**
 * Fingerprints a bounded sample of the mail each workspace had accepted since it was last sampled (never before
 * monitoring started, never more than a day back): content bands and the hashed domains it links to and sends from,
 * dated by the acceptance. Workspaces are visited in ID order from a stored cursor, a page at a time.
 */
async function sampleSends(runtime: Hosted, run: Run) {
  let sampled = 0;
  for (let page = 0; page < WORKSPACE_PAGES && sampled < SAMPLED_A_RUN && !spent(run); page++) {
    const start = run.cursors.workspaces ?? '';
    const { rows: ids } = await bounded(runtime, tx => tx.execute<{ id: string }>(sql`SELECT id FROM workspaces WHERE id>${start} ORDER BY id LIMIT ${WORKSPACE_PAGE}`));
    if (!ids.length) { run.cursors.workspaces = ''; break; }
    const floor = (sampledThrough: SQL) => sql`greatest(coalesce(${sampledThrough},'-infinity'::timestamptz),${run.since}::timestamptz,now()-interval '1 day')`;
    const { rows: due } = await bounded(runtime, tx => tx.execute<{ id: string; since: string }>(sql`SELECT w.id,${floor(sql`s.sampled_through`)}::text AS since
      FROM unnest(${sql.param(ids.map(row => row.id))}::text[]) AS w(id) LEFT JOIN abuse_sampling s ON s.workspace_id=w.id
      WHERE NOT EXISTS (SELECT FROM abuse_exclusions x WHERE x.entity_type='workspace' AND x.entity_id=w.id)
        AND EXISTS (SELECT FROM sending_email_events v WHERE v.workspace_id=w.id AND v.type='accepted' AND NOT v.simulated AND v.created_at>${floor(sql`s.sampled_through`)})
      ORDER BY w.id`));
    for (const workspace of due) {
      // Out of time or work: the next run starts at this workspace.
      if (sampled >= SAMPLED_A_RUN || spent(run)) { const at = ids.findIndex(row => row.id === workspace.id); run.cursors.workspaces = at > 0 ? ids[at - 1]!.id : start; return sampled; }
      // A workspace whose sample fails or times out is skipped until the cursor comes round again.
      try { if (await bounded(runtime, tx => sampleWorkspace(runtime, tx, run, workspace))) sampled++; } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: 'workspace' }); }
    }
    run.cursors.workspaces = ids.length < WORKSPACE_PAGE ? '' : ids.at(-1)!.id;
    if (ids.length < WORKSPACE_PAGE) break;
  }
  return sampled;
}
async function sampleWorkspace(runtime: Hosted, tx: DbExecutor, run: Run, workspace: { id: string; since: string }) {
  const { rows: recent } = await tx.execute<{ id: string; review_id: string | null; campaign_id: string | null; subject: string; at: string }>(sql`SELECT e.id,e.review_id,e.campaign_id,e.subject,
      to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    FROM sending_email_events v JOIN sending_emails e ON e.workspace_id=v.workspace_id AND e.id=v.email_id
    WHERE v.workspace_id=${workspace.id} AND v.type='accepted' AND NOT v.simulated AND v.created_at>${workspace.since}::timestamptz AND ${hostedAccepted(sql`e`)}
    ORDER BY v.created_at DESC LIMIT 40`);
  if (!recent.length) return false;
  // One message per campaign or subject first, so a single large campaign doesn't use up the sample.
  const picked = [...new Map(recent.map(row => [row.review_id ?? row.campaign_id ?? row.subject, row])).values()].slice(0, MESSAGES_A_WORKSPACE);
  const { rows: mail } = await tx.execute<{ id: string; sender: string; html: string | null; text: string | null }>(sql`SELECT e.id,e.from_address AS sender,
      left(coalesce(r.rendered->>'html',e.snapshot->>'html'),24000) AS html,left(coalesce(r.rendered->>'text',e.snapshot->>'text'),8000) AS text
    FROM sending_emails e LEFT JOIN sending_campaign_reviews r ON r.workspace_id=e.workspace_id AND r.id=e.review_id
    WHERE e.workspace_id=${workspace.id} AND e.id=ANY(${sql.param(picked.map(row => row.id))}::text[]) AND ${hostedAccepted(sql`e`)}`);
  const signals: Signal[] = [];
  for (const message of mail) {
    const { subject, at } = picked.find(row => row.id === message.id)!;
    for (const band of contentFingerprint(runtime.config, subject, message.html, message.text) ?? []) signals.push({ kind: 'content', value: band, at });
    for (const domain of await linkDomains(message.html, message.text)) signals.push({ kind: 'link', value: signalHash(runtime.config, 'link', domain), at });
    const sender = await registrableDomain(message.sender.slice(message.sender.lastIndexOf('@') + 1));
    if (sender) signals.push({ kind: 'send_domain', value: signalHash(runtime.config, 'send_domain', sender), at });
  }
  run.added += await writeSignals(tx, { type: 'workspace', id: workspace.id }, signals, false);
  await tx.execute(sql`INSERT INTO abuse_sampling(workspace_id,sampled_through) VALUES(${workspace.id},${recent[0]!.at}::timestamptz)
    ON CONFLICT (workspace_id) DO UPDATE SET sampled_through=excluded.sampled_through,sampled_at=now()`);
  return true;
}
/**
 * The hourly job (maintenance.ts hourlyUpkeep, last of its steps). Off, it forgets when monitoring started, so turning
 * it on again starts from that moment. On, it takes the lease (a run in progress makes this one return), reads cards
 * from the payment records for a quarter of its time, then samples accepted mail. A failing stage is logged and
 * skipped. Returns what it did, or null when it did not run.
 */
export async function abuseHourly(runtime: Hosted, options: { budgetMs?: number } = {}) {
  if (!runtime.config.multiTenant) return null;
  if (!monitoring(runtime.config)) {
    try { await bounded(runtime, tx => tx.execute(sql`DELETE FROM abuse_state WHERE lease_until IS NULL OR lease_until<=now()`)); } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: 'state' }); }
    return null;
  }
  const since = runtime.config.abuseMonitoring!.since, budget = options.budgetMs ?? 20_000, started = Date.now(), result = { payments: 0, sampled: 0, added: 0 };
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
      RETURNING to_char(active_since AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS since,cursors`));
    if (!state) { log('info', { code: 'ABUSE_HOURLY_BUSY' }); return null; }
    run = { since: state.since, cursors: state.cursors ?? {}, added: 0, deadline: started + budget / 4 };
  } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: 'lease' }); return null; }
  const stage = async (name: string, deadline: number, work: () => Promise<void>) => {
    run.deadline = deadline;
    try { await work(); } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: name }); }
    try { await bounded(runtime, tx => tx.execute(sql`UPDATE abuse_state SET cursors=${JSON.stringify(run.cursors)}::jsonb WHERE id='monitor'`)); } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: 'cursor' }); }
  };
  await stage('payments', started + budget / 4, async () => { result.payments = await foldPayments(runtime, run); });
  await stage('sample', started + budget, async () => { result.sampled = await sampleSends(runtime, run); });
  try { await bounded(runtime, tx => tx.execute(sql`UPDATE abuse_state SET lease_until=NULL WHERE id='monitor'`)); } catch { log('warn', { code: 'ABUSE_STEP_FAILED', step: 'release' }); }
  result.added = run.added;
  log('info', { code: 'ABUSE_HOURLY', ...result, ms: Date.now() - started });
  return result;
}

// ----- A person's or a workspace's own signals ---------------------------------------------------------------------------
/**
 * For an access, objection or erasure request (scripts/abuse-subject.ts): what is held about these entities, by kind
 * and never by value; `erase` deletes it; `exclude` deletes it and stops recording them; `include` records them again.
 */
export async function abuseSubject(db: DbExecutor, entities: Entity[], action: 'show' | 'erase' | 'exclude' | 'include', reason?: string) {
  const pairs = sql.join(entities.map(entity => sql`(${entity.type},${entity.id})`), sql`, `);
  if (action === 'exclude') for (const entity of entities) await db.execute(sql`INSERT INTO abuse_exclusions(entity_type,entity_id,reason) VALUES(${entity.type},${entity.id},${reason ?? ''})
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET reason=excluded.reason`);
  if (action === 'include') await db.execute(sql`DELETE FROM abuse_exclusions WHERE (entity_type,entity_id) IN (${pairs})`);
  if (action === 'erase' || action === 'exclude') {
    await db.execute(sql`DELETE FROM abuse_signals WHERE (entity_type,entity_id) IN (${pairs})`);
    await db.execute(sql`DELETE FROM abuse_sampling WHERE workspace_id=ANY(${sql.param(entities.filter(entity => entity.type === 'workspace').map(entity => entity.id))}::text[])`);
  }
  const { rows: held } = await db.execute<{ kind: string; values: number; first: string; last: string }>(sql`SELECT kind,count(*)::int AS values,min(first_at)::text AS first,max(last_at)::text AS last
    FROM abuse_signals WHERE (entity_type,entity_id) IN (${pairs}) GROUP BY kind ORDER BY kind`);
  const { rows: excluded } = await db.execute<{ entity_type: string; entity_id: string }>(sql`SELECT entity_type,entity_id FROM abuse_exclusions WHERE (entity_type,entity_id) IN (${pairs})`);
  return { held, excluded: excluded.length };
}
/** Every entity a user's signals may be under: the user, the workspaces they own, and their refused sign-ins. */
export async function userEntities(db: DbExecutor, config: Runtime['config'], userId: string): Promise<Entity[]> {
  const { rows: identities } = await db.execute<{ issuer: string; subject: string }>(sql`SELECT issuer,subject FROM nightmail_oidc_identities WHERE user_id=${userId}`);
  const { rows: owned } = await db.execute<{ workspace_id: string }>(sql`SELECT workspace_id FROM workspace_members WHERE user_id=${userId} AND role='owner'`);
  return [{ type: 'user', id: userId }, ...identities.map(i => ({ type: 'attempt' as const, id: attemptEntity(config, i.issuer, i.subject) })), ...owned.map(w => ({ type: 'workspace' as const, id: w.workspace_id }))];
}
