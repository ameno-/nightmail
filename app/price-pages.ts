import type { Plugin } from 'vite'
import { productName } from '../api/src/brand.ts'
import { PRICE_PAGES_LIVE } from './src/features/pricing/live.ts'
import { PRICE_PAGES } from './src/features/pricing/pages.ts'

// pricing.html, compare/mailchimp.html and compare/resend.html: index.html with each price page's own title, description
// and link preview (features/pricing/pages.ts), so a shared link and a search result name the page and not the homepage.
// Workers Assets answers /pricing with pricing.html, and api/src/server.ts does the same on Node. Until PRICE_PAGES_LIVE,
// each also asks search engines not to index it.
const attr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')

export function pricePages(): Plugin {
  return {
    name: 'nightmail:price-pages', apply: 'build', enforce: 'post',
    generateBundle: { order: 'post', handler(_options, bundle) {
      const index = bundle['index.html']
      if (index?.type !== 'asset') return this.error('The price pages are made from index.html, and the bundle has none.')
      const source = String(index.source)
      const origin = /<meta property="og:image" content="([^"]+)\/og\.png"/.exec(source)?.[1]
      if (!origin) return this.error('The price pages need index.html\'s og:image, to name their own address beside it.')
      for (const page of PRICE_PAGES) {
        const title = `${page.title} · ${productName.toLowerCase()}`
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
        set(/(<!-- Link previews\.)[^>]*-->/, ' This page\'s own (app/price-pages.ts). -->')
        set(/(<meta property="og:type" content="website" \/>)/, `\n    <meta property="og:url" content="${attr(origin + page.path)}" />`)
        if (!PRICE_PAGES_LIVE) set(/(<meta charset="UTF-8" \/>)/, '\n    <meta name="robots" content="noindex" />')
        this.emitFile({ type: 'asset', fileName: page.file, source: html })
      }
    } },
  }
}
