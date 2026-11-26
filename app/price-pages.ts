import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runnerImport, type Plugin } from 'vite'
import { productName, publicOrigin as canonicalOrigin } from '../api/src/brand.ts'
import { CRAWL_DISALLOW, isPublicPage, SITE_ROOT_PAGES } from '../api/src/site-index.ts'
import { linkCard, shareTitle, withCard } from './link-card.ts'
import { appFiles, FIRST_FONTS, pageCss, paint } from './painted-page.ts'
import { ENTRIES } from './src/features/pricing/compare/index.ts'
import { docProblems } from './src/features/pricing/docs/index.ts'
import { PRICE_LINKS, PRICE_PAGES_LIVE } from './src/features/pricing/live.ts'
import { PRICE_PAGES, type PricePage } from './src/features/pricing/pages.ts'
import { comparisonDoc } from './src/features/pricing/page/comparison.ts'
import { hubCard, hubDoc, hubMarkdown } from './src/features/pricing/page/hub.ts'
import type { PageDoc } from './src/features/pricing/page/shape.ts'
import { PANEL_IDS } from './src/features/pricing/panels.ts'
import { entryProblems } from './src/features/pricing/prices.ts'
import * as readable from './src/features/pricing/readable.ts'
import { jsonLd, llmsSiteIndex, markdownPath } from './src/features/pricing/readable.ts'

// The public price pages and what's made with them (features/pricing):
// - pricing.html and compare/<slug>.html, one for every comparison's entry (compare/index.ts): index.html with the
//   page's own title, description, canonical address, link preview (its card, drawn here from its words: pages.ts,
//   link-card.ts), Markdown twin and structured data, and the page itself painted from the HTML alone (prerender.tsx: the scene as the app first draws
//   it, in #price-shell) with the CSS it needs inlined, so it shows before any of the app's code (painted-page.ts says
//   how, and how the app's page takes the painted one's place, what the reader typed carried over). The Worker answers /pricing
//   with pricing.html from the assets, compressed (api/src/worker.ts), and api/src/server.ts does the same on Node; an
//   address under /compare/ with no page is not found.
// - With the comparisons drawn from their data (verdict: every build but VITE_PRICE_PAGES=board, page/switch.ts), each
//   compare/<slug>.html is instead the page drawn from its data (page/comparison.ts, drawn by page/page.tsx) with its CSS
//   inlined and none of the app's code, which it doesn't need (its links are plain links, and Get started opens
//   Overview); and there is compare.html, every comparison on one page (page/hub.ts), with its Markdown twin
//   compare.md and its places in the sitemap and llms.txt. compare/with-set.html is /compare with the homepage's television over it,
//   while Ryan chooses (noindex, its canonical /compare). The Worker answers /compare with compare.html as it does the
//   comparisons (api/src/worker.ts). Without it, the build writes exactly what it did before.
// - Each page's Markdown twin, and the homepage's (readable.ts): pricing.md, compare/<slug>.md, index.md;
//   llms-site.txt, the lines the API's llms.txt puts under its title (api/src/site-index.ts); llms-full.txt.
// - robots.txt (every crawler welcome to the pages, not to the API: api/src/site-index.ts, CRAWL_DISALLOW; and where the
//   sitemap is) and sitemap.xml: the homepage and the price pages.
// The canonical address, og:url, the twins' links and the sitemap name the hosted site (brand.ts) on every stage; the
// card is fetched from the stage's own host, as index.html's is. While PRICE_PAGES_LIVE is false each page asks search
// engines not to index it and the sitemap leaves it out. The build stops on an entry without its sources (prices.ts,
// entryProblems) and on a footer link to a page that doesn't exist. What the twins and the structured data say of the
// homepage and the product comes from `words`: readable.ts, or with the television homepage features/home/tv/readable.ts.
const attr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
const prerenderModule = fileURLToPath(new URL('./src/features/pricing/prerender.tsx', import.meta.url))
const pagesModule = fileURLToPath(new URL('./src/features/pricing/page/prerender.tsx', import.meta.url))
const pricingAt = fileURLToPath(new URL('./src/features/pricing/', import.meta.url))
const bootScript = fileURLToPath(new URL('./src/features/home/shell/boot.js', import.meta.url))
export function pricePages(words: Pick<typeof readable, 'llmsFull' | 'markdownFiles' | 'structuredData'> = readable, verdict = false): Plugin {
  let publicDir = '', root = ''
  return {
    name: 'nightmail:price-pages', apply: 'build', enforce: 'post',
    configResolved(config) { publicDir = config.publicDir; root = config.root },
    generateBundle: { order: 'post', async handler(_options, bundle) {
      const today = new Date().toISOString().slice(0, 10)
      const problems = [...ENTRIES.flatMap(entry => entryProblems(entry, today, PANEL_IDS)), ...docProblems()]
      if (new Set(ENTRIES.map(entry => entry.slug)).size !== ENTRIES.length) problems.push('Two comparisons have the same slug.')
      for (const [path] of PRICE_LINKS) if (!PRICE_PAGES.some(page => page.path === path)) problems.push(`live.ts links ${path}, which is no price page.`)
      // Every page written here is a public page, where a visitor isn't asked for a session (public/theme.js, data/live.ts),
      // and the top-level ones are the API's list of them (site-index.ts, SITE_ROOT_PAGES), which the Worker serves.
      const roots = PRICE_PAGES.map(page => page.path).filter(path => /^\/[^/]+$/.test(path) && path !== '/pricing' && path !== '/compare')
      for (const path of roots) if (!SITE_ROOT_PAGES.includes(path)) problems.push(`${path} is a page at the top level that api/src/site-index.ts's SITE_ROOT_PAGES leaves out.`)
      for (const path of SITE_ROOT_PAGES) if (!roots.includes(path)) problems.push(`api/src/site-index.ts's SITE_ROOT_PAGES names ${path}, which the build doesn't write.`)
      for (const page of PRICE_PAGES) {
        if (!isPublicPage(page.path)) problems.push(`${page.path} isn't a public page to api/src/site-index.ts (PUBLIC_PAGE): a visitor would be asked for a session there.`)
        if (!(page.searchTitle?.length <= 60)) problems.push(`${page.path}'s title is over 60 characters: ${page.searchTitle}`)
        if (!(page.description?.length <= 160)) problems.push(`${page.path}'s description is over 160 characters: ${page.description}`)
      }
      if (problems.length) return this.error(`The price pages can't be built (features/pricing/compare):\n  ${problems.join('\n  ')}`)

      const index = bundle['index.html']
      if (index?.type !== 'asset') return this.error('The price pages are made from index.html, and the bundle has none.')
      const source = String(index.source)
      const origin = /<meta property="og:image" content="([^"]+)\/og\.png"/.exec(source)?.[1]
      if (!origin) return this.error('The price pages need index.html\'s og:image, to name their own address beside it.')

      // The app's files, out of the page (the boot script starts them), and the CSS the price pages load.
      const files = appFiles(source)
      if (!files) return this.error('index.html is not shaped as the price pages expect: one entry module and one stylesheet, and #root.')
      const { template } = files
      const css = [...new Set([files.css.slice(1), ...pageCss(bundle, ['/features/pricing/index.tsx', '/features/pricing/board-page.tsx'])])].map(file => {
        const asset = bundle[file]
        if (asset?.type !== 'asset') this.error(`The price pages' stylesheet ${file} isn't in the bundle.`)
        return String((asset as { source: string | Uint8Array }).source)
      }).join('')
      const fileOf = (path: string) => {
        const file = Object.values(bundle).find(item => item.type === 'asset' && item.originalFileNames.some(name => name.endsWith(path)))
        if (!file) this.error(`The price pages need ${path} in the bundle (board.css links it).`)
        return `/${file!.fileName}`
      }
      // The pictures of the first screen: the board's concrete (the largest thing on it, at the window's density) and the
      // wall behind it, the phone's or the wide window's (board.css).
      const wall = { phone: fileOf('pricing/board/wall-828.avif'), wide: fileOf('pricing/board/wall-1920.avif') }
      const boot = `/${this.getFileName(this.emitFile({ type: 'asset', name: 'home-boot.js', source: readFileSync(bootScript) }))}`
      for (const font of FIRST_FONTS) if (!existsSync(resolve(publicDir, font.url.slice(1)))) return this.error(`public${font.url} is missing (features/pricing/fonts/README.md makes it).`)
      const moondust = { x1: fileOf('pricing/board/moondust-384.avif'), x2: fileOf('pricing/board/moondust-768.avif') }
      const { module: prerender } = await runnerImport<typeof import('./src/features/pricing/prerender.tsx')>(prerenderModule, { root, configFile: false, logLevel: 'error' })
      // With the new look: the pages drawn from their data, the CSS they load in the app (page/view.tsx: page.css and the
      // television's tv.css), and the set's photograph for /compare drawn with it.
      // (The vendors' pricing pages, docs/, are drawn so in every build.)
      const drawn = verdict || PRICE_PAGES.some(page => page.doc) ? {
        render: (await runnerImport<typeof import('./src/features/pricing/page/prerender.tsx')>(pagesModule, { root, configFile: false, logLevel: 'error' })).module.renderPage,
        css: [...new Set([files.css.slice(1), ...pageCss(bundle, ['/features/pricing/page/view.tsx'])])].map(file => {
          const asset = bundle[file]
          if (asset?.type !== 'asset') this.error(`The price pages' stylesheet ${file} isn't in the bundle.`)
          return String((asset as { source: string | Uint8Array }).source)
        }).join(''),
        scene: fileOf('home/tv/crt/scene.webp'),
      } : null
      const hub = hubDoc(), hubPage: PricePage = { path: hub.path, file: 'compare.html', title: hub.title, searchTitle: hub.searchTitle, shareTitle: 'Email API pricing compared', description: hub.description, card: hubCard(), comparison: null, modified: hub.modified }
      const written: { page: PricePage; file: string; doc?: PageDoc; set?: boolean; robots?: boolean }[] = [
        ...PRICE_PAGES.map(page => ({ page, file: page.file, doc: page.doc ?? (verdict && page.comparison ? comparisonDoc(page.comparison) : undefined) })),
        ...verdict ? [{ page: hubPage, file: hubPage.file, doc: hub }, { page: hubPage, file: 'compare/with-set.html', doc: hub, set: true, robots: true }] : [],
      ]

      for (const { page, file, doc, set: withSet, robots } of written) {
        // Search results get the page's search title; link previews a short one (link-card.ts, shareTitle).
        const title = page.searchTitle, share = shareTitle(page.shareTitle, page.title, page.searchTitle), canonical = canonicalOrigin + page.path, card = linkCard(page.card)
        if (!bundle[card.file]) this.emitFile({ type: 'asset', fileName: card.file, source: card.source })
        let html = withCard(template, card, origin)
        const set = (pattern: RegExp, value: string) => {
          if (!pattern.test(html)) this.error(`index.html has no ${pattern.source} for ${file}.`)
          html = html.replace(pattern, (_match, start: string) => start + value)
        }
        set(/(<title>)[^<]*/, attr(title))
        set(/(<meta name="description" content=")[^"]*/, attr(page.description))
        set(/(<meta property="og:title" content=")[^"]*/, attr(share))
        set(/(<meta property="og:description" content=")[^"]*/, attr(page.description))
        set(/(<meta name="twitter:title" content=")[^"]*/, attr(share))
        set(/(<meta name="twitter:description" content=")[^"]*/, attr(page.description))
        set(/(<!-- Link previews\.)[^>]*-->/, ' This page\'s own (app/price-pages.ts). -->')
        set(/(<meta property="og:type" content="website" \/>)/, `\n    <meta property="og:url" content="${attr(canonical)}" />\n    <link rel="canonical" href="${attr(canonical)}" />`)
        set(/(<link rel="alternate" type="text\/markdown" href=")[^"]*(?=" title=")/, attr(canonicalOrigin + markdownPath(page.path)))
        set(/(<link rel="alternate" type="text\/markdown" href="[^"]*" title=")[^"]*/, attr(`${page.title}, in Markdown`))
        if (!PRICE_PAGES_LIVE) set(/(<meta charset="UTF-8" \/>)/, '\n    <meta name="robots" content="noindex" />')
        if (doc && drawn) {
          // A page drawn from its data: the page itself, its CSS and fonts (and the set's photograph, drawn with it), and its
          // structured data with where it sits.
          if (robots && !html.includes('<meta name="robots"')) set(/(<meta charset="UTF-8" \/>)/, '\n    <meta name="robots" content="noindex" />')
          const body = drawn.render(doc, withSet).replace(/\/src\/features\/home\/tv\/crt\/scene\.webp/g, drawn.scene)
          set(/(<link rel="manifest" href="\/site.webmanifest" \/>)/, `\n    <script type="application/ld+json">${jsonLd(page === hubPage ? hubData(page, doc) : withCrumbs(words.structuredData(page), page, doc))}</script>`)
          // Painted as a visitor sees it, as the boards are (#price-shell), and the app's page takes over from it at the
          // reader's first touch, key or scroll (page/pricing.tsx): its Get started then signs in, or says Join the
          // waitlist, or is Open dashboard.
          html = paint(html, { shell: 'price-shell', body, css: drawn.css, preloads: withSet ? [`<link rel="preload" href="${drawn.scene}" as="image" fetchpriority="high" />`] : [], keep: '.boot-loader, .price-page, .pp', boot, files })
          this.emitFile({ type: 'asset', fileName: file, source: html })
          continue
        }
        // The page, painted, with what it needs to show: its CSS, its first picture, and its structured data.
        const shell = prerender.renderShell(page)
        set(/(<link rel="manifest" href="\/site.webmanifest" \/>)/, `\n    <script type="application/ld+json">${jsonLd(words.structuredData(page))}</script>`)
        html = paint(html, { shell: 'price-shell', body: shell, css, keep: '.boot-loader, .price-page', boot, files, preloads: [
          `<link rel="preload" as="image" imagesrcset="${moondust.x1} 1x, ${moondust.x2} 2x" type="image/avif" fetchpriority="high" />`,
          `<link rel="preload" href="${wall.phone}" as="image" type="image/avif" media="(max-width: 640px)" />`,
          `<link rel="preload" href="${wall.wide}" as="image" type="image/avif" media="(min-width: 641px)" />`,
        ] })
        this.emitFile({ type: 'asset', fileName: file, source: html })
      }
      for (const { file, source } of words.markdownFiles()) this.emitFile({ type: 'asset', fileName: file, source })
      if (verdict) this.emitFile({ type: 'asset', fileName: 'compare.md', source: hubMarkdown(hub) })
      this.emitFile({ type: 'asset', fileName: 'llms-site.txt', source: llmsSiteIndex(verdict ? [`- [Compare](${canonicalOrigin}/compare.md): ${hub.llms}`] : []) })
      this.emitFile({ type: 'asset', fileName: 'llms-full.txt', source: words.llmsFull() })
      // The homepage's lastmod: the newest figure it quotes or links (every comparison's, which the price pages carry).
      const listed = [{ path: '/', modified: PRICE_PAGES.map(page => page.modified).sort().at(-1)! }, ...PRICE_PAGES_LIVE ? [...PRICE_PAGES, ...verdict ? [hubPage] : []].map(page => ({ path: page.path, modified: page.modified })) : []]
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: `User-agent: *\nAllow: /\n${CRAWL_DISALLOW.map(path => `Disallow: ${path}\n`).join('')}\nSitemap: ${canonicalOrigin}/sitemap.xml\n` })
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${listed.map(({ path, modified }) => `  <url><loc>${canonicalOrigin}${path}</loc>${modified ? `<lastmod>${modified}</lastmod>` : ''}</url>\n`).join('')}</urlset>\n` })
    } },
  }
}

/** The files a price page's first screen and its app need, for the cache rules (asset-headers.ts): next in line after
 *  the homepage's. */
export const priceFirstFiles = (files: string[]) => [/^assets\/(?:moondust-\d+|wall-\d+|lamp)-[\w-]+\.(?:avif|webp)$/, /^assets\/(?:pricing|board-page|machines)-[\w-]+\.(?:js|css)$/]
  .flatMap(pattern => files.filter(name => pattern.test(name)))

/** With the comparisons' new look (page/switch.ts), the app's price pages: App.tsx's import of features/pricing is
 *  page/pricing.tsx (a comparison and /compare drawn from their data, the calculator as before), as the television homepage
 *  swaps its own in (home-tv.ts). Without it, the app is what it was. */
export const verdictApp = (): Plugin => ({
  name: 'nightmail:verdict-app', enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || importer.startsWith(pricingAt) || !/(?:^|\/)pricing(?:\/index)?(?:\.tsx?)?$/.test(source)) return null
    const found = await this.resolve(source, importer, { ...options, skipSelf: true })
    return found?.id === `${pricingAt}index.tsx` ? `${pricingAt}page/pricing.tsx` : found
  },
})

const home = { '@type': 'ListItem', position: 1, name: productName, item: `${canonicalOrigin}/` }
/** A page's structured data with where it sits (its crumbs: Home › Compare › the vendor), as its breadcrumb shows. */
function withCrumbs(data: object, page: PricePage, doc: PageDoc) {
  const graph = (data as { '@graph'?: object[] })['@graph']
  graph?.push({ '@type': 'BreadcrumbList', '@id': `${canonicalOrigin}${page.path}#breadcrumb`, itemListElement: doc.crumbs.map((crumb, i) => ({ '@type': 'ListItem', position: i + 1, name: crumb.name, item: canonicalOrigin + crumb.path })) })
  return data
}
/** /compare's structured data (the SEO audit's spec): the page as a collection, the comparisons it lists in its order,
 *  and where it sits (Home › Compare). */
function hubData(page: PricePage, doc: PageDoc) {
  const url = canonicalOrigin + page.path, rows = doc.sections.flatMap(section => section.blocks.flatMap(block => block.kind === 'table' ? block.rows.flatMap(row => row.cells[0]!.flatMap(part => typeof part === 'object' && 'href' in part ? [part] : [])) : []))
  return { '@context': 'https://schema.org', '@graph': [
    { '@type': 'CollectionPage', '@id': url, url, name: page.searchTitle, description: page.description, inLanguage: 'en', dateModified: page.modified, mainEntity: { '@id': `${url}#list` }, breadcrumb: { '@id': `${url}#breadcrumb` } },
    { '@type': 'ItemList', '@id': `${url}#list`, numberOfItems: rows.length, itemListElement: rows.map((row, i) => ({ '@type': 'ListItem', position: i + 1, name: `${productName} vs ${row.text}`, url: canonicalOrigin + row.href })) },
    { '@type': 'BreadcrumbList', '@id': `${url}#breadcrumb`, itemListElement: [home, { '@type': 'ListItem', position: 2, name: 'Compare', item: url }] },
  ] }
}
