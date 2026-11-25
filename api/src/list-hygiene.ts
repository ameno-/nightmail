import { z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { log, logError, type Runtime } from './core.js';
import { DISPOSABLE_SOURCE, disposableDomains } from './disposable-domains.js';

// List hygiene, at the front door. An address that looks like a spam trap or can't reach a person is flagged on its contact
// (audience_contacts.risk, migration 497) when the contact is created or imported, and the hourly pass below flags the
// contacts that were there before and follows the vendored list and new bounces. Campaigns and marketing sends skip a
// flagged contact unless its owner allowed it (risk_allowed); transactional mail is never refused, only warned about.
//  - invalid: not an address mail can be delivered to (the syntax campaign capture would refuse).
//  - disposable: a public temporary inbox (src/disposable-domains.ts): anyone can read it, blocklist operators included.
//  - typo_domain: one edit away from a large mailbox provider (gmial.com, hotmial.com, yahooo.com, gmail.con).
//  - role: an address that is never a subscriber (abuse@, postmaster@, noreply@): marketing there is reported.
//  - dead: hard-bounced in another workspace in the last year. A bounce in its own workspace suppresses it already.
export const RISKS = ['invalid', 'disposable', 'typo_domain', 'role', 'dead'] as const;
export type Risk = (typeof RISKS)[number];
export const RiskReason = z.enum(RISKS).describe('invalid: not a deliverable address. disposable: a public temporary inbox. typo_domain: a mistyped mailbox provider (gmial.com). role: abuse@, postmaster@, noreply@ and the like. dead: known to be undeliverable (a recent permanent bounce).');
export const RiskBreakdown = z.object({ total: z.number().int(), byReason: z.object(Object.fromEntries(RISKS.map(r => [r, z.number().int()])) as Record<Risk, z.ZodNumber>) }).openapi('RiskBreakdown');
/** Recipients of a send whose address alone looks risky: transactional mail goes anyway, with these in its receipt. */
export const RecipientWarning = z.object({ email: z.string(), risk: RiskReason.exclude(['dead']), suggestion: z.string().nullable() }).openapi('RecipientWarning');
export function recipientWarnings(addresses: string[]) {
  const warnings = addresses.flatMap(address => { const email = (/<([^<>]+)>\s*$/.exec(address)?.[1] ?? address).trim(), found = classifyAddress(email); return found ? [{ email, risk: found.risk, suggestion: found.suggestion }] : []; });
  return warnings.length ? { warnings } : {};
}
/** Bump the suffix when a rule changes: a new version reclassifies every contact. */
export const HYGIENE_VERSION = `${DISPOSABLE_SOURCE.commit.slice(0, 12)}.1`;

const ADDRESS = /^(?!\.)(?!.*\.\.)[a-z0-9_'+.\-]*[a-z0-9_+\-]@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,}|xn--[a-z0-9][a-z0-9-]*[a-z0-9])$/i;
/** The address syntax createContact accepts (mailAddress in outbound-content.ts), without a schema: the import preview and
 *  the hourly pass run it on every row. */
export function validAddress(email: string): boolean {
  if (!email || email.length > 254 || !/^[\x21-\x7e]+$/.test(email) || !ADDRESS.test(email)) return false;
  const at = email.indexOf('@');
  if (at > 64) return false;
  let start = at + 1;
  for (;;) {
    const dot = email.indexOf('.', start), end = dot < 0 ? email.length : dot;
    if (end - start > 63) return false;
    if (dot < 0) return true;
    start = dot + 1;
  }
}

// Providers anyone can sign up with (abuse.ts compares addresses with it too).
export const PUBLIC_MAILBOXES = new Set(`gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com rocketmail.com icloud.com me.com mac.com
  aol.com proton.me protonmail.com pm.me gmx.com gmx.net gmx.de web.de mail.com zoho.com zohomail.com yandex.com yandex.ru mail.ru qq.com 163.com 126.com sina.com
  fastmail.com fastmail.fm hey.com tutanota.com tuta.io tuta.com tutamail.com duck.com hotmail.co.uk hotmail.fr hotmail.de hotmail.it hotmail.es outlook.fr outlook.de
  outlook.es outlook.it live.co.uk live.fr yahoo.co.uk yahoo.fr yahoo.de yahoo.es yahoo.it yahoo.co.jp yahoo.co.in yahoo.com.br yahoo.ca comcast.net verizon.net
  att.net sbcglobal.net cox.net orange.fr free.fr laposte.net t-online.de libero.it naver.com daum.net seznam.cz wp.pl o2.pl btinternet.com sky.com`.split(/\s+/));

// Public temporary inboxes upstream leaves out, flagged by abuse monitoring since it started.
const EXTRA_DISPOSABLE = 'tempmail.com temp-mail.io tempmail.net tempmail.dev luxusmail.org temp-inbox.com';
let disposable: Set<string> | undefined;
/** A domain, or a domain under one, on the disposable-inbox list. */
export function isDisposableDomain(domain: string) {
  disposable ??= new Set(`${disposableDomains} ${EXTRA_DISPOSABLE}`.split(/\s+/).filter(Boolean));
  for (let name = domain.toLowerCase(); name.includes('.'); name = name.slice(name.indexOf('.') + 1)) if (disposable.has(name)) return true;
  return false;
}

// The large providers whose names people mistype: a domain one edit from the name (gmial.com, yahooo.com, hotmial.co.uk)
// is a typo of it. Smaller providers' names are close to real companies' (naver.com, never.com), so only these.
const TYPO_NAMES = ['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'comcast.net', 'protonmail.com', 'sbcglobal.net',
  'btinternet.com', 'rocketmail.com', 'bellsouth.net', 'hotmail.co.uk', 'yahoo.co.uk'];
// A provider's own name under a suffix one edit from its own (gmail.con, hotmail.co, aol.cm, comcast.ner).
const TYPO_SUFFIXES = [...TYPO_NAMES, 'aol.com', 'live.com', 'msn.com', 'ymail.com', 'me.com', 'mac.com', 'att.net', 'verizon.net', 'cox.net', 'charter.net',
  'earthlink.net', 'juno.com', 'qq.com', '163.com', '126.com', 'mail.com', 'gmx.com', 'gmx.net', 'live.co.uk'];
// Real domains one edit from those, never typos.
const NOT_TYPOS = ['mail.com', 'email.com', 'ymail.com', 'gmx.com', 'cloud.com', 'wahoo.com', 'hotmail.co.jp', 'live.co.uk', 'live.co.za', 'yahoo.co.in', 'yahoo.co.jp'];
const EDIT = 'abcdefghijklmnopqrstuvwxyz0123456789-';
function oneEdit(word: string) {
  const out = new Set<string>();
  for (let i = 0; i <= word.length; i++) {
    for (const c of EDIT) out.add(word.slice(0, i) + c + word.slice(i));
    if (i === word.length) break;
    out.add(word.slice(0, i) + word.slice(i + 1));
    for (const c of EDIT) out.add(word.slice(0, i) + c + word.slice(i + 1));
    if (i + 1 < word.length) out.add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
  }
  out.delete(word);
  return [...out].filter(v => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(v) && !v.includes('..'));
}
let typos: Map<string, string> | undefined;
function typoOf(domain: string) {
  if (!typos) {
    const map = new Map<string, string>(), split = (d: string) => [d.slice(0, d.indexOf('.')), d.slice(d.indexOf('.') + 1)] as const;
    for (const target of TYPO_NAMES) { const [name, suffix] = split(target); for (const v of oneEdit(name)) if (!map.has(`${v}.${suffix}`)) map.set(`${v}.${suffix}`, target); }
    for (const target of TYPO_SUFFIXES) { const [name, suffix] = split(target); for (const v of oneEdit(suffix)) if (!map.has(`${name}.${v}`)) map.set(`${name}.${v}`, target); }
    for (const real of [...PUBLIC_MAILBOXES, ...TYPO_SUFFIXES, ...NOT_TYPOS]) map.delete(real);
    typos = map;
  }
  return typos.get(domain) ?? null;
}

// RFC 2142 and no-reply mailboxes: nobody subscribes from them, and mail there reaches the people who report abuse.
const ROLES = new Set('abuse postmaster hostmaster mailer-daemon noc noreply no-reply no_reply donotreply do-not-reply do_not_reply nobody devnull spam usenet uucp'.split(' '));

export type Classified = { risk: Exclude<Risk, 'dead'>; suggestion: string | null };
/** What the address alone says. dead needs the database: riskSql, and the hourly pass. */
export function classifyAddress(email: string): Classified | null {
  if (!validAddress(email)) return { risk: 'invalid', suggestion: null };
  const at = email.lastIndexOf('@'), local = email.slice(0, at), domain = email.slice(at + 1).toLowerCase();
  // A provider's typo first, with the address it meant: the list carries some of them (gmial.com), set up to catch it.
  const fix = typoOf(domain);
  if (fix) return { risk: 'typo_domain', suggestion: `${local}@${fix}` };
  if (isDisposableDomain(domain)) return { risk: 'disposable', suggestion: null };
  const plus = local.indexOf('+'), mailbox = (plus > 0 ? local.slice(0, plus) : local).toLowerCase();
  if (ROLES.has(mailbox)) return { risk: 'role', suggestion: null };
  return null;
}

/** An address that hard-bounced in another workspace in the last year (migration 498's partial index). */
export const bouncedElsewhere = (email: SQL, workspaceId: SQL) => sql`EXISTS (SELECT 1 FROM audience_contacts b WHERE b.email = ${email} AND b.suppressed
  AND b.suppression_reason = 'hard_bounce' AND b.workspace_id <> ${workspaceId} AND b.suppressed_at > now() - interval '365 days')`;
/** The risk a new contact is stored with: what the address says, else dead when it bounced elsewhere. */
export const riskSql = (email: string, workspaceId: string) => {
  const own = classifyAddress(email);
  return own ? sql`${own.risk}::text` : sql`CASE WHEN ${bouncedElsewhere(sql`${email}::text`, sql`${workspaceId}::text`)} THEN 'dead' END`;
};
/** A contact campaigns and marketing sends skip: flagged, and not allowed by its owner. */
export const skippedRisk = (risk: SQL, allowed: SQL) => sql`(${risk} IS NOT NULL AND NOT ${allowed})`;

/** The contact's risk as the API shows it. */
export function contactRisk(row: { email: string; risk: string | null; riskAllowed: boolean }) {
  if (!row.risk || !(RISKS as readonly string[]).includes(row.risk)) return null;
  const reason = row.risk as Risk;
  return { reason, suggestion: reason === 'typo_domain' ? classifyAddress(row.email)?.suggestion ?? null : null, allowed: row.riskAllowed };
}
export type RiskCounts = Record<Risk, number>;
export const noRisks = (): RiskCounts => ({ invalid: 0, disposable: 0, typo_domain: 0, role: 0, dead: 0 });
/** Counts by reason, from rows of (risk, count). */
export function riskCounts(rows: { risk: string | null; count: number }[]) {
  const byReason = noRisks();
  let total = 0;
  for (const row of rows) if (row.risk && row.risk in byReason) { byReason[row.risk as Risk] += Number(row.count); total += Number(row.count); }
  return { total, byReason };
}

// ----- The hourly pass ---------------------------------------------------------------------------------------------------
// Every contact, in ID order across workspaces, a bounded slice an hour: a contact created before this existed, one whose
// address another workspace has since hard-bounced, and every contact again when the vendored list or a rule changes
// (HYGIENE_VERSION). A full pass starts again a day after the last one finished. Only changed rows are written, risk alone:
// a contact's updated_at is its owner's edits. A row another statement holds is skipped until the next pass, so the pass
// never waits on an import or the feedback batch, and a changed risk clears its owner's allowance (it was for another reason).
const PASS = { batch: 5000, leaseMinutes: 10, statementSeconds: 15, everyHours: 24 } as const;
export async function classifyContacts(runtime: Pick<Runtime, 'db'>, budgetMs = 45_000, clock = Date.now) {
  const until = clock() + budgetMs, db = runtime.db;
  const restart = sql`s.version IS DISTINCT FROM excluded.version OR (s.cursor IS NULL AND s.finished_at < now() - make_interval(hours => ${PASS.everyHours}))`;
  const { rows: [state] } = await db.execute<{ cursor: string | null }>(sql`INSERT INTO audience_hygiene_state AS s (id, version, cursor, started_at, lease_until)
    VALUES ('contacts', ${HYGIENE_VERSION}, '', now(), now() + make_interval(mins => ${PASS.leaseMinutes}))
    ON CONFLICT (id) DO UPDATE SET lease_until = excluded.lease_until, version = excluded.version,
      cursor = CASE WHEN ${restart} THEN '' ELSE s.cursor END, started_at = CASE WHEN ${restart} THEN now() ELSE s.started_at END
    WHERE s.lease_until IS NULL OR s.lease_until <= now()
    RETURNING cursor`);
  if (!state) return null;
  let cursor = state.cursor, read = 0, changed = 0, skipped = 0;
  try {
    while (cursor !== null && clock() < until) {
      const after = cursor;
      const step = await db.transaction(async tx => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${PASS.statementSeconds}s'`));
        const { rows } = await tx.execute<{ id: string; workspace_id: string; email: string; risk: string | null; dead: boolean }>(sql`SELECT c.id, c.workspace_id, c.email, c.risk,
            ${bouncedElsewhere(sql`c.email`, sql`c.workspace_id`)} AS dead
          FROM audience_contacts c WHERE c.id > ${after} AND c.deleted_at IS NULL ORDER BY c.id LIMIT ${PASS.batch}`);
        const changes = rows.flatMap(row => {
          const risk = classifyAddress(row.email)?.risk ?? (row.dead ? 'dead' : null);
          return risk === row.risk ? [] : [{ id: row.id, workspace_id: row.workspace_id, old: row.risk, risk }];
        });
        let written = 0;
        if (changes.length) {
          const result = await tx.execute(sql`WITH want AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb) AS w(id text, workspace_id text, old text, risk text)),
            locked AS (SELECT t.workspace_id, t.id, w.risk FROM audience_contacts t JOIN want w ON t.workspace_id = w.workspace_id AND t.id = w.id
              WHERE t.risk IS NOT DISTINCT FROM w.old AND t.deleted_at IS NULL FOR UPDATE OF t SKIP LOCKED)
            UPDATE audience_contacts t SET risk = l.risk, risk_allowed = false FROM locked l WHERE t.workspace_id = l.workspace_id AND t.id = l.id`);
          written = result.rowCount ?? 0;
        }
        const next = rows.length < PASS.batch ? null : rows[rows.length - 1]!.id;
        await tx.execute(next === null
          ? sql`UPDATE audience_hygiene_state SET cursor = NULL, finished_at = now() WHERE id = 'contacts'`
          : sql`UPDATE audience_hygiene_state SET cursor = ${next} WHERE id = 'contacts'`);
        return { next, read: rows.length, changes: changes.length, written };
      });
      cursor = step.next; read += step.read; changed += step.written; skipped += step.changes - step.written;
    }
  } catch (error) {
    logError(error, { code: 'AUDIENCE_HYGIENE_FAILED' }, 'warn');
  } finally {
    await db.execute(sql`UPDATE audience_hygiene_state SET lease_until = NULL WHERE id = 'contacts'`).catch(() => {});
  }
  if (read) log('info', { code: 'AUDIENCE_HYGIENE_PASS', version: HYGIENE_VERSION, read, changed, skipped, finished: cursor === null });
  return { read, changed, skipped, finished: cursor === null };
}
