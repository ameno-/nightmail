// The homepage's first pictures, made from the render set's posters and billboards (features/home/first-picture.ts uses
// them). Run it again whenever one of those changes:
//
//   node scripts/home-assets.mjs [--boards <web-layers folder>]
//
// Desktop: factory/poster.jpg (the set's 1920 x 1080 poster, its billboards where they stand at t = 0) gives
// poster-1280.jpg and poster-{960,1280,1920}.avif. Phone: factory/phone/poster-bare.jpg (the hall without its
// billboards) with the first billboard the page hangs (board1.webp, where factory-home.tsx hangs it) gives
// phone/poster.jpg, poster-828.jpg and poster-{640,828,1080}.avif, so the first picture already has its board. Each
// gets first.avif, a small, soft copy (about 10 kB) that home.html shows until the poster is in (home-shell.ts).
// --boards takes the billboards from a web-layers folder (boards/board*.png and phone/boards/board*.png, twice the
// frame's size) into factory/boards/*.webp and factory/phone/board*.webp first.
// Needs ImageMagick 7 (magick), libheif's heif-enc (AVIF, aom) and cwebp.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../src/features/home/factory')
const tmp = mkdtempSync(join(tmpdir(), 'home-assets-'))
const run = (command, ...args) => execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
const at = (...parts) => join(root, ...parts)
// The AVIF quality and the JPEG fallback's: chosen side by side with the posters at 1:1 (the renders' grain is kept).
const AVIF = 50, JPEG = 86

const boards = process.argv.indexOf('--boards')
if (boards > 0) {
  const from = resolve(process.argv[boards + 1])
  for (const k of [0, 1, 2]) {
    run('cwebp', '-quiet', '-q', '82', '-alpha_q', '90', '-m', '6', join(from, 'boards', `board${k}.png`), '-o', at('boards', `board${k}.webp`))
    run('cwebp', '-quiet', '-q', '82', '-alpha_q', '90', '-m', '6', join(from, 'phone', 'boards', `board${k}.png`), '-o', at('phone', `board${k}.webp`))
  }
}

function sizes(source, out, widths, jpegWidths, firstWidth) {
  for (const width of widths) {
    const png = join(tmp, `${width}.png`)
    run('magick', source, '-filter', 'Lanczos', '-resize', `${width}x`, png)
    run('heif-enc', '-q', String(AVIF), '-p', 'chroma=420', '-p', 'speed=4', png, '-o', join(out, `poster-${width}.avif`))
    if (jpegWidths.includes(width)) run('magick', png, '-quality', String(JPEG), '-sampling-factor', '4:2:0', '-strip', join(out, `poster-${width}.jpg`))
  }
  run('magick', source, '-filter', 'Lanczos', '-resize', `${firstWidth}x`, join(tmp, 'first.png'))
  run('heif-enc', '-q', '25', '-p', 'chroma=420', '-p', 'speed=4', join(tmp, 'first.png'), '-o', join(out, 'first.avif'))
}

// Desktop.
sizes(at('poster.jpg'), root, [960, 1280, 1920], [1280], 768)

// Phone: the bare hall with the first board hung (manifest: boards.y, boards.w; sprites are twice the frame's size).
const phone = JSON.parse(readFileSync(at('phone', 'manifest.json'), 'utf8'))
const first = 1, w = phone.boards.w[first], x = (phone.width - w) / 2, y = phone.boards.y[first]
const hung = join(tmp, 'phone.png')
run('magick', at('phone', 'poster-bare.jpg'), '(', at('phone', `board${first}.webp`), '-filter', 'Lanczos', '-resize', `${w}x`, ')', '-geometry', `+${x}+${y}`, '-composite', hung)
run('magick', hung, '-quality', String(JPEG), '-sampling-factor', '4:2:0', '-strip', at('phone', 'poster.jpg'))
sizes(hung, at('phone'), [640, 828, 1080], [828], 432)
rmSync(tmp, { recursive: true, force: true })
console.log('home-assets: done')
