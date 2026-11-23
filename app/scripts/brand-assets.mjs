// Builds the brand files in public/ that are made from the stamp (docs/brand.md), from the final vector set's own files
// in public/brand/ (nightmail-logo-16-*.svg is the drawing for under 32 px, nightmail-logo-1024-*.svg the one for 32 and
// up):
// - favicon.svg and favicon-dark.svg: the small stamp's light and dark files, copied as they are;
// - favicon.ico: the light stamp at 16 (the small drawing) and 32 px, its window filled with paper, so it reads on a
//   tab strip of either theme without knowing which;
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
// The stamp's window: the square cut out of it, inside the perforated frame, that the moon stands in.
const windowOf = d => {
  const [, x1, y1, h, w] = d.match(/M([\d.]+),([\d.]+)v-([\d.]+)h-([\d.]+)v[\d.]+z/) ?? [];
  if (!x1) throw Error('the stamp has no square window');
  return { x: x1 - w, y: y1 - h, w: +w, h: +h };
};
const svg = (d, fill, under = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" style="display:block;width:100%;height:100%">${under}<path fill="${fill}" fill-rule="evenodd" d="${d}"/></svg>`;
const doc = (size, body, background = 'transparent') => `<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${background}">${body}</body>`;
const fit = (side, inner) => `<div style="width:${side}px;height:${side}px">${inner}</div>`;

const tab = d => { const w = windowOf(d); return svg(d, INK, `<rect x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" fill="${PAPER}"/>`); };
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

writeFileSync(join(publicDir, 'favicon.svg'), brand('nightmail-logo-16-light.svg'));
writeFileSync(join(publicDir, 'favicon-dark.svg'), brand('nightmail-logo-16-dark.svg'));
const browser = await chromium.launch({ headless: true, ...process.env.BRAND_CHROME && { executablePath: process.env.BRAND_CHROME } });
try {
  const shot = async (html, size) => {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(html); const data = await page.screenshot({ omitBackground: true }); await page.close(); return data;
  };
  writeFileSync(join(publicDir, 'favicon.ico'), ico([
    { size: 16, data: await shot(doc(16, tab(small)), 16) },
    { size: 32, data: await shot(doc(32, tab(large)), 32) },
  ]));
  writeFileSync(join(publicDir, 'apple-touch-icon.png'), await shot(icon(180, .66), 180));
  writeFileSync(join(publicDir, 'icon-192.png'), await shot(icon(192, .66), 192));
  writeFileSync(join(publicDir, 'icon-512.png'), await shot(icon(512, .66), 512));
  writeFileSync(join(publicDir, 'icon-maskable-512.png'), await shot(icon(512, .52), 512));
} finally { await browser.close(); }
