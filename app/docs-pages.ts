import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { productName, publicOrigin } from '../api/src/brand.ts'
import { RENAMED_OPERATIONS } from '../api/src/site-index.ts'
import { GUIDE_NAMES } from './src/features/docs/guide-names.ts'
import { docsTitle, operationDescription, operationEntries } from './src/features/docs/meta.ts'

// The docs' own pages (features/docs): docs.html for /docs, docs/<guide>.html for each guide (guide-names.ts) and
// docs/api/<id>.html for every operation in api/openapi.json (the definition the docs render). Each is index.html with that page's title,
// description, canonical address and Markdown twin in its head (features/docs/meta.ts; the page sets the same as it
// renders), so a search engine or an agent reading the first response knows which page it is and where its text is.
// The body is the dashboard's, and the docs render in it as before. Workers Assets and api/src/server.ts serve each
// file at its address; an operation with no page is not found (api/src/site-index.ts, isMissingDocsPage). The canonical
// address names the hosted site on every stage, as the price pages' does; a stage on another host still asks not to be
// indexed (vite.config.ts, publicOrigin).
const attr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
const openApi = fileURLToPath(new URL('../api/openapi.json', import.meta.url))

type DocsPage = { path: string; title: string; description: string; markdown: string }

export function docsPages(): Plugin {
  return {
    name: 'nightmail:docs-pages', apply: 'build', enforce: 'post',
    generateBundle: { order: 'post', handler(_options, bundle) {
      const index = bundle['index.html']
      if (index?.type !== 'asset') return this.error('The docs pages are made from index.html, and the bundle has none.')
      const document = JSON.parse(readFileSync(openApi, 'utf8')) as { info: { description?: string }; paths: Record<string, Record<string, unknown>> }
      const pages: DocsPage[] = [
        { path: '/docs', title: docsTitle(null), description: document.info.description ?? '', markdown: '/docs.md' },
        ...GUIDE_NAMES.map(guide => ({ path: `/docs/${guide.id}`, title: docsTitle(guide.title), description: guide.summary, markdown: '/docs.md' })),
        ...operationEntries(document).map(operation => ({ path: `/docs/api/${operation.id}`, title: docsTitle(operation.summary), description: operationDescription(operation), markdown: `/docs/operations/${operation.id}.md` })),
      ]
      const source = String(index.source)
      for (const page of pages) {
        let html = source
        const set = (pattern: RegExp, value: string) => {
          if (!pattern.test(html)) this.error(`index.html has no ${pattern.source} for ${page.path}.`)
          html = html.replace(pattern, (_match, start: string) => start + value)
        }
        const canonical = publicOrigin + page.path
        set(/(<title>)[^<]*/, attr(page.title))
        for (const name of ['name="description"', 'property="og:description"', 'name="twitter:description"']) set(new RegExp(`(<meta ${name} content=")[^"]*`), attr(page.description))
        for (const name of ['property="og:title"', 'name="twitter:title"']) set(new RegExp(`(<meta ${name} content=")[^"]*`), attr(page.title))
        set(/(<!-- Link previews\.)[^>]*-->/, ' This docs page\'s own (app/docs-pages.ts). -->')
        set(/(<meta property="og:type" content="website" \/>)/, `\n    <meta property="og:url" content="${attr(canonical)}" />\n    <link rel="canonical" href="${attr(canonical)}" />`)
        set(/(<link rel="alternate" type="text\/markdown" href=")[^"]*(?=" title=")/, attr(publicOrigin + page.markdown))
        set(/(<link rel="alternate" type="text\/markdown" href="[^"]*" title=")[^"]*/, attr(`${page.title}, in Markdown`))
        this.emitFile({ type: 'asset', fileName: `${page.path.slice(1)}.html`, source: html })
      }
      // An old name redirects to its new page (site-index.ts): the page must exist, and the old name must be no operation's.
      for (const [old, now] of Object.entries(RENAMED_OPERATIONS)) if (!pages.some(page => page.path === `/docs/api/${now}`) || pages.some(page => page.path === `/docs/api/${old}`)) this.error(`RENAMED_OPERATIONS (api/src/site-index.ts) sends ${old} to ${now}, which has no reference page, or ${old} is an operation again.`)
      if (!pages.some(page => page.path === '/docs/api/sendEmail')) this.error(`The docs pages have no sendEmail: api/openapi.json isn't ${productName}'s API definition.`)
    } },
  }
}
