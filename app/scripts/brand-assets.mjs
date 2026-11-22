// Builds the brand files in public/ that are made from others (docs/brand.md):
// - favicon.ico, packed from the two hand-cut tiles in public/brand/ (favicon-16.png and favicon-32.png);
// - the manifest icons (192, 512 and a maskable 512), drawn from public/brand/nightmail-monogram.svg: the NM in the
//   brand's paper on a full square of its ink, as apple-touch-icon.png has it (the maskable one at eight tenths, so
//   the NM keeps inside the circle every launcher shows);
// favicon.svg, favicon-dark.svg and apple-touch-icon.png are the final vector set's own files, copied in as they are,
// and so is the 1200 × 630 link-preview card og.png: a fixed file, no longer made here.
// Run from app/ after changing a mark: node scripts/brand-assets.mjs. It uses Playwright's own headless Chromium
// (npx playwright-core install chromium-headless-shell), never the installed Chrome; BRAND_CHROME=<path> picks another build.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const brand = name => join(publicDir, 'brand', name);
const INK = '#0A0B0F', PAPER = '#F4F2EC';

// The monogram's file is the tile with the NM cut out of it: its second outline is the NM alone. An icon is that NM in
// paper on a square of ink, the tile's own proportions at `scale` 1 (the NM eight tenths of the side across).
const tile = readFileSync(brand('nightmail-monogram.svg'), 'utf8').match(/ d="([^"]+)"/)[1];
const nm = (() => { const cut = tile.indexOf('Z') + 1; if (!cut || !tile.startsWith('M', cut)) throw Error('nightmail-monogram.svg is not a tile and one outline cut from it'); return tile.slice(cut) })();
const icon = (size, scale) => `<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${INK}">
  <svg viewBox="0 0 1000 1000" style="display:block;width:${size * scale}px;height:${size * scale}px"><path fill="${PAPER}" d="${nm}"/></svg></body>`;

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
  const shot = async (html, size) => {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(html); const data = await page.screenshot(); await page.close(); return data;
  };
  writeFileSync(join(publicDir, 'favicon.ico'), ico([16, 32].map(size => ({ size, data: readFileSync(brand(`favicon-${size}.png`)) }))));
  writeFileSync(join(publicDir, 'icon-192.png'), await shot(icon(192, 1), 192));
  writeFileSync(join(publicDir, 'icon-512.png'), await shot(icon(512, 1), 512));
  writeFileSync(join(publicDir, 'icon-maskable-512.png'), await shot(icon(512, .8), 512));
} finally { await browser.close(); }