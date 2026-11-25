import { addresses, productName } from './brand.js';

/**
 * The hosts that carry the links in customer mail (src/link-domains.ts): the shared link domain (NIGHTMAIL_LINK_DOMAIN),
 * its edge.<domain> name that customers' CNAMEs point at, and with Cloudflare for SaaS every customer's own
 * links.<domain>, which reaches the Worker through the link domain's zone. A link host answers those links and nothing
 * else: no dashboard, API or docs on a name that customer mail carries. No imports beyond brand.ts, so the Worker can
 * decide before it loads the API.
 */
export type LinkHostSettings = { domain: string; saas?: unknown };
/** The label of a customer's link host under its domain, and of the name its CNAME points at under the link domain. */
export const LINK_LABEL = 'links', EDGE_LABEL = 'edge';
// Unsubscribe links (GET page and one-click POST), forwarding's confirm and stop pages, linked images (/i/), and the
// fonts the unsubscribe page uses. One segment after each prefix: nothing else is a link.
const LINK_PATH = /^\/(?:unsubscribe|v1\/forwarding\/(?:confirm|stop)|i|fonts)\/[^/]+$/;

/**
 * How a request on `host` is answered. `other`: not on a link host. `link`: a link on one, for the API's handlers (never
 * the dashboard's shell). `root`: a link host's own page. `missing`: anything else on a link host. `foreign`: whether a
 * host that is none of `own` came through the link domain's SaaS zone, which only the Worker can say (Cloudflare routes
 * every custom hostname to it); the Node server matches the link domain's names alone.
 */
export function linkHostRequest(settings: LinkHostSettings | undefined, host: string, path: string, foreign?: { own: string[] }): 'other' | 'link' | 'root' | 'missing' {
  if (!settings) return 'other';
  const name = host.toLowerCase().replace(/\.$/, '');
  const link = name === settings.domain || name === `${EDGE_LABEL}.${settings.domain}`
    || (!!settings.saas && !!foreign && !foreign.own.includes(name) && !['localhost', '127.0.0.1', '[::1]'].includes(name));
  if (!link) return 'other';
  if (path === '/') return 'root';
  return LINK_PATH.test(path) ? 'link' : 'missing';
}

/** A link host's own page: what the name is, and where to report abuse. */
export function linkHostPage(): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Email links</title><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;margin:48px;line-height:1.5;max-width:36rem"><main><h1 style="font-size:24px">Email links</h1><p>This address carries the unsubscribe and other links in email sent through ${productName}. Each link works only from the email it came in.</p><p>To report abuse, write to <a href="mailto:${addresses.abuse}">${addresses.abuse}</a>.</p></main></body></html>`;
}
