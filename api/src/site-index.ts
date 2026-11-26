// The website's own pages in /llms.txt: the dashboard build lists them in llms-site.txt (app/price-pages.ts: the product,
// the price calculator and every comparison, as Markdown), and the Worker (src/worker.ts) and the Node server
// (src/server.ts) put that under llms.txt's title and summary, before the API's own sections (openapi-docs.ts,
// createLlmsText). Without a dashboard build, llms.txt is the API's alone. No imports: the Worker loads it eagerly.

/** The build's file with the site's lines for llms.txt. */
export const SITE_INDEX = '/llms-site.txt';
/** Where a page under /compare/ that the build didn't make is: nowhere (404), never the dashboard. */
export const isMissingComparePage = (pathname: string) => pathname === '/compare' || pathname.startsWith('/compare/');
/** Where a reference page the build didn't make is (app/docs-pages.ts writes one per operation): not found, rather than
 *  the docs' "Page not found" with 200, which search engines count as a soft 404. */
export const isMissingDocsPage = (pathname: string) => pathname.startsWith('/docs/api/');

export function withSiteIndex(llms: string, site: string): string {
  const lines = site.trim();
  if (!lines) return llms;
  const at = llms.indexOf('\n## ');
  return at < 0 ? `${llms.trimEnd()}\n\n${lines}\n` : `${llms.slice(0, at + 1)}${lines}\n\n${llms.slice(at + 1)}`;
}
