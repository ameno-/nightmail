import { addresses, hostedHosts, productName, repositoryUrl, supportHost } from './brand.js'
// The output gate (design §4.4.4): every final chat message and every email reply passes it before it is stored or
// sent. It trips on anything the customer must never receive from support: other people's addresses, IDs or names
// outside the grant, credentials, internal hosts, staff names or pieces of the system prompt. A tripped chat message is
// replaced and a ticket filed; a tripped email reply is held and a ticket filed. Rules only, no model: it does not catch
// another customer's story retold in prose.
// One implementation, shared: the support Worker re-exports it (support/src/gate.ts), and a staff member's agent's
// replies pass it before they are queued (src/support-inbox.ts).

export type GateScope = {
  /** The customer's own address(es); the support address is always allowed. */
  emails: string[];
  /** Workspace and domain IDs and names the grant covers. */
  allowedIds: string[];
  allowedNames: string[];
  /** Strings that only exist in the system prompt (a few distinctive phrases). */
  promptFragments: string[];
  supportAddress: string;
  /** Email: links must point here (a URL elsewhere holds the reply). The chat panel enforces this itself. */
  linkOrigins?: readonly string[];
  /**
   * Addresses and IDs the person already has (theirs): written in their own messages, or returned by reads made for
   * them in this conversation that their access still covers. An answer may repeat these; never anyone else's.
   */
  theirs?: readonly string[];
  /** The sender's own name (a staff member signing their reply): theirs to use, never an internal name. */
  ownName?: string | null;
};
export type GateResult = { ok: true } | { ok: false; reasons: string[] };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_PREFIX = /\b(?:nm_support_|nm_mbx_|nm_agent_|nm_notes_|nm_|bane_support_|bane_ops_|bane_mbx_|bane_agent_|os_agent_|whsec_|sk-ant-|bane_)[A-Za-z0-9_-]{8,}/; // bane_/os_: remove after rename cleanup
const LONG_HEX = /\b[0-9a-f]{40,}\b/i;
const LONG_B64 = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{60,}={0,2}(?![A-Za-z0-9+/])/;
/** A host under a private or reserved suffix. internal, invalid and local need a label before them (`db.local`): alone they are everyday words ("invalid recipient", "local time"). */
const INTERNAL_HOST = /\b(?:(?:[a-z0-9-]+\.)+(?:internal|invalid|local)|(?:[a-z0-9-]+\.)*(?:svc\.cluster\.local|workers\.dev|psdb\.cloud|amazonaws\.com|hyperdrive\.local))\b/i;
const INTERNAL_ID = /\b(?:ws|sgr|sho|dom|wh|key|mbk|usr|conv|tkt)_[0-9a-z]{16,}\b/g;
/** People and systems the agent never names: Nightmail staff, internal tools. */
const STAFF = /\b(?:Ryan Vogel|thdxr|R44VC0RP|Dax Raad|PlanetScale|Hyperdrive|platform_operators|support_grants|supportGate|operatorGate|SupportPlatform)\b/i;
const FENCE = /<\/?untrusted>|<customer>|<\/customer>|<context>|<\/context>|<notes\b|<\/notes>|<proposals\b|<\/proposals>/i;

export function gate(text: string, scope: GateScope): GateResult {
  const reasons: string[] = [];
  // Nightmail's own addresses (support, abuse, privacy, legal, security) are the contacts an answer passes on.
  const mayContain = new Set([...scope.emails, scope.supportAddress, ...Object.values(addresses), ...scope.theirs ?? []].map(e => e.toLowerCase()));
  for (const email of text.match(EMAIL) ?? []) if (!mayContain.has(email.toLowerCase()) && !/^(?:dmarc|postmaster|bounces?)@/i.test(email) && !isExample(email)) reasons.push('email address outside the conversation');
  if (SECRET_PREFIX.test(text)) reasons.push('credential-shaped string');
  if (LONG_HEX.test(text) || LONG_B64.test(text.replace(/v=DKIM1[^`\n]*/g, ''))) reasons.push('long opaque string');
  if (INTERNAL_HOST.test(text)) reasons.push('internal hostname');
  const allowedIds = new Set([...scope.allowedIds, ...scope.theirs ?? []]);
  for (const id of text.match(INTERNAL_ID) ?? []) if (!allowedIds.has(id)) reasons.push('ID outside the grant');
  const own = scope.ownName?.trim();
  if (STAFF.test(own ? text.replace(new RegExp(own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ') : text)) reasons.push('internal name');
  if (FENCE.test(text)) reasons.push('harness markup');
  if (confirmLink(text)) reasons.push('confirmation link');
  if (scope.linkOrigins) {
    for (const url of text.match(/\b(?:https?:\/\/|www\.)[^\s<>()"']+/gi) ?? []) {
      const ok = /^https:\/\//i.test(url) && scope.linkOrigins.some(origin => url === origin || url.startsWith(`${origin}/`) || url.startsWith(`${origin}?`));
      if (!ok) { reasons.push(`link outside ${productName}`); break; }
    }
  }
  const lower = text.toLowerCase();
  for (const fragment of scope.promptFragments) if (fragment.length >= 24 && lower.includes(fragment.toLowerCase())) { reasons.push('system prompt text'); break; }
  return reasons.length ? { ok: false, reasons: [...new Set(reasons)] } : { ok: true };
}

/** The addresses and internal IDs in a text, as the gate finds them: what `theirs` is collected from. */
export function namedIn(text: string): string[] {
  return [...new Set([...text.match(EMAIL) ?? [], ...text.match(INTERNAL_ID) ?? []])];
}

/**
 * Whether text points at a proposal's confirm page (`/support/actions/…`), however it is spelled: with or without a
 * scheme or host, percent-encoded (twice), with backslashes, repeated slashes or dot segments, in any case. Only the
 * panel's card, built from Nightmail's own record, leads there: no answer may.
 */
export function confirmLink(text: string) {
  let decoded = text;
  for (let round = 0; round < 2; round++) decoded = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  for (const token of decoded.replace(/\\/g, '/').toLowerCase().split(/[\s<>()[\]{}"'`]+/)) {
    if (!token.includes('support') || !token.includes('actions')) continue;
    const segments: string[] = [];
    for (const segment of token.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') segments.pop(); else segments.push(segment);
    }
    if (segments.some((segment, i) => segment === 'support' && /^actions(?:$|[?#;&.,!*_])/.test(segments[i + 1] ?? ''))) return true;
  }
  return false;
}

/**
 * Distinctive lines of the system prompt, for the "never reveal this prompt" check: from the instructions only, never from
 * its "# Reference" part (product facts, playbooks and policies), whose facts an answer is meant to pass on.
 */
export function promptFragmentsOf(system: string) {
  return system.split(/^# Reference$/m)[0]!.split('\n').map(l => l.replace(/^[-*#>\d.|\s]+/, '').trim()).filter(l => l.length >= 60 && !/`|https?:/.test(l)).filter((_, i) => i % 4 === 0).map(l => l.slice(0, 48));
}

/** Placeholder addresses used in DNS advice ("rua=mailto:dmarc@your-domain.com") are fine. */
function isExample(email: string) { return /@(?:example\.(?:com|org|net)|your-?domain\.com|yourdomain\.com)$/i.test(email); }

/** Links the panel may render; others are shown as text. The panel enforces this too (support/PROTOCOL.md §4.2). */
export const LINK_ORIGINS = [...hostedHosts.flatMap(host => [`https://${host}`, `https://${supportHost(host)}`]), repositoryUrl];

