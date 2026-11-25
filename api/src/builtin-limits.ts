import { productName } from './brand.js';

/**
 * What a built-in domain (builtin-domain.ts) may send, in words and numbers, without runtime imports so the dashboard
 * and the docs say the same as the API: refusals, GET /v1/domains/{id} limits, the agent prompt and the Docs guide.
 */
/** Recipient caps by NIGHTMAIL_BUILTIN_SEND_SCOPE (SEND_LIMITS.builtin). */
export const BUILTIN_CAPS = { anyone: { perDay: 100, perMinute: 10 }, members: { perDay: 10, perMinute: 3 } } as const;
export type BuiltinScope = keyof typeof BUILTIN_CAPS;
/** The request fields a send from a built-in domain can't use, in the order a refusal lists them. */
export const BUILTIN_UNSUPPORTED = ['from', 'replyTo', 'headers', 'attachments', 'template', 'scheduledAt', 'kind', 'campaign'] as const;
export type BuiltinUnsupported = typeof BUILTIN_UNSUPPORTED[number];
/** Each field's words in a refusal: "it uses custom headers and attachments". */
export const BUILTIN_UNSUPPORTED_WORDS: Record<BuiltinUnsupported, string> = { from: 'a subdomain of it as From', replyTo: 'a Reply-To elsewhere', headers: 'custom headers',
  attachments: 'attachments', template: 'a stored template', scheduledAt: 'scheduling', kind: 'kind: marketing', campaign: 'a campaign' };
const count = (n: number) => n.toLocaleString('en-US');
/** The limits in one sentence. */
export function builtinLimitsText(scope: BuiltinScope = 'anyone') {
  const caps = BUILTIN_CAPS[scope];
  return `Built-in domains send plain transactional mail: no Reply-To elsewhere, custom headers, attachments, stored templates, scheduling, marketing or campaigns, ${scope === 'members'
    ? `only to the workspace members’ verified addresses, up to ${count(caps.perDay)} a day` : `up to ${count(caps.perDay)} recipients a day`} (${count(caps.perMinute)} a minute). Add your own domain to use them.`;
}
/** The Docs guide (dashboard /docs/built-in-domain) and the API's /docs.md and /llms.txt. */
export const builtinDomainGuide = {
  id: 'built-in-domain',
  title: 'Send from the built-in domain',
  summary: 'What the domain every Hosted workspace starts with can send, and what it refuses.',
  text: `Every Hosted workspace starts with a domain of its own, such as acme-k7.nightmail.email: Domains lists it as Built-in, and connection.builtinDomain in GET /v1/me and limits in GET /v1/domains/{id} describe it. It needs no DNS and sends at once. ${builtinLimitsText()} `
    + 'A send that uses any of those is refused once, with 422 BUILTIN_DOMAIN_UNSUPPORTED naming every field it used in error.details[0].unsupported (for example ["replyTo","headers","attachments"]); past a cap it is 429 BUILTIN_DOMAIN_LIMIT with resetAt. '
    + `It receives at every address: mail to an address without an inbox or route of its own goes to its default inbox, hello@ the domain, and replies from there (POST /v1/inbound/threads/{threadId}/reply) count toward the same caps. Once a domain of the workspace’s own verifies, the built-in domain stops sending and keeps receiving: a send from it then gets 409 OWN_DOMAIN_VERIFIED with the same address at your own domain in error.details[0].suggestedFrom (every verified domain in verifiedDomains), so switch From to your own domain as soon as it verifies. ${productName} may turn one off for abuse.`,
};
