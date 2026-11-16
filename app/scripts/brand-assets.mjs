// Builds the brand files in public/ from the outlined SVGs in public/brand/ (docs/brand.md): favicon.svg, favicon.ico (16,
// 32 and 48 px), apple-touch-icon.png, the manifest icons (192, 512 and a maskable 512) and the 1200 × 630 link-preview card
// og.png. Run from app/ after changing the mark: node scripts/brand-assets.mjs (BRAND_CHROME=<path> to pick Chrome).
//
// og.png is the homepage itself: the built dashboard (bun run build first) is served from dist/ with the two requests a
// signed-out visit makes answered here, the sorter runs until it has burst and come to rest, and the card is the part of
// that frame with the wordmark in lights, the price and the line under it, the lockup set beside it from the page's own
// outlines. BRAND_ONLY=og writes only the card.
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const svg = name => readFileSync(join(publicDir, 'brand', name), 'utf8');
const inline = name => svg(name).replace(/ width="[^"]*" height="[^"]*"/, ' width="100%" height="100%"');
const canvas = '#FAFAFA';

// The mark on a square: `scale` is its share of the side (the maskable icon keeps it inside the central safe circle).
const tile = (size, scale, background) => `<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${background}">
  <div style="width:${size * scale}px;height:${size * scale}px">${inline('bane-mark.svg')}</div></body>`;

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

const browser = await chromium.launch({ executablePath: process.env.BRAND_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  writeFileSync(join(publicDir, 'og.png'), await sorterCard(browser));
  if (process.env.BRAND_ONLY !== 'og') {
  const shot = async (html, width, height, omitBackground = false) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html); await page.evaluate(() => document.fonts.ready);
    const data = await page.screenshot({ omitBackground }); await page.close(); return data;
  };
  // Favicon sizes snap the mark's four inner squares to whole pixels, so the frame and rings stay crisp at 16 px.
  const snap = (mark, size) => mark.replace(/M(\d+(?:\.\d+)?) \1L(\d+(?:\.\d+)?) \1L\2 \2L\1 \2Z/g, (_, a) => {
    const i = Math.round(Number(a) * size / 100) * 100 / size, o = 100 - i;
    return `M${i} ${i}L${o} ${i}L${o} ${o}L${i} ${o}Z`;
  });
  // favicon.svg: the mark on the 16 px grid (also whole pixels at 32), switching colour with the system theme if the
  // brand's dark colour differs.
  const d = snap(svg('bane-mark.svg'), 16).match(/ d="([^"]+)"/)[1], dark = svg('bane-mark-dark.svg').match(/fill="([^"]+)"/)[1], light = svg('bane-mark.svg').match(/fill="([^"]+)"/)[1];
  writeFileSync(join(publicDir, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">\n  <style>path { fill: ${light}; }${dark === light ? '' : ` @media (prefers-color-scheme: dark) { path { fill: ${dark}; } }`}</style>\n  <path fill-rule="evenodd" d="${d}"/>\n</svg>\n`);
  const favicon = async size => ({ size, data: await shot(`<body style="margin:0;background:transparent">${snap(inline('bane-mark.svg'), size).replace('<svg', `<svg style="display:block;width:${size}px;height:${size}px"`)}</body>`, size, size, true) });
  writeFileSync(join(publicDir, 'favicon.ico'), ico(await Promise.all([16, 32, 48].map(favicon))));
  writeFileSync(join(publicDir, 'apple-touch-icon.png'), await shot(tile(180, 0.6, canvas), 180, 180));
  writeFileSync(join(publicDir, 'icon-192.png'), await shot(tile(192, 0.6, canvas), 192, 192));
  writeFileSync(join(publicDir, 'icon-512.png'), await shot(tile(512, 0.6, canvas), 512, 512));
  writeFileSync(join(publicDir, 'icon-maskable-512.png'), await shot(tile(512, 0.5, canvas), 512, 512));
  }
} finally { await browser.close(); }
