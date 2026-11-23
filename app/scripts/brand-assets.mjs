// Builds the brand files in public/ that are made from the stamp (docs/brand.md), from the final vector set's own files
// in public/brand/:
// - the tab icon, the stamp's crescent alone on a rounded tile (at 16 px the stamp's frame and perforations turn to
//   noise beside other sites' solid icons): favicon.svg, a paper moon on an ink tile for a browser's pale theme, and
//   favicon-dark.svg, an ink moon on a paper tile for its dark one, on the 16 px grid (corners rounded by 3, the moon
//   11 tall and centred); favicon.ico holds the light one at 16 and 32 px. support/src/favicon.ts serves the same two
//   SVGs, byte for byte;
// - apple-touch-icon.png (180) and the manifest's icon-192.png and icon-512.png: the dark stamp at 66 % of the side on
//   a full square of ink, its corners 17 % in from the icon's, well clear of those iOS rounds; icon-maskable-512.png: at
//   52 %, so the whole stamp, corners and all, is inside the 80 % circle every launcher keeps.
// og.png is a fixed file, not made here.
// Run from app/ after changing a mark: node scripts/brand-assets.mjs. It uses Playwright's own headless Chromium
// (npx playwright-core install chromium-headless-shell), never the installed Chrome; BRAND_CHROME=<path> picks another build.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const brand = name => readFileSync(join(publicDir, 'brand', name), 'utf8');
// The set's own ink and paper: these are standalone files, not the app's themed tokens.
const INK = '#0a0a0a', PAPER = '#fafafa';

const outline = file => brand(file).match(/ d="([^"]+)"/)[1];
const small = outline('nightmail-logo-16-light.svg'), large = outline('nightmail-logo-1024-light.svg');
// The crescent: the stamp's last outline, 548 x 565 units, its box centred on (494, 493).
const MOON = large.slice(large.lastIndexOf('M'));
if (!MOON.startsWith('M666')) throw Error('the stamp\'s last outline is not its moon');
const tabIcon = (n, tile, moon) => { const k = 11 / 16 * n / 565.4;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}" role="img" aria-label="Nightmail"><rect width="${n}" height="${n}" rx="${3 / 16 * n}" fill="${tile}"/><path fill="${moon}" transform="translate(${(n / 2 - 494 * k).toFixed(3)} ${(n / 2 - 493 * k).toFixed(3)}) scale(${k.toFixed(6)})" d="${MOON}"/></svg>`; };
const svg = (d, fill, under = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" style="display:block;width:100%;height:100%">${under}<path fill="${fill}" fill-rule="evenodd" d="${d}"/></svg>`;
const doc = (size, body, background = 'transparent') => `<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${background}">${body}</body>`;
const fit = (side, inner) => `<div style="width:${side}px;height:${side}px">${inner}</div>`;

// Whole pixels, so the stamp's edge is not smeared over the icon's own.
const icon = (size, scale) => doc(size, fit(Math.round(size * scale), svg(size * scale < 32 ? small : large, PAPER)), INK);

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

writeFileSync(join(publicDir, 'favicon.svg'), tabIcon(16, INK, PAPER));
writeFileSync(join(publicDir, 'favicon-dark.svg'), tabIcon(16, PAPER, INK));
const browser = await chromium.launch({ headless: true, ...process.env.BRAND_CHROME && { executablePath: process.env.BRAND_CHROME } });
try {
  const shot = async (html, size) => {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(html); const data = await page.screenshot({ omitBackground: true }); await page.close(); return data;
  };
  writeFileSync(join(publicDir, 'favicon.ico'), ico([
    { size: 16, data: await shot(doc(16, tabIcon(16, INK, PAPER)), 16) },
    { size: 32, data: await shot(doc(32, tabIcon(32, INK, PAPER)), 32) },
  ]));
  writeFileSync(join(publicDir, 'apple-touch-icon.png'), await shot(icon(180, .66), 180));
  writeFileSync(join(publicDir, 'icon-192.png'), await shot(icon(192, .66), 192));
  writeFileSync(join(publicDir, 'icon-512.png'), await shot(icon(512, .66), 512));
  writeFileSync(join(publicDir, 'icon-maskable-512.png'), await shot(icon(512, .52), 512));
} finally { await browser.close(); }
