import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { productName, publicOrigin as canonicalOrigin } from '../api/src/brand.ts'
import { PRICE_PAGES_LIVE } from './src/features/pricing/live.ts'
import { PRICE_PAGES } from './src/features/pricing/pages.ts'

// pricing.html, compare/mailchimp.html and compare/resend.html: index.html with each price page's own title, description,
// canonical address and link preview, its card included (features/pricing/pages.ts), so a shared link and a search
// result name the page and not the homepage. Workers Assets answers /pricing with pricing.html, and api/src/server.ts
// does the same on Node. The canonical address, og:url and the sitemap name the hosted site (brand.ts) on every stage;
// the card is fetched from the stage's own host, as index.html's is. While PRICE_PAGES_LIVE is false each page asks
// search engines not to index it and the sitemap leaves it out.
// Also robots.txt (every crawler welcome, and where the sitemap is) and sitemap.xml: the homepage and the price pages,
// the site's pages with HTML of their own.
const attr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')

export function pricePages(): Plugin {
  let publicDir = ''
  return {
    name: 'nightmail:price-pages', apply: 'build', enforce: 'post',
    configResolved(config) { publicDir = config.publicDir },
    generateBundle: { order: 'post', handler(_options, bundle) {
      const index = bundle['index.html']
      if (index?.type !== 'asset') return this.error('The price pages are made from index.html, and the bundle has none.')
      const source = String(index.source)
      const origin = /<meta property="og:image" content="([^"]+)\/og\.png"/.exec(source)?.[1]
      if (!origin) return this.error('The price pages need index.html\'s og:image, to name their own address beside it.')
      for (const page of PRICE_PAGES) {
        if (!existsSync(resolve(publicDir, page.card.file))) return this.error(`${page.path}'s card, public/${page.card.file}, is missing: what it shows has changed (features/pricing/pages.ts). Make it with node scripts/price-cards.mjs and delete the old one.`)
        const title = `${page.title} · ${productName.toLowerCase()}`, canonical = canonicalOrigin + page.path, image = `${origin}/${page.card.file}`
        let html = source
        const set = (pattern: RegExp, value: string) => {
          if (!pattern.test(html)) this.error(`index.html has no ${pattern.source} for ${page.file}.`)
          html = html.replace(pattern, (_match, start: string) => start + value)
        }
        set(/(<title>)[^<]*/, attr(title))
        set(/(<meta name="description" content=")[^"]*/, attr(page.description))
        set(/(<meta property="og:title" content=")[^"]*/, attr(title))
        set(/(<meta property="og:description" content=")[^"]*/, attr(page.description))
        set(/(<meta name="twitter:title" content=")[^"]*/, attr(title))
        set(/(<meta name="twitter:description" content=")[^"]*/, attr(page.description))
        for (const name of ['property="og:image"', 'name="twitter:image"']) set(new RegExp(`(<meta ${name} content=")[^"]*`), attr(image))
        for (const name of ['property="og:image:alt"', 'name="twitter:image:alt"']) set(new RegExp(`(<meta ${name} content=")[^"]*`), attr(page.card.alt))
        set(/(<meta property="og:image:type" content=")[^"]*/, 'image/jpeg')
        set(/(<!-- Link previews\.)[^>]*-->/, ' This page\'s own (app/price-pages.ts). -->')
        set(/(<meta property="og:type" content="website" \/>)/, `\n    <meta property="og:url" content="${attr(canonical)}" />\n    <link rel="canonical" href="${attr(canonical)}" />`)
        if (!PRICE_PAGES_LIVE) set(/(<meta charset="UTF-8" \/>)/, '\n    <meta name="robots" content="noindex" />')
        this.emitFile({ type: 'asset', fileName: page.file, source: html })
      }
      const listed = ['/', ...PRICE_PAGES_LIVE ? PRICE_PAGES.map(page => page.path) : []]
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: `User-agent: *\nAllow: /\n\nSitemap: ${canonicalOrigin}/sitemap.xml\n` })
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${listed.map(path => `  <url><loc>${canonicalOrigin}${path}</loc></url>\n`).join('')}</urlset>\n` })
    } },
  }
}
