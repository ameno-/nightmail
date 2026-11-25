// Reading CSS values for the design rules: the tokens tokens.css defines (to name the one to use instead), and the raw
// colours, lengths and font names a value holds.
import { readFileSync } from 'node:fs'

export type Tokens = { light: Map<string, string>; dark: Map<string, string> }

/** Custom properties tokens.css sets on :root (light) and on :root[data-theme='dark'] (dark, over light). */
export function readTokens(file: string): Tokens {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const light = new Map<string, string>(), dark = new Map<string, string>()
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = block[1]!.trim()
    if (!/^:root\b/.test(selector)) continue
    const into = /data-theme='dark'/.test(selector) ? dark : light
    for (const decl of block[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) into.set(decl[1]!, decl[2]!.trim())
  }
  return { light, dark }
}

/** A value with every var(--name, fallback) reduced to var(--name): a fallback never shows while the token is defined. */
export function primary(value: string): string {
  let out = '', i = 0
  while (i < value.length) {
    const at = value.indexOf('var(', i)
    if (at < 0) { out += value.slice(i); break }
    const name = /^var\(\s*(--[\w-]+)/.exec(value.slice(at))
    let depth = 0, end = at
    for (; end < value.length; end++) { if (value[end] === '(') depth++; if (value[end] === ')' && --depth === 0) break }
    out += value.slice(i, at) + (name ? `var(${name[1]})` : value.slice(at, end + 1))
    i = end + 1
  }
  return out
}

/** A value with its url(), strings and comments blanked out, so only what is drawn is left. */
export const bare = (value: string) => value.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g, 'url()').replace(/"[^"]*"|'[^']*'/g, '""')

const NAMED = 'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
const colorPattern = new RegExp(`#[0-9a-f]{3,8}(?![\\w-])|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\\((?:[^()]|\\([^()]*\\))*\\)|(?<![\\w-])(?:${NAMED.replaceAll(' ', '|')})(?![\\w-])`, 'gi')

/** Raw colours in a value. A colour function built only from tokens (the score card's oklch(var(--…) …)) is not raw;
 *  color-mix is, since it lays one colour over another at partial strength. */
export function rawColors(value: string): string[] {
  return [...bare(primary(value)).matchAll(colorPattern)].map(m => m[0]).filter(c => /^color-mix/i.test(c) || !/^\w+\(/.test(c) || /\d/.test(c.replace(/var\([^()]*(\([^()]*\))?[^()]*\)/g, '')))
}

export type Length = { text: string; px: number; unit: string }
/** Lengths written as numbers (px, rem, em, ch …) outside var() fallbacks. */
export function lengths(value: string): Length[] {
  const v = bare(value).replace(/var\((?:[^()]|\([^()]*\))*\)/g, ' ')
  return [...v.matchAll(/(?<![\w.#-])(-?\d*\.?\d+)(px|rem|em|ch|ex|lh|vw|vh|dvh|svh|%)?(?![\w%-])/g)]
    .filter(m => m[2] || Number(m[1]) !== 0)
    .map(m => ({ text: m[0], unit: m[2] ?? '', px: m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]) }))
}

/** The tokens whose value is exactly this colour (hex, case- and shorthand-insensitive), light then dark. */
export function tokensForColor(tokens: Tokens, color: string, dark = false): string[] {
  const hex = normalHex(color)
  if (!hex) return []
  const names = (map: Map<string, string>) => [...map].filter(([name, v]) => name.startsWith('--color-') && normalHex(v) === hex).map(([name]) => name)
  // The email's and the rules' colours are for those alone: offer them last.
  const special = (name: string) => /email|border|edge/.test(name) ? 1 : 0
  return [...new Set(dark ? [...names(tokens.dark), ...names(tokens.light)] : [...names(tokens.light), ...names(tokens.dark)])].sort((a, b) => special(a) - special(b))
}

/** What to use instead of a raw colour: the tokens with its value, else the nearest greys, else the general advice. */
export function colorAdvice(tokens: Tokens, color: string, prop: string, fallback: string, dark = false): string {
  const exact = tokensForColor(tokens, color, dark).slice(0, 3)
  if (exact.length) return `${exact.map(t => `var(${t})`).join(' or ')} (same value; pick the one named for its role)`
  if (prop === 'box-shadow' || prop === 'boxShadow') return 'var(--shadow-popover) or var(--shadow-dialog) for a lift; no other shadows.'
  if (/^color-mix|\/|rgba|hsla/i.test(color)) return 'A solid token for the role (tokens.css): surfaces and fills are solid, never one colour laid over another at partial strength.'
  const near = nearestGreys(tokens, color, dark)
  return near.length ? `The token for its role; nearest greys: ${near.map(t => `var(${t})`).join(', ')}.` : fallback
}

/** The grey tokens nearest a grey (R = G = B), for a colour no token has exactly. */
export function nearestGreys(tokens: Tokens, color: string, dark = false): string[] {
  const hex = normalHex(color)
  if (!hex || hex.slice(1, 3) !== hex.slice(3, 5) || hex.slice(3, 5) !== hex.slice(5, 7)) return []
  const level = parseInt(hex.slice(1, 3), 16)
  return [...(dark ? tokens.dark : tokens.light)].flatMap(([name, v]) => {
    const h = normalHex(v)
    return name.startsWith('--color-') && h && h.slice(1, 3) === h.slice(3, 5) && h.slice(3, 5) === h.slice(5, 7) ? [{ name, d: Math.abs(parseInt(h.slice(1, 3), 16) - level) }] : []
  }).sort((a, b) => a.d - b.d).slice(0, 2).map(t => t.name)
}

function normalHex(value: string): string | null {
  const v = value.trim().toLowerCase()
  if (v === 'white' || v === '#fff' || v === '#ffffff') return '#ffffff'
  if (v === 'black') return '#000000'
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v)
  if (!m) return null
  return '#' + (m[1]!.length === 3 ? [...m[1]!].map(c => c + c).join('') : m[1])
}

/** The scale tokens (--space-*, --radius-*, --text-*) by their px value. */
export function scale(tokens: Tokens, prefix: string): { name: string; px: number }[] {
  return [...tokens.light].filter(([name, v]) => name.startsWith(prefix) && /^\d+(\.\d+)?px$/.test(v)).map(([name, v]) => ({ name, px: parseFloat(v) }))
}

/** The token(s) for a px value on a scale: the exact step(s), else the two around it. */
export function nearest(steps: { name: string; px: number }[], px: number): string {
  const size = Math.abs(px), exact = steps.filter(s => s.px === size).map(s => `var(${s.name})`)
  const wrap = (v: string) => px < 0 ? `calc(-1 * ${v})` : v
  if (exact.length) return exact.map(wrap).join(' or ')
  const below = steps.filter(s => s.px < size).sort((a, b) => b.px - a.px)[0], above = steps.filter(s => s.px > size).sort((a, b) => a.px - b.px)[0]
  return [below, above].filter(Boolean).map(s => wrap(`var(${s!.name})`)).join(' or ') + ' (no step is ' + size + 'px)'
}
