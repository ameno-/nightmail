// The brand's stamp in a browser tab, for this Worker's own pages (the page an old confirm link opens). They are on their
// own origin, so the Worker serves the icon itself: the same files as the dashboard's app/public/favicon.svg and
// favicon-dark.svg (docs/brand.md: keep them the same), the stamp's small drawing in the set's ink for a browser's pale
// theme and its paper for its dark one.
const OUTLINE = 'M0,824.3c34,-7.6 59.5,-38 59.5,-74.3c0,-36.3 -25.4,-66.7 -59.5,-74.3l0,-101.3c34,-7.6 59.5,-38 59.5,-74.3c0,-36.3 -25.4,-66.7 -59.5,-74.3l0,-101.3c34,-7.6 59.5,-38 59.5,-74.3c0,-36.3 -25.4,-66.7 -59.5,-74.3l0,-101.3c18.3,-4.1 34.1,-14.8 44.9,-29.5c14.7,-10.7 25.4,-26.5 29.5,-44.9l101.3,0c7.6,34 38,59.5 74.3,59.5c36.3,0 66.7,-25.4 74.3,-59.5l101.3,0c7.6,34 38,59.5 74.3,59.5c36.3,0 66.7,-25.4 74.3,-59.5l101.3,0c7.6,34 38,59.5 74.3,59.5c36.3,0 66.7,-25.4 74.3,-59.5l101.3,0c4.1,18.3 14.8,34.1 29.5,44.9c10.7,14.7 26.5,25.4 44.9,29.5v101.3c-34,7.6 -59.5,38 -59.5,74.3c0,36.3 25.4,66.7 59.5,74.3v101.3c-34,7.6 -59.5,38 -59.5,74.3c0,36.3 25.4,66.7 59.5,74.3v101.3c-34,7.6 -59.5,38 -59.5,74.3c0,36.3 25.4,66.7 59.5,74.3l0,101.3c-18.3,4.1 -34.1,14.8 -44.9,29.5c-14.7,10.7 -25.4,26.5 -29.5,44.9h-101.3c-7.6,-34 -38,-59.5 -74.3,-59.5c-36.3,0 -66.7,25.4 -74.3,59.5l-101.3,0c-7.6,-34 -38,-59.5 -74.3,-59.5c-36.3,0 -66.7,25.4 -74.3,59.5h-101.3c-7.6,-34 -38,-59.5 -74.3,-59.5c-36.3,0 -66.7,25.4 -74.3,59.5h-101.3c-4.1,-18.3 -14.8,-34.1 -29.5,-44.9c-4,-5.5 -8.7,-10.4 -14,-14.6c-8.9,-7.1 -19.4,-12.3 -30.9,-14.9zM877.5,877.5v-755.1h-755.1v755.1zM666.1,265.1c121.8,104 136.2,287 32.2,408.9c-104,121.8 -287,136.2 -408.9,32.2c-29.4,-25.1 -52.6,-54.9 -69.3,-87.2c108.1,33 230.3,1.4 308.4,-90c78.1,-91.4 90.1,-217.1 40.6,-318.7c34.6,11.5 67.6,29.7 97,54.8z';
const stamp = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="16" height="16" fill="none" role="img" aria-label="Nightmail"><path fill="${fill}" fill-rule="evenodd" d="${OUTLINE}"/></svg>`;
const FILES: Record<string, string> = { '/favicon.svg': stamp('#0a0a0a'), '/favicon-dark.svg': stamp('#fafafa') };

/** For a page's head. (Its policy must let it load an image from this origin: img-src 'self'.) */
export const FAVICON_LINKS = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" media="(prefers-color-scheme: light)"><link rel="icon" type="image/svg+xml" href="/favicon-dark.svg" media="(prefers-color-scheme: dark)">';

/** The icon at `path`, or null where the path is not one. */
export function favicon(path: string): Response | null {
  const file = Object.hasOwn(FILES, path) ? FILES[path] : null;
  return file ? new Response(file, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff' } }) : null;
}
