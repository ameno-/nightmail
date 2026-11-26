import type { Rollup } from 'vite'
import { pruneCss, usedNames } from './critical-css.ts'

// A public page painted from its HTML alone before any of the app's code: the price pages (price-pages.ts) and the legal
// pages (site-pages.ts). The page is drawn at build time from the components the app draws it with, in a shell over
// #root with the CSS it needs inlined (critical-css.ts) and the first fonts. The app's stylesheet and modules are out of
// the page: the boot script (home/shell/boot.js) starts them at the reader's first touch, key or scroll (a press held)
// or after 8 s, and the app's page then takes the painted one's place (lib/shell-takeover.ts), in the same frame and at
// the same place. Where theme.js turns the shell off (html[data-shell=off]: an address it doesn't show, or for a page
// that asks it, a browser that has signed in), the app draws the page from the start, as on any other page.

/** Over the app's own page until it takes over, and not at all where theme.js turned it off. Unseen until all of it has
 *  arrived (#root follows it): drawn while its HTML streams in, its rows would grow as the rest arrived. Chrome doesn't
 *  draw at all until then (<link rel="expect">, paint()); this keeps it still in browsers that ignore that. The rest is
 *  the app's stylesheet, cut down (it has no visibility:visible to show through). */
export const shellCss = (id: string) => `#${id}{position:absolute;top:0;left:0;z-index:2147483000;width:100%}html[data-shell=off] #${id}{display:none}body:not(:has(>#root)) #${id}{visibility:hidden}`
/** The first fonts (public/fonts/*-basic.woff2, features/pricing/fonts/README.md): the app's, cut down to these
 *  characters, and preloaded. The painted page knows only these (its CSS leaves out the app's own faces of those
 *  families: WHOLE_FACES), so it fetches nothing else; once the app's stylesheet is in, they still serve these
 *  characters (defined after its faces) and the whole fonts only the others. */
export const BASIC = 'U+0020-007E,U+00A0,U+00A9,U+00AB,U+00AE,U+00B7,U+00BB,U+00D7,U+2010-2027,U+2030,U+2039-203A,U+20AC,U+2122,U+2190-2193,U+2212,U+2713,U+FEFF,U+FFFD'
export const FIRST_FONTS = [{ family: 'Inter', file: 'inter-basic.woff2', weight: '100 900' }, { family: 'OpenTUI Mono', file: 'opentui-regular-basic.woff2', weight: '400' }, { family: 'OpenTUI Mono', file: 'opentui-bold-basic.woff2', weight: '700' }].map(font => ({ ...font, url: `/fonts/${font.file}` }))
export const firstFaces = FIRST_FONTS.map(font => `@font-face{font-family:'${font.family}';src:url(${font.url}) format('woff2');font-style:normal;font-weight:${font.weight};font-display:swap;unicode-range:${BASIC}}`).join('')
/** What public/theme.js may set on <html> before the first paint, which the page's CSS may select. */
export const THEME_ATTRIBUTES = ['data-theme', 'data-shell', 'data-member', 'data-overview-panel', 'style']
export const WHOLE_FACES = /@font-face\{font-family:(?:Inter|OpenTUI Mono|"Inter"|"OpenTUI Mono");[^}]*\}/g

/** The app's files in index.html, and index.html without them (the boot script starts them). Null where it isn't shaped
 *  as a painted page expects: one entry module, one stylesheet, and #root. */
export function appFiles(source: string) {
  let template = source
  const take = (pattern: RegExp) => { const found = [...template.matchAll(pattern)].map(match => match[1]!); template = template.replace(pattern, ''); return found }
  const entry = take(/\s*<script type="module" crossorigin src="([^"]+)"><\/script>/g), preload = take(/\s*<link rel="modulepreload" crossorigin href="([^"]+)">/g), styles = take(/\s*<link rel="stylesheet" crossorigin href="([^"]+)">/g)
  if (entry.length !== 1 || styles.length !== 1 || !template.includes('<div id="root"></div>')) return null
  return { template, entry: entry[0]!, preload, css: styles[0]! }
}
export type AppFiles = NonNullable<ReturnType<typeof appFiles>>

/** The stylesheets the chunks of these modules load, theirs and their imports'. */
export function pageCss(bundle: Rollup.OutputBundle, modules: string[]) {
  const css = new Set<string>(), seen = new Set<string>()
  const visit = (chunk: Rollup.OutputChunk) => {
    if (seen.has(chunk.fileName)) return
    seen.add(chunk.fileName)
    for (const file of chunk.viteMetadata?.importedCss ?? []) css.add(file)
    for (const name of chunk.imports) { const next = bundle[name]; if (next?.type === 'chunk') visit(next) }
  }
  for (const module of modules) {
    const chunk = Object.values(bundle).find((item): item is Rollup.OutputChunk => item.type === 'chunk' && !!item.facadeModuleId?.endsWith(module))
    if (chunk) visit(chunk)
  }
  return [...css]
}

export type Paint = {
  /** The shell's id, as boot.js and the app's takeover find it. */
  shell: string
  /** The page as the app draws it, and the CSS it loads in the app (pruned here to what the page uses). */
  body: string
  css: string
  /** CSS of the painted page alone, after the shell's. */
  extraCss?: string
  /** Pictures of the first screen, preloaded after the fonts. */
  preloads?: string[]
  /** What the app may show under the shell before its page (a spinner), and its page: boot.js keeps the shell over them. */
  keep: string
  /** The boot script's file, and the app's (appFiles). */
  boot: string
  files: AppFiles
  /** Keep the app's own faces of the first fonts' families: a character outside the first fonts then comes from the face
   *  the app sets it in, as once the app is up (the legal pages' ÷), where without them it is the local fallback's until
   *  the app takes over. (The first fonts, defined after them, still serve their characters.) */
  wholeFaces?: boolean
  /** For a page a visitor reads: where this browser has signed in, theme.js turns the shell off before the first paint and
   *  the app draws the page from the start (public/theme.js, data-members). */
  members?: boolean
}

/** template (an appFiles template with this page's head) with the page painted over #root. Throws on a template that
 *  isn't index.html's shape. */
export function paint(template: string, page: Paint): string {
  let html = template
  const set = (pattern: RegExp, value: string) => {
    if (!pattern.test(html)) throw new Error(`index.html has no ${pattern.source}.`)
    html = html.replace(pattern, (_match, start: string) => start + value)
  }
  html = html.replace(/\s*<link rel="preload" href="\/fonts\/[^"]+" as="font" type="font\/woff2" crossorigin \/>/g, '')
  set(/(<script src="\/theme.js"><\/script>)/, [
    ...FIRST_FONTS.map(font => `<link rel="preload" href="${font.url}" as="font" type="font/woff2" crossorigin />`),
    ...page.preloads ?? [],
  ].map(line => `\n    ${line}`).join(''))
  set(/(<script src="\/theme.js")(?=><\/script>)/, page.members ? ' data-plain="" data-members=""' : ' data-plain=""')
  // Nothing is drawn until the whole painted page has arrived (#root follows it): over a slow connection a page drawn
  // while its HTML streams in grows as each row's rest arrives (Chrome; other browsers ignore it).
  set(/(<\/title>)/, '\n    <link rel="expect" href="#root" blocking="render" />')
  const pruned = pruneCss(page.css, usedNames(html + page.body, THEME_ATTRIBUTES))
  set(/(<\/title>)/, `\n    <style data-shell-css>${shellCss(page.shell)}${page.extraCss ?? ''}${page.wholeFaces ? pruned : pruned.replace(WHOLE_FACES, '')}</style>\n    <style>${firstFaces}</style>`)
  if (!html.includes('<div id="root"></div>')) throw new Error('index.html has no <div id="root"></div>.')
  const { files } = page
  return html.replace('<div id="root"></div>', `<div id="${page.shell}">${page.body}</div>\n    <div id="root"></div>\n    <script src="${page.boot}" defer data-shell="${page.shell}" data-press="button" data-wait="none" data-keep="${page.keep}" data-css="${files.css}" data-preload="${files.preload.join(' ')}" data-entry="${files.entry}"></script>`)
}
