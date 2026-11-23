// The brand's tab icon, for this Worker's own pages (the page an old confirm link opens). They are on their own origin,
// so the Worker serves the icon itself: the same files as the dashboard's app/public/favicon.svg and favicon-dark.svg
// (made by app/scripts/brand-assets.mjs; docs/brand.md: keep them the same), the stamp's crescent on a rounded tile, a
// paper moon on ink for a browser's pale theme and an ink moon on paper for its dark one.
const MOON = 'M666.1,265.1c121.8,104 136.2,287 32.2,408.9c-104,121.8 -287,136.2 -408.9,32.2c-29.4,-25.1 -52.6,-54.9 -69.3,-87.2c108.1,33 230.3,1.4 308.4,-90c78.1,-91.4 90.1,-217.1 40.6,-318.7c34.6,11.5 67.6,29.7 97,54.8z';
const icon = (tile: string, moon: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" role="img" aria-label="Nightmail"><rect width="16" height="16" rx="3" fill="${tile}"/><path fill="${moon}" transform="translate(-1.611 -1.591) scale(0.019455)" d="${MOON}"/></svg>`;
const FILES: Record<string, string> = { '/favicon.svg': icon('#0a0a0a', '#fafafa'), '/favicon-dark.svg': icon('#fafafa', '#0a0a0a') };

/** For a page's head. (Its policy must let it load an image from this origin: img-src 'self'.) */
export const FAVICON_LINKS = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" media="(prefers-color-scheme: light)"><link rel="icon" type="image/svg+xml" href="/favicon-dark.svg" media="(prefers-color-scheme: dark)">';

/** The icon at `path`, or null where the path is not one. */
export function favicon(path: string): Response | null {
  const file = Object.hasOwn(FILES, path) ? FILES[path] : null;
  return file ? new Response(file, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff' } }) : null;
}
