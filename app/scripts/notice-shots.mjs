// Pictures of the customer notices: each document api/scripts/render-notices.ts emulated (the email in a mail client,
// light or dark, desktop or phone) under a plain mail header, as a PNG, and contact sheets of them all.
//   node scripts/notice-shots.mjs <dir with notices.json> <shots dir>
//   NOTICE_CHROME=<path>  Chrome executable; otherwise the installed Google Chrome
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const [source, target] = process.argv.slice(2).map(path => resolve(path))
if (!source || !target) throw new Error('Usage: node scripts/notice-shots.mjs <dir with notices.json> <shots dir>')
const { from, emails, shots } = JSON.parse(readFileSync(join(source, 'notices.json'), 'utf8'))
mkdirSync(target, { recursive: true })
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const WIDTH = { desktop: 800, mobile: 390 }
const CLIENT = { 'gmail-web': 'Gmail', 'gmail-ios': 'Gmail, iPhone', 'gmail-android': 'Gmail, Android', 'apple-mail-macos': 'Apple Mail', 'apple-mail-ios': 'Mail, iPhone', 'outlook-web': 'Outlook on the web', 'yahoo-web': 'Yahoo Mail', 'samsung-email': 'Samsung Email' }

// The header a mail client shows over a message: subject, sender, recipient. Its colours follow the message's canvas.
function frame(shot, email) {
  const dark = shot.theme === 'dark', phone = shot.device === 'mobile', width = WIDTH[shot.device]
  // Webmail and its apps set the message inside their own padding; Apple Mail and Samsung Email give it a body margin.
  const pad = /^(gmail|outlook|yahoo)/.test(shot.client) ? (phone ? 16 : 24) : 0
  const ink = dark ? '#f2f2f2' : '#1b1b1b', muted = dark ? '#a0a0a0' : '#6b6b6b', rule = dark ? '#3a3a3a' : '#e3e3e3'
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:${dark ? '#1e1e1e' : '#ffffff'};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:${ink}}
    #mail{width:${width + 2 * pad}px;border:1px solid ${rule};box-sizing:content-box}
    header{padding:${phone ? '16px 16px 12px' : '18px 24px 14px'};border-bottom:1px solid ${rule}}
    h1{margin:0;font-size:${phone ? 19 : 20}px;line-height:1.3;font-weight:600}
    .who{display:flex;align-items:center;gap:10px;margin-top:12px;font-size:13px;line-height:1.35}
    .dot{flex:none;width:32px;height:32px;border-radius:50%;background:${dark ? '#3a3a3a' : '#e9e9e9'};color:${muted};font-weight:600;display:flex;align-items:center;justify-content:center}
    .who b{font-weight:600}.who span{color:${muted}}.who .at{margin-left:auto;font-size:12px;color:${muted}}
    iframe{display:block;width:${width}px;height:10px;border:0;margin:${pad ? 16 : 0}px ${pad}px}
  </style></head><body><div id="mail"><header><h1>${escape(email.subject)}</h1>
    <div class="who"><div class="dot">N</div><div><b>Nightmail</b>${phone ? '' : ` <span>&lt;${escape(from)}&gt;</span>`}<br><span>to me</span></div><div class="at">09:41</div></div></header>
    <iframe srcdoc="${escape(shot.document)}"></iframe></div></body></html>`
}

const browser = await chromium.launch({ headless: true, ...(process.env.NOTICE_CHROME ? { executablePath: process.env.NOTICE_CHROME } : { channel: 'chrome' }) })
const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 })
const page = await context.newPage()
for (const shot of shots) {
  const email = emails.find(candidate => candidate.name === shot.email && (shot.file.startsWith('today-') || shot.file === 'template-today.png' ? candidate.set === 'today' : candidate.set === 'proposed'))
  await page.setContent(frame(shot, email), { waitUntil: 'load' })
  const inner = page.frames().find(candidate => candidate !== page.mainFrame())
  // The message's own height, and its canvas under the header too.
  const { height, canvas } = await inner.evaluate(() => ({ height: Math.ceil(document.documentElement.scrollHeight), canvas: getComputedStyle(document.body).backgroundColor }))
  await page.evaluate(([height, canvas]) => { document.querySelector('iframe').style.height = height + 'px'; if (!/rgba\(.*, 0\)|transparent/.test(canvas)) document.body.style.background = canvas }, [height, canvas])
  await page.locator('#mail').screenshot({ path: join(target, shot.file) })
}

// ---------- contact sheets ----------
const image = (file, width) => `<img src="${pathToFileURL(join(target, file)).href}" style="width:${width}px">`
const sheetPage = (title, note, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;padding:36px 40px 44px;background:#f3f3f1;color:#1b1b1b;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  h1{margin:0;font-size:22px;font-weight:600}.note{margin:6px 0 0;font-size:13px;color:#666}h2{margin:36px 0 0;font-size:15px;font-weight:600}
  .grid{display:flex;flex-wrap:wrap;gap:28px 36px;margin-top:16px}.item h3{margin:0 0 2px;font-size:13px;font-weight:600}.item p{margin:0 0 8px;font-size:12px;color:#666}
  .row{display:flex;gap:10px;align-items:flex-start}img{display:block}
</style></head><body><h1>${title}</h1><p class="note">${note}</p>${body}</body></html>`
const item = (heading, caption, images) => `<div class="item"><h3>${escape(heading)}</h3><p>${escape(caption)}</p><div class="row">${images}</div></div>`
async function sheet(file, html, width) {
  const sheetContext = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 })
  const sheetPageHandle = await sheetContext.newPage()
  const path = join(source, file.replace('.png', '.html'))
  writeFileSync(path, html)
  await sheetPageHandle.goto(pathToFileURL(path).href, { waitUntil: 'load' })
  await sheetPageHandle.screenshot({ path: join(target, file), fullPage: true })
  await sheetContext.close()
}
const four = name => ['-desktop', '-desktop-dark'].map(suffix => image(name + suffix + '.png', 380)).join('') + ['-phone', '-phone-dark'].map(suffix => image(name + suffix + '.png', 186)).join('')
const proposed = emails.filter(email => email.set === 'proposed'), today = emails.filter(email => email.set === 'today')
await sheet('contact-sheet.png', sheetPage('Customer emails: the proposed set', 'Each email in Apple Mail on a desktop and an iPhone, light and dark, rendered by the product’s own client emulation. Sample workspace: Driftwood.',
  `<div class="grid">${proposed.map(email => item(email.title, 'To ' + email.to, four(email.name))).join('')}</div><h2>What is sent today, for comparison (text only, as Gmail shows it)</h2><div class="grid">${today
    .map(email => item(email.title, email.subject, image('today-' + email.name + '.png', 380))).join('')}</div>`), 2520)
await sheet('contact-sheet-today.png', sheetPage('Customer emails: what is sent today', 'Each email exactly as today’s code writes it (text only), as Gmail shows it on a desktop.',
  `<div class="grid">${today.map(email => item(email.title, email.subject, image('today-' + email.name + '.png', 560))).join('')}</div>`), 1880)
const clientShots = shots.filter(shot => shot.file.startsWith('client-'))
await sheet('template-sheet.png', sheetPage('The template: today, and the proposed change', 'The paused email. Top: today’s text, the proposed words as text only, and the proposed words with the small HTML part, all in Gmail. Below: the HTML part in other clients.',
  `<div class="grid">${[['template-today.png', 'Today', 'Text only, with rates and thresholds'], ['template-text-part.png', 'Proposed, text part', 'What a text-only client shows'], ['template-html-part.png', 'Proposed, HTML part', 'The same words']]
    .map(([file, heading, caption]) => item(heading, caption, image(file, 560))).join('')}</div><h2>The proposed paused email in other clients</h2><div class="grid">${clientShots
    .map(shot => item(CLIENT[shot.client] + (shot.theme === 'dark' ? ', dark' : ''), shot.device === 'mobile' ? 'Phone' : 'Desktop', image(shot.file, shot.device === 'mobile' ? 240 : 480))).join('')}</div>`), 1880)
await browser.close()
console.log(shots.length + ' pictures and 3 sheets in ' + target)
