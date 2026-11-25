/**
 * Customers' link hosts (src/link-domains.ts): each sending domain's links.<domain>, a CNAME into this installation's
 * Cloudflare for SaaS zone, which Cloudflare routes to the Worker (a `*\/*` route on that zone). Such a host answers the
 * links in customer mail and nothing else: no dashboard, API, docs or redirect to this installation's own domain on a
 * name customer mail carries. No imports, so the Worker decides before it loads the API.
 */
/** The label of a domain's link host. */
export const LINK_LABEL = 'links';
// Unsubscribe links (the page and the one-click POST), forwarding's confirm and stop pages, linked images (/i/), and the
// fonts the unsubscribe page uses. One segment after each prefix: nothing else is a link.
const LINK_PATH = /^\/(?:unsubscribe|v1\/forwarding\/(?:confirm|stop)|i|fonts)\/[^/]+$/;

/**
 * How the Worker answers a request on `host`. `other`: one of this installation's own hosts (`own`), or link hosts are
 * off. `link`: a link on a customer's link host, for the API's handlers (never the dashboard's shell). `missing`:
 * anything else there. With link hosts on, every host that is none of `own` came through the SaaS zone.
 */
export function linkHostRequest(enabled: boolean, host: string, path: string, own: readonly string[]): 'other' | 'link' | 'missing' {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (!enabled || own.includes(name) || ['localhost', '127.0.0.1', '[::1]'].includes(name)) return 'other';
  return LINK_PATH.test(path) ? 'link' : 'missing';
}
