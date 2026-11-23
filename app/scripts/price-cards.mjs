// The price pages' link-preview cards (features/pricing/pages.ts names them): each page as it opens, 1200 × 630, from
// a Vite dev server this script starts on a free port and stops. Run it from app/ when the build says a card is
// missing (a price or claim on it changed): node scripts/price-cards.mjs. It writes public/og/<page>-<hash>.jpg and
// deletes that page's older cards.
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { chromium } from 'playwright-core'
import { PRICE_PAGES } from '../src/features/pricing/pages.ts'

const W = 1200, H = 630
const port = await new Promise(done => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)) }) })
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: ['ignore', 'pipe', 'inherit'] })
const origin = `http://127.0.0.1:${port}`
try {
  await new Promise((done, fail) => { vite.stdout.on('data', chunk => { if (String(chunk).includes(origin)) done() }); vite.on('exit', code => fail(new Error(`vite exited (${code})`))) })
  const browser = await chromium.launch({ channel: 'chrome' })
  mkdirSync('public/og', { recursive: true })
  for (const page of PRICE_PAGES) {
    // A comparison: its headline and its whole board, centred, with the wall around them. The calculator: its top.
    const board = page.path.startsWith('/compare/'), width = board ? 1600 : 1440
    const probe = await browser.newPage({ viewport: { width, height: 1100 } })
    await probe.goto(origin + page.path, { waitUntil: 'networkidle' })
    await probe.evaluate(() => document.fonts.ready)
    await probe.waitForTimeout(4500)
    let clip = { x: 0, y: 0, width, height: Math.round(width * H / W) }
    if (board) {
      const title = await probe.locator('.cb-title').boundingBox(), face = await probe.locator('.cb-board').boundingBox()
      const top = title.y - 44, height = face.y + face.height + 32 - top, w = Math.round(height * W / H)
      clip = { x: Math.round((width - w) / 2), y: Math.round(top), width: w, height: Math.round(height) }
    }
    await probe.close()
    // (Drawn at the scale that makes the clip 1200 px wide.)
    const shot = await browser.newPage({ viewport: { width, height: 1100 }, deviceScaleFactor: W / clip.width })
    await shot.goto(origin + page.path, { waitUntil: 'networkidle' })
    await shot.evaluate(() => document.fonts.ready)
    await shot.waitForTimeout(4500)
    await shot.screenshot({ path: `public/${page.card.file}`, clip, type: 'jpeg', quality: 86 })
    await shot.close()
    const slug = page.card.file.slice(3).replace(/-[^-]+\.jpg$/, '')
    for (const old of readdirSync('public/og')) if (old.startsWith(`${slug}-`) && `og/${old}` !== page.card.file) rmSync(`public/og/${old}`)
    console.log(`public/${page.card.file}`)
  }
  await browser.close()
} finally { vite.kill() }
