// The type and grain of the sender score card image (api/src/score-card.ts): every string the card can show, set in
// Inter as the dashboard sets it, drawn once here by Chromium at 3× and kept as coverage masks, so the API composes a
// card from them with no font engine and the same glyphs every time. Run from app/ after changing the card's type or
// words: node scripts/score-card-masks.mjs. It writes api/src/score-card-masks.ts. Playwright's own headless Chromium
// (npx playwright-core install chromium-headless-shell), or MASKS_CHROME=<path>.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright-core'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCALE = 3
const b64 = path => readFileSync(join(app, path)).toString('base64')
// The card's words (api/src/score-card.ts STATES, GRADES): the label, the score's digits, each grade, each state line.
const STRINGS = [
  ['label', 'Sender score', 'label'],
  ...'0123456789'.split('').map(d => [`digit-${d}`, d, 'figure']),
  ...['A+', 'A', 'B', 'C', 'D', 'F'].map(g => [`grade-${g}`, g, 'grade']),
  ['state-none', 'No daily limit', 'state'],
  ...[100, 200, 500].map(n => [`state-${n}`, `Daily limit of ${n} for now`, 'state']),
]
// Sizes in CSS px; the card is drawn at 3×. Figures are tabular, so each digit sits in one advance and any score sets alike.
const STYLES = {
  label: 'font-size:14px;font-weight:450;letter-spacing:0',
  figure: 'font-size:60px;font-weight:600;letter-spacing:-0.035em;font-variant-numeric:tabular-nums',
  grade: 'font-size:22px;font-weight:650;letter-spacing:0',
  state: 'font-size:15px;font-weight:500;letter-spacing:-0.005em',
}
const html = `<!doctype html><html><head><style>
@font-face{font-family:'Inter';src:url(data:font/woff2;base64,${b64('public/fonts/inter-variable.woff2')}) format('woff2');font-weight:100 900;font-display:block}
html,body{margin:0;background:transparent}
.s{position:absolute;left:0;font-family:'Inter';line-height:1;color:#000;white-space:pre;padding:0 12px;font-synthesis:none;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;font-optical-sizing:auto}
.b{display:inline-block;width:0;height:0;vertical-align:baseline}
#wm{position:absolute;left:0;height:7px}
#noise{position:absolute;left:0}
</style></head><body>
${STRINGS.map(([id, text, kind], i) => `<span class="s" id="${id}" style="top:${(i + 1) * 100}px;${STYLES[kind]}"><i class="b"></i>${text.replace(/&/g, '&amp;')}<i class="b" data-end></i></span>`).join('')}
<img id="wm" style="top:${(STRINGS.length + 1) * 100}px" src="data:image/svg+xml;base64,${Buffer.from(readFileSync(join(app, 'public/brand/nightmail-wordmark-128-light.svg'), 'utf8').replace(/#0a0a0a/g, '#000')).toString('base64')}">
<img id="noise" style="top:${(STRINGS.length + 1) * 100 + 40}px" src="data:image/png;base64,${b64('src/features/score/noise-light.png')}">
</body></html>`

const browser = await chromium.launch({ headless: true, ...process.env.MASKS_CHROME && { executablePath: process.env.MASKS_CHROME } })
const page = await browser.newPage({ viewport: { width: 1200, height: STRINGS.length * 100 + 500 }, deviceScaleFactor: SCALE })
await page.setContent(html, { waitUntil: 'load' })
await page.evaluate(async () => { await document.fonts.ready; for (const img of document.images) await img.decode() })
// A screenshot's pixels, read back through the page: the alpha channel (or one colour channel) per pixel.
const pixels = async (clip, channel = 3) => {
  const png = (await page.screenshot({ clip, omitBackground: true, scale: 'device' })).toString('base64')
  return page.evaluate(async ([data, channel]) => {
    const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode()
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0)
    const d = x.getImageData(0, 0, c.width, c.height).data, out = new Array(c.width * c.height)
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + channel]
    return { w: c.width, h: c.height, a: out }
  }, [png, channel])
}
// Crop to the ink; dx/dy place the crop from the pen (the string's start on its baseline), in device pixels.
function crop({ w, h, a }, penX, baseY) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (a[y * w + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, out = new Uint8Array(cw * ch)
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = a[(y + y0) * w + x + x0]
  return { w: cw, h: ch, dx: x0 - penX, dy: y0 - baseY, data: out }
}

const index = {}, chunks = []
let offset = 0
const add = (id, mask, extra = {}) => { index[id] = { w: mask.w, h: mask.h, dx: mask.dx, dy: mask.dy, at: offset, ...extra }; chunks.push(Buffer.from(mask.data)); offset += mask.data.length }
for (const [id] of STRINGS) {
  const box = await page.locator(`[id="${id}"]`).evaluate(el => {
    const r = el.getBoundingClientRect(), [start, end] = el.querySelectorAll('.b'), s = start.getBoundingClientRect(), e = end.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height, penX: s.left - r.left, baseY: s.top - r.top, advance: e.left - s.left }
  })
  const clip = { x: box.x, y: box.y - 12, width: Math.ceil(box.w), height: Math.ceil(box.h) + 24 }
  add(id, crop(await pixels(clip), Math.round(box.penX * SCALE), Math.round((box.baseY + 12) * SCALE)), { advance: Math.round(box.advance * SCALE) })
}
const wm = await page.locator('#wm').boundingBox()
add('wordmark', crop(await pixels({ x: wm.x, y: wm.y, width: Math.ceil(wm.width), height: Math.ceil(wm.height) }), 0, Math.round(wm.height * SCALE)))
// The grain is the dashboard's own tile (features/score/noise-light.png): white at alpha 0 to 41, kept at one byte a pixel.
const noise = readFileSync(join(app, 'src/features/score/noise-light.png'))
const n = await page.evaluate(async data => {
  const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode()
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0)
  const d = x.getImageData(0, 0, c.width, c.height).data, out = new Array(c.width * c.height)
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3]
  return { w: c.width, h: c.height, a: out }
}, noise.toString('base64'))
add('noise', { w: n.w, h: n.h, dx: 0, dy: 0, data: Uint8Array.from(n.a) })
await browser.close()

const packed = deflateSync(Buffer.concat(chunks), { level: 9 }).toString('base64')
writeFileSync(resolve(app, '../api/src/score-card-masks.ts'), `// Generated by app/scripts/score-card-masks.mjs: do not edit. Inter's coverage masks for every string the sender score
// card shows, and the dashboard's grain tile, at 3×. MASKS is one zlib stream; INDEX places each mask in it.
export const SCALE = ${SCALE};
export const INDEX: Record<string, { w: number; h: number; dx: number; dy: number; at: number; advance?: number }> = ${JSON.stringify(index)};
export const MASKS = '${packed}';
`)
console.log(`${Object.keys(index).length} masks, ${offset} bytes, ${packed.length} base64`)
