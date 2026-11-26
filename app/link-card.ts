// The link-preview cards (og:image) of the site's public pages, drawn in the build: two lines and a caption in the
// homepage television's type (OpenTUI Mono Bold, read from public/fonts) and colours (features/home/tv/tv.css) on its
// flat dark, the wordmark under them. The first line is in Nightmail's blue, the second in the ink, the caption and the
// wordmark in the soft grey; the template sets them in capitals and the alt text keeps the words as given. Each page
// family makes its words from the page's own data (features/pricing/pages.ts, verdictCard), so a card can't show a figure
// the page no longer shows, and the build refuses a line or caption that doesn't fit, a character the font lacks, and a
// superlative. A card is a 1200 x 630 PNG named by a hash of its pixels (og/<name>-<hash>.png), so a change of words or
// template is a new address that link previews fetch again. The same words give the same pixels, so the same name, on
// any machine and engine (only arithmetic every engine rounds alike), and under Node the same bytes on macOS and Linux
// (a fixed zlib level, no timestamp); Bun's zlib packs the same pixels differently. No dependency and no browser: the
// font's outlines, an exact-coverage rasterizer and the PNG are below. Build-side only (node:zlib): a page's build calls linkCard, emits card.source at card.file and sets its tags
// with withCard.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { brotliDecompressSync, deflateSync } from 'node:zlib'
import { WORDMARK } from './src/lib/marks.ts'

const W = 1200, H = 630

// ---------------------------------------------------------------- the font: OpenTUI Mono Bold, read from its WOFF2

type Point = { x: number; y: number; on: boolean }
type Font = { unitsPerEm: number; advance: number; capHeight: number; glyphs: Point[][][]; cmap: Map<number, number> }

const TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill']

/** A WOFF2 font's outlines (its glyf table as WOFF2 transforms it), advance, cap height and character map. */
export function readFont(bytes: Buffer): Font {
  if (bytes.toString('latin1', 0, 4) !== 'wOF2' || bytes.readUInt32BE(4) !== 0x00010000) throw new Error('Not a TrueType WOFF2 font.')
  let at = 48
  const base128 = () => { let value = 0; for (let i = 0; i < 5; i++) { const byte = bytes[at++]!; value = value * 128 + (byte & 127); if (!(byte & 128)) return value } throw new Error('Bad UIntBase128.') }
  const directory = Array.from({ length: bytes.readUInt16BE(12) }, () => {
    const flags = bytes[at++]!, tag = (flags & 63) === 63 ? bytes.toString('latin1', at, at += 4) : TAGS[flags & 63]!, version = flags >> 6
    const length = base128(), transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0
    return { tag, transformed, length: transformed ? base128() : length }
  })
  const data = brotliDecompressSync(bytes.subarray(at, at + bytes.readUInt32BE(20)))
  const tables = new Map<string, Buffer>()
  let offset = 0
  for (const table of directory) { tables.set(table.tag, data.subarray(offset, offset + table.length)); offset += table.length; if (table.transformed && table.tag !== 'glyf' && table.tag !== 'loca') throw new Error(`The font's ${table.tag} is transformed.`) }
  const table = (tag: string) => { const found = tables.get(tag); if (!found) throw new Error(`The font has no ${tag}.`); return found }
  const head = table('head'), hmtx = table('hmtx'), os2 = table('OS/2')
  return { unitsPerEm: head.readUInt16BE(18), advance: hmtx.readUInt16BE(0), capHeight: os2.readInt16BE(88), glyphs: glyf(table('glyf')), cmap: cmap(table('cmap')) }
}

/** The transformed glyf table (WOFF2 5.1): each glyph's contours, its composites' parts placed. */
function glyf(t: Buffer): Point[][][] {
  const count = t.readUInt16BE(4), sizes = Array.from({ length: 7 }, (_, i) => t.readUInt32BE(8 + i * 4))
  const starts = sizes.reduce<number[]>((list, size) => [...list, list.at(-1)! + size], [36])
  const stream = (i: number) => ({ at: starts[i]! })
  const [contours, points, flags, glyph, composite, , instructions] = [0, 1, 2, 3, 4, 5, 6].map(stream) as { at: number }[]
  const u8 = (s: { at: number }) => t[s.at++]!, u16 = (s: { at: number }) => { const v = t.readUInt16BE(s.at); s.at += 2; return v }, i16 = (s: { at: number }) => { const v = t.readInt16BE(s.at); s.at += 2; return v }
  const u255 = (s: { at: number }) => { const code = u8(s); return code === 253 ? u16(s) : code === 255 ? u8(s) + 253 : code === 254 ? u8(s) + 506 : code }
  const sign = (flag: number, value: number) => flag & 1 ? value : -value
  const simple: (Point[][] | null)[] = [], parts: ({ glyph: number; dx: number; dy: number; scale: [number, number, number, number] }[] | null)[] = []
  for (let g = 0; g < count; g++) {
    const n = i16(contours)
    if (n === 0) { simple.push([]); parts.push(null); continue }
    if (n === -1) {
      const list = []
      let more = true, instructed = false
      while (more) {
        const f = u16(composite), index = u16(composite)
        const dx = f & 1 ? (f & 2 ? i16(composite) : u16(composite)) : (f & 2 ? (t.readInt8(composite.at++)) : u8(composite))
        const dy = f & 1 ? (f & 2 ? i16(composite) : u16(composite)) : (f & 2 ? (t.readInt8(composite.at++)) : u8(composite))
        const f2 = () => i16(composite) / 16384
        let scale: [number, number, number, number] = [1, 0, 0, 1]
        if (f & 8) { const s = f2(); scale = [s, 0, 0, s] } else if (f & 0x40) { const sx = f2(), sy = f2(); scale = [sx, 0, 0, sy] } else if (f & 0x80) scale = [f2(), f2(), f2(), f2()]
        if (!(f & 2)) throw new Error('A composite glyph places a part by its points, which this reader doesn\'t do.')
        list.push({ glyph: index, dx, dy, scale })
        instructed ||= !!(f & 0x100)
        more = !!(f & 0x20)
      }
      if (instructed) instructions.at += u255(glyph)
      simple.push(null); parts.push(list); continue
    }
    const ends = Array.from({ length: n }, () => u255(points))
    const list: Point[][] = []
    let x = 0, y = 0
    for (const size of ends) {
      const contour: Point[] = []
      for (let p = 0; p < size; p++) {
        const raw = u8(flags), on = !(raw >> 7), flag = raw & 0x7f
        let dx: number, dy: number
        if (flag < 10) { dx = 0; dy = sign(flag, ((flag & 14) << 7) + u8(glyph)) }
        else if (flag < 20) { dx = sign(flag, (((flag - 10) & 14) << 7) + u8(glyph)); dy = 0 }
        else if (flag < 84) { const b0 = flag - 20, b1 = u8(glyph); dx = sign(flag, 1 + (b0 & 0x30) + (b1 >> 4)); dy = sign(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f)) }
        else if (flag < 120) { const b0 = flag - 84; dx = sign(flag, 1 + (Math.floor(b0 / 12) << 8) + u8(glyph)); dy = sign(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + u8(glyph)) }
        else if (flag < 124) { const b0 = u8(glyph), b1 = u8(glyph), b2 = u8(glyph); dx = sign(flag, (b0 << 4) + (b1 >> 4)); dy = sign(flag >> 1, ((b1 & 0x0f) << 8) + b2) }
        else { const b0 = u8(glyph), b1 = u8(glyph), b2 = u8(glyph), b3 = u8(glyph); dx = sign(flag, (b0 << 8) + b1); dy = sign(flag >> 1, (b2 << 8) + b3) }
        x += dx; y += dy
        contour.push({ x, y, on })
      }
      list.push(contour)
    }
    instructions.at += u255(glyph)
    simple.push(list); parts.push(null)
  }
  const resolve = (g: number, depth = 0): Point[][] => {
    if (depth > 8) throw new Error('A composite glyph nests too deep.')
    return simple[g] ?? parts[g]!.flatMap(part => resolve(part.glyph, depth + 1).map(contour => contour.map(p => ({ x: p.x * part.scale[0] + p.y * part.scale[2] + part.dx, y: p.x * part.scale[1] + p.y * part.scale[3] + part.dy, on: p.on }))))
  }
  return Array.from({ length: count }, (_, g) => resolve(g))
}

/** The Unicode (3, 1) format 4 subtable: code point to glyph. */
function cmap(t: Buffer): Map<number, number> {
  const map = new Map<number, number>()
  for (let i = 0; i < t.readUInt16BE(2); i++) {
    const platform = t.readUInt16BE(4 + i * 8), encoding = t.readUInt16BE(6 + i * 8), offset = t.readUInt32BE(8 + i * 8)
    if (platform !== 3 || encoding !== 1 || t.readUInt16BE(offset) !== 4) continue
    const segments = t.readUInt16BE(offset + 6) / 2, ends = offset + 14, startsAt = ends + segments * 2 + 2, deltas = startsAt + segments * 2, ranges = deltas + segments * 2
    for (let s = 0; s < segments; s++) {
      const end = t.readUInt16BE(ends + s * 2), start = t.readUInt16BE(startsAt + s * 2), delta = t.readInt16BE(deltas + s * 2), range = t.readUInt16BE(ranges + s * 2)
      for (let c = start; c <= end && c !== 0xffff; c++) {
        const g = range === 0 ? (c + delta) & 0xffff : t.readUInt16BE(ranges + s * 2 + range + (c - start) * 2)
        if (g) map.set(c, range === 0 ? g : (g + delta) & 0xffff)
      }
    }
    return map
  }
  throw new Error('The font has no Unicode character map.')
}

// ---------------------------------------------------------------- drawing: outlines to coverage, coverage to PNG

type Xy = [number, number]
/** One colour's shapes on the card: the signed area each outline edge covers in each pixel, summed along the row
 *  (the accumulation method of font-rs and stb_truetype), so a pixel's coverage is exact and needs no supersampling. */
class Layer {
  readonly acc = new Float32Array((W + 2) * H)
  line([x0, y0]: Xy, [x1, y1]: Xy) {
    if (y0 === y1) return
    const dir = y0 < y1 ? 1 : -1
    if (dir < 0) [x0, y0, x1, y1] = [x1, y1, x0, y0]
    const dxdy = (x1 - x0) / (y1 - y0)
    let x = x0 + dxdy * (Math.max(0, y0) - y0)
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
      const row = y * (W + 2), dy = Math.min(y + 1, y1) - Math.max(y, y0), next = x + dxdy * dy, d = dy * dir
      const a = Math.max(0, Math.min(x, next)), b = Math.min(W, Math.max(x, next)), af = Math.floor(a), ai = af, bi = Math.ceil(b)
      if (bi <= ai + 1) {
        const mid = (x + next) / 2 - af
        this.acc[row + ai] += d - d * mid
        this.acc[row + ai + 1] += d * mid
      } else {
        const s = 1 / (b - a), a0f = a - af, a0 = 0.5 * s * (1 - a0f) * (1 - a0f), b1f = b - bi + 1, am = 0.5 * s * b1f * b1f
        this.acc[row + ai] += d * a0
        if (bi === ai + 2) this.acc[row + ai + 1] += d * (1 - a0 - am)
        else {
          const a1 = s * (1.5 - a0f)
          this.acc[row + ai + 1] += d * (a1 - a0)
          for (let xi = ai + 2; xi < bi - 1; xi++) this.acc[row + xi] += d * s
          this.acc[row + bi - 1] += d * (1 - (a1 + (bi - ai - 3) * s) - am)
        }
        this.acc[row + bi] += d * am
      }
      x = next
    }
  }
  /** A closed outline of lines, quadratic and cubic curves, each flattened to within a tenth of a pixel. */
  path(points: Xy[]) { for (let i = 0; i < points.length; i++) this.line(points[i]!, points[(i + 1) % points.length]!) }
  /** Lays the colour over the picture where the layer covers it (blended as a browser blends text, in sRGB). */
  paint(rgb: Uint8Array, colour: [number, number, number], evenOdd = false) {
    for (let y = 0; y < H; y++) {
      let sum = 0
      for (let x = 0; x < W; x++) {
        sum += this.acc[y * (W + 2) + x]!
        let cover = Math.abs(sum)
        cover = evenOdd ? (cover % 2 > 1 ? 2 - cover % 2 : cover % 2) : Math.min(1, cover)
        if (cover < 1 / 512) continue
        const at = (y * W + x) * 3
        for (let c = 0; c < 3; c++) rgb[at + c] = Math.round(rgb[at + c]! + (colour[c]! - rgb[at + c]!) * cover)
      }
    }
  }
}
// (Math.sqrt, never Math.hypot or **: the engines round those differently, and a card must come out the same everywhere.)
const length = (x: number, y: number) => Math.sqrt(x * x + y * y)
const quad = (out: Xy[], p0: Xy, c: Xy, p1: Xy) => {
  const n = Math.max(1, Math.ceil(Math.sqrt(length(p0[0] - 2 * c[0] + p1[0], p0[1] - 2 * c[1] + p1[1]) * 1.25)))
  for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; out.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]) }
}
const cubic = (out: Xy[], p0: Xy, c0: Xy, c1: Xy, p1: Xy) => {
  const dd = Math.max(length(p0[0] - 2 * c0[0] + c1[0], p0[1] - 2 * c0[1] + c1[1]), length(c0[0] - 2 * c1[0] + p1[0], c0[1] - 2 * c1[1] + p1[1]))
  const n = Math.max(1, Math.ceil(Math.sqrt(dd * 7.5)))
  for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t; out.push([a * p0[0] + b * c0[0] + c * c1[0] + d * p1[0], a * p0[1] + b * c0[1] + c * c1[1] + d * p1[1]]) }
}
/** A TrueType contour (on- and off-curve points, a midpoint implied between two off-curve ones) as a polygon. */
function contour(points: Point[], place: (p: Point) => Xy): Xy[] {
  const start = points.findIndex(p => p.on), first = start < 0 ? { x: (points[0]!.x + points[1]!.x) / 2, y: (points[0]!.y + points[1]!.y) / 2, on: true } : points[start]!
  const ring = start < 0 ? points : [...points.slice(start + 1), ...points.slice(0, start)]
  const out: Xy[] = [place(first)]
  let control: Xy | null = null
  for (const p of [...ring, first]) {
    const xy = place(p)
    if (p.on) { if (control) quad(out, out.at(-1)!, control, xy); else out.push(xy); control = null }
    else if (control) { const mid: Xy = [(control[0] + xy[0]) / 2, (control[1] + xy[1]) / 2]; quad(out, out.at(-1)!, control, mid); control = xy }
    else control = xy
  }
  return out
}
/** An SVG path of M, L, H, V, C and Z (the wordmark's), each closed shape as a polygon. */
function svgPath(d: string, place: (x: number, y: number) => Xy): Xy[][] {
  const shapes: Xy[][] = [], tokens = d.match(/[MLHVCZ]|-?[\d.]+(?:e-?\d+)?/gi) ?? []
  let shape: Xy[] = [], x = 0, y = 0, i = 0
  const num = () => Number(tokens[i++])
  while (i < tokens.length) {
    const command = tokens[i++]!
    if (command === 'M') { if (shape.length) shapes.push(shape); x = num(); y = num(); shape = [place(x, y)] }
    else if (command === 'L') { x = num(); y = num(); shape.push(place(x, y)) }
    else if (command === 'H') { x = num(); shape.push(place(x, y)) }
    else if (command === 'V') { y = num(); shape.push(place(x, y)) }
    else if (command === 'C') { const c0 = place(num(), num()), c1 = place(num(), num()); x = num(); y = num(); cubic(shape, shape.at(-1)!, c0, c1, place(x, y)) }
    else if (command === 'Z' || command === 'z') { shapes.push(shape); shape = [] }
    else throw new Error(`The wordmark's path has a ${command}, which this reader doesn't draw.`)
  }
  if (shape.length) shapes.push(shape)
  return shapes
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (bytes: Uint8Array) => { let c = 0xffffffff; for (const byte of bytes) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
/** An 8-bit RGB PNG, each row filtered as Sub (the card is flat colour, so most rows are runs of zero). */
function png(rgb: Uint8Array): Buffer {
  const stride = W * 3, raw = Buffer.alloc((stride + 1) * H)
  for (let y = 0; y < H; y++) {
    raw[y * (stride + 1)] = 1
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = (rgb[y * stride + i]! - (i >= 3 ? rgb[y * stride + i - 3]! : 0)) & 0xff
  }
  const chunk = (type: string, data: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'latin1'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data]))); return Buffer.concat([head, data, crc]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W); ihdr.writeUInt32BE(H, 4); ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// ---------------------------------------------------------------- the card

/** The homepage television's colours (features/home/tv/tv.css): the room, Nightmail's blue, the ink and the soft grey. */
const THEME = { ground: '#050607', ours: '#9DAEFF', ink: '#ECEBE8', soft: '#C2C1BD' } as const
// Where everything sits, in pixels: the lines' baselines (a one-line card uses the second), the caption 28 px under the
// last line, so it reads with the lines, and the wordmark further down as the signature, at the same place on every
// card and clear of the bottom left, where X lays the site's name over the picture.
const GRID = { left: 88, right: 88, size: 72, tracking: -0.01, baselines: [232, 312], caption: { baseline: 356, size: 23, tracking: 0.03 }, mark: { top: 426, cap: 22 } } as const
const rgbOf = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]

let font: Font | undefined
const fontOf = () => font ??= readFont(readFileSync(new URL('./public/fonts/opentui-bold.woff2', import.meta.url)))
/** How wide a line of capitals is at a size and tracking (the font is monospaced). */
const measure = (text: string, size: number, tracking: number) => [...text].length * (fontOf().advance / fontOf().unitsPerEm + tracking) * size - tracking * size
function setText(layer: Layer, text: string, left: number, baseline: number, size: number, tracking: number) {
  const f = fontOf(), scale = size / f.unitsPerEm
  let pen = left
  for (const char of text) {
    const glyph = f.cmap.get(char.codePointAt(0)!)
    if (glyph === undefined) throw new Error(`The cards' font has no ${JSON.stringify(char)}.`)
    for (const points of f.glyphs[glyph]!) if (points.length) layer.path(contour(points, p => [pen + p.x * scale, baseline - p.y * scale]))
    pen += (f.advance / f.unitsPerEm + tracking) * size
  }
}

/** A card's words: its file's name (og/<name>-<hash>.png), one or two lines of at most 24 characters and a caption of at
 *  most 70. */
/** The most a link preview's title holds (og:title, twitter:title): small cards cut a longer one. */
export const SHARE_TITLE_MAX = 40
/** A page's title on link previews: the first of its forms that fits SHARE_TITLE_MAX, most specific first, each made from
 *  the page's own data (its search title stays its <title>); with none that fits, the shortest. Every page family's head
 *  takes its link-preview title from here (price-pages.ts, site-pages.ts), so a page that names itself in a few words
 *  gets a short one for nothing. */
export function shareTitle(...forms: (string | null | undefined)[]): string {
  const named = forms.filter((form): form is string => !!form)
  return named.find(form => form.length <= SHARE_TITLE_MAX) ?? named.reduce((short, form) => form.length < short.length ? form : short)
}

export type CardWords = { name: string; lines: [string] | [string, string]; caption: string }
export type Card = { file: string; alt: string; type: 'image/png'; width: number; height: number; source: Buffer }

const made = new Map<string, Card>()
/** The alt reads as sentences: a title's lines are one, and its caption another ("Terms of Service. Updated …"). */
const sentence = (text: string) => /[.!?:]$/.test(text) ? text : `${text}.`
/** The card for these words, drawn once a build: its file (under the build's root), its alt text (the words), its type
 *  and size, and its bytes. Throws when the words can't make one. */
export function linkCard(words: CardWords): Card {
  const key = JSON.stringify(words), known = made.get(key)
  if (known) return known
  const lines = words.lines.map(line => line.toUpperCase()), caption = words.caption.toUpperCase(), room = W - GRID.left - GRID.right
  const problems = [
    ...!/^[a-z0-9-]+$/.test(words.name) ? [`its name, ${words.name}, isn't lower-case letters, digits and hyphens`] : [],
    ...lines.flatMap((line, i) => !line.trim() ? [`line ${i + 1} is empty`] : measure(line, GRID.size, GRID.tracking) > room ? [`line ${i + 1}, “${words.lines[i]}”, is over ${maxLine()} characters`] : []),
    ...measure(caption, GRID.caption.size, GRID.caption.tracking) > room ? [`its caption, “${words.caption}”, is over ${maxCaption()} characters`] : [],
    // (The claims rule: a card states figures and dates, never that Nightmail is the cheapest or the best, and names no
    // provider it isn't compared with.)
    ...[...words.lines, words.caption].some(text => /\b(?:cheapest|best|lowest)\b|amazon ses|\bbento\b/i.test(text)) ? ['it says “cheapest”, “best” or “lowest”, or names Amazon SES or Bento'] : [],
  ]
  if (problems.length) throw new Error(`The ${words.name} card can't be made (app/link-card.ts): ${problems.join('; ')}.`)
  const rgb = new Uint8Array(W * H * 3), ground = rgbOf(THEME.ground)
  for (let i = 0; i < W * H; i++) rgb.set(ground, i * 3)
  const baselines = GRID.baselines.slice(2 - lines.length)
  lines.forEach((line, i) => { const layer = new Layer(); setText(layer, line, GRID.left, baselines[i]!, GRID.size, GRID.tracking); layer.paint(rgb, rgbOf(i === 0 ? THEME.ours : THEME.ink)) })
  const below = new Layer()
  setText(below, caption, GRID.left, GRID.caption.baseline, GRID.caption.size, GRID.caption.tracking)
  below.paint(rgb, rgbOf(THEME.soft))
  const mark = new Layer(), k = GRID.mark.cap / WORDMARK.h
  for (const shape of svgPath(WORDMARK.d, (x, y) => [GRID.left + x * k, GRID.mark.top + y * k])) mark.path(shape)
  mark.paint(rgb, rgbOf(THEME.soft), true)
  const source = png(rgb), card: Card = { file: `og/${words.name}-${createHash('sha256').update(rgb).digest('hex').slice(0, 10)}.png`, alt: [words.lines.join(' '), words.caption].map(sentence).join(' '), type: 'image/png', width: W, height: H, source }
  made.set(key, card)
  return card
}
/** The most characters a line or the caption holds. */
export const maxLine = () => Math.floor((W - GRID.left - GRID.right + GRID.tracking * GRID.size) / ((fontOf().advance / fontOf().unitsPerEm + GRID.tracking) * GRID.size))
export const maxCaption = () => Math.floor((W - GRID.left - GRID.right + GRID.caption.tracking * GRID.caption.size) / ((fontOf().advance / fontOf().unitsPerEm + GRID.caption.tracking) * GRID.caption.size))

const attr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
/** A page's HTML (made from index.html) with this card in its link-preview tags: og:image and twitter:image at
 *  origin/file, its type, width and height, and its words as both alts. Its titles and descriptions are the page's own
 *  business and stay as they are. Throws when the HTML lacks one of the tags. */
export function withCard(html: string, card: Card, origin: string): string {
  const tags: [string, string][] = [['property="og:image"', `${origin}/${card.file}`], ['name="twitter:image"', `${origin}/${card.file}`], ['property="og:image:type"', card.type],
    ['property="og:image:width"', String(card.width)], ['property="og:image:height"', String(card.height)], ['property="og:image:alt"', card.alt], ['name="twitter:image:alt"', card.alt]]
  for (const [name, value] of tags) {
    const tag = new RegExp(`(<meta ${name} content=")[^"]*`)
    if (!tag.test(html)) throw new Error(`The page has no <meta ${name}> for its card (app/link-card.ts).`)
    html = html.replace(tag, (_match, start: string) => start + attr(value))
  }
  return html
}
