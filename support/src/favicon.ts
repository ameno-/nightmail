// The brand's tile in a browser tab, for this Worker's own pages (the confirmation page and the staff console). They are
// on their own origin, so the Worker serves the icon itself: the same drawing as the dashboard's app/public/favicon.svg
// and favicon-dark.svg (docs/brand.md: keep them the same), ink for a browser's pale theme and paper for its dark one.
const OUTLINE = 'M40 0H280C302 0 320 18 320 40V280C320 302 302 320 280 320H40C18 320 0 302 0 280V40C0 18 18 0 40 0ZM30 220H70V140L110 220H170V180L190 220H230L250 180V220H290V100H250L210 180L170 100H130V180L90 100H30V220Z';
const tile = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 320 320"><path fill="${fill}" d="${OUTLINE}"/></svg>`;
const FILES: Record<string, string> = { '/favicon.svg': tile('#0A0B0F'), '/favicon-dark.svg': tile('#F4F2EC') };

/** For a page's head. (Its policy must let it load an image from this origin: img-src 'self'.) */
export const FAVICON_LINKS = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" media="(prefers-color-scheme: light)"><link rel="icon" type="image/svg+xml" href="/favicon-dark.svg" media="(prefers-color-scheme: dark)">';

/** The icon at `path`, or null where the path is not one. */
export function favicon(path: string): Response | null {
  const file = Object.hasOwn(FILES, path) ? FILES[path] : null;
  return file ? new Response(file, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff' } }) : null;
}
