// Builds the brand files in public/ that are made from others (docs/brand.md):
// - favicon.ico, packed from the two hand-cut tiles in public/brand/ (favicon-16.png and favicon-32.png);
// - the manifest icons (192, 512 and a maskable 512), drawn from public/brand/nightmail-monogram.svg: the NM in the
//   brand's paper on a full square of its ink, as apple-touch-icon.png has it (the maskable one at eight tenths, so
//   the NM keeps inside the circle every launcher shows);
// - the 1200 × 630 link-preview card og.png.
// favicon.svg, favicon-dark.svg and apple-touch-icon.png are the final vector set's own files, copied in as they are.
// Run from app/ after changing a mark: node scripts/brand-assets.mjs. It uses Playwright's own headless Chromium
// (npx playwright-core install chromium-headless-shell), never the installed Chrome; BRAND_CHROME=<path> picks another build.
//
// og.png is the homepage itself: the built dashboard (bun run build first) is served from dist/ with the two requests a
// signed-out visit makes answered here, the sorter runs until it has burst and come to rest, and the card is the part of
// that frame with the wordmark in lights, the price and the line under it, the lockup set beside it from the page's own
// outlines. BRAND_ONLY=og writes only the card, BRAND_ONLY=icons everything but the card (no build needed).
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const brand = name => join(publicDir, 'brand', name);
const INK = '#0A0B0F', PAPER = '#F4F2EC';

// The monogram's file is the tile with the NM cut out of it: its second outline is the NM alone. An icon is that NM in
// paper on a square of ink, the tile's own proportions at `scale` 1 (the NM eight tenths of the side across).
const nm = (() => { const d = readFileSync(brand('nightmail-monogram.svg'), 'utf8').match(/ d="([^"]+)"/)[1], cut = d.indexOf('Z') + 1; if (!cut || !d.startsWith('M', cut)) throw Error('nightmail-monogram.svg is not a tile and one outline cut from it'); return d.slice(cut) })();
const icon = (size, scale) => `<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${INK}">
  <svg viewBox="0 0 1000 1000" style="display:block;width:${size * scale}px;height:${size * scale}px"><path fill="${PAPER}" d="${nm}"/></svg></body>`;

// The link-preview card. The page is laid out for a 1440 × 900 window at night; the card is 800 by 420 of its pixels,
// photographed at one and a half times (so 1200 × 630 exactly), ending just right of the cabinet's riser and at the foot of the headline's band.
// What is too small to read on a card (the lane plates) is hidden, and the lockup stands in the space to the left: the
// monogram's tile from the page's header and, one stem to its right, the wordmark as the page's last band draws it.
async function sorterCard(browser) {
  const dist = resolve(publicDir, '../dist');
  if (!existsSync(join(dist, 'index.html'))) throw Error('og.png is photographed from the built dashboard: run `bun run build` in app/ first');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname, file = join(dist, path);
    // (The two requests a signed-out visit makes: who is this, and does this installation have a public homepage.)
    if (path === '/v1/me') { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'Sign in.' } })); return }
    if (path === '/health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ multiTenant: true })); return }
    const found = file.startsWith(dist) && extname(path) && existsSync(file) ? file : path.startsWith('/v1/') || path.startsWith('/api/') || extname(path) ? null : join(dist, 'index.html');
    if (!found) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'content-type': types[extname(found)] ?? 'application/octet-stream' }); response.end(readFileSync(found));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const across = 800, scale = 1200 / across;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scale, colorScheme: 'dark' });
  try {
    // Night, and the shorter day of a returning visitor.
    await context.addInitScript(() => { localStorage.setItem('bane.theme', 'dark'); localStorage.setItem('sorter.seen', '1') });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.querySelector('.srt-page')?.dataset.phase === 'rest', null, { timeout: 90_000 });
    // The smoke clears and the last letters settle.
    await page.waitForTimeout(7000);
    const clip = await page.evaluate(across => {
      const band = document.querySelector('.srt-band').getBoundingClientRect(), u = band.width / 48, height = across * 630 / 1200;
      // (The cabinet's riser ends 38.4 cells right of the page's middle; the headline's band ends the card.)
      const x = Math.round(band.left + band.width / 2 + 39.4 * u - across), y = Math.round(band.bottom + 2 - height);
      const style = document.createElement('style');
      style.textContent = '.srt-lanes, .srt-card, .srt-cannon { visibility: hidden !important }';
      document.head.append(style);
      // (Cap height 15 px of the page, so 22.5 on the card: the lockup ends well short of the cabinet's front.)
      const svg = 'http://www.w3.org/2000/svg', mark = document.createElementNS(svg, 'svg'), cap = 15;
      mark.setAttribute('viewBox', '0 0 12120 1000');
      mark.style.cssText = `position: fixed; z-index: 99; left: ${x + 26}px; top: ${y + 26}px; width: ${cap * 12.12}px; height: ${cap}px; fill: var(--srt-name)`;
      for (const [from, dx] of [['.srt-mark path', 0], ['.srt-solid-face', 1320]]) { const path = document.createElementNS(svg, 'path'); path.setAttribute('d', document.querySelector(from).getAttribute('d')); path.setAttribute('transform', `translate(${dx} 0)`); mark.append(path) }
      document.querySelector('.srt-page').append(mark);
      return { x, y, width: across, height };
    }, across);
    const data = await page.screenshot({ clip });
    if (data.readUInt32BE(16) !== 1200 || data.readUInt32BE(20) !== 630) throw Error(`og.png came out ${data.readUInt32BE(16)} × ${data.readUInt32BE(20)}, not 1200 × 630`);
    return data;
  } finally { await context.close(); server.close(); }
}

// ICO with PNG entries (read by every current browser and Windows since Vista).
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at); header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map(p => p.data)]);
}

const browser = await chromium.launch({ headless: true, ...process.env.BRAND_CHROME && { executablePath: process.env.BRAND_CHROME }, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  if (process.env.BRAND_ONLY !== 'icons') writeFileSync(join(publicDir, 'og.png'), await sorterCard(browser));
  if (process.env.BRAND_ONLY !== 'og') {
    const shot = async (html, size) => {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await page.setContent(html); const data = await page.screenshot(); await page.close(); return data;
    };
    writeFileSync(join(publicDir, 'favicon.ico'), ico([16, 32].map(size => ({ size, data: readFileSync(brand(`favicon-${size}.png`)) }))));
    writeFileSync(join(publicDir, 'icon-192.png'), await shot(icon(192, 1), 192));
    writeFileSync(join(publicDir, 'icon-512.png'), await shot(icon(512, 1), 512));
    writeFileSync(join(publicDir, 'icon-maskable-512.png'), await shot(icon(512, .8), 512));
  }
} finally { await browser.close(); }
