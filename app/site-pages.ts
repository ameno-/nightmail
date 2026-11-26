import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { productName, publicOrigin } from '../api/src/brand.ts'
import { RENAMED_OPERATIONS } from '../api/src/site-index.ts'
import { renderLegal } from './legal-markdown.ts'
import { linkCard, maxLine, shareTitle, withCard, type CardWords } from './link-card.ts'
import { GUIDE_NAMES } from './src/features/docs/guide-names.ts'
import { docsTitle, operationDescription, operationEntries, operationTitle } from './src/features/docs/meta.ts'

// The site's own pages beside the price pages (price-pages.ts), each index.html with its own title, description,
// canonical address, Markdown twin and link-preview card in its head, so a search engine, an agent or a link preview
// reading the first response knows which page it is. The body is the dashboard's, byte for byte, and the page renders
// in it as before, signed in or out.
// - The docs (features/docs): docs.html for /docs, docs/<guide>.html for each guide (guide-names.ts) and
//   docs/api/<id>.html for every operation in api/openapi.json (the definition the docs render), with the titles and
//   descriptions the page sets as it renders (features/docs/meta.ts). Cards: one for /docs, one for each guide; the
//   operations share the docs' card.
// - The legal pages (features/legal): legal.html for /legal and legal/<slug>.html for each document in
//   features/legal/content, named and described by its front matter, its card dated by its `updated`. Each document's
//   Markdown is its twin (legal/<slug>.md), and the index's is legal.md.
// Workers Assets and api/src/server.ts serve each file at its address; an operation or a legal document with no page is
// not found (api/src/site-index.ts). The canonical address names the hosted site on every stage, as the price pages' does;
// the card is fetched from the stage's own host, as index.html's is; a stage on another host still asks not to be
// indexed (vite.config.ts, publicOrigin).
const attr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
const openApi = fileURLToPath(new URL('../api/openapi.json', import.meta.url))
const legalContent = fileURLToPath(new URL('./src/features/legal/content/', import.meta.url))

/** names: a docs page's own names, without the docs', longest first (a link preview's title falls back to them). */
type SitePage = { path: string; title: string; names?: string[]; description: string; markdown: string; card: CardWords; twin?: string }

/** A title as a card's lines: one if it fits, else two (a card has room for no more) of near lengths, the first the longer
 *  by a little ("Give a coding agent / its own key", "Send from the / built-in domain"). */
function titleLines(title: string): CardWords['lines'] {
  if (title.length <= maxLine()) return [title]
  const words = title.split(' '), score = ([a, b]: [string, string]) => Math.max(a.length, b.length + 3)
  const splits = words.slice(1).map((_, i) => [words.slice(0, i + 1).join(' '), words.slice(i + 1).join(' ')] as [string, string])
  return splits.reduce((best, split) => score(split) < score(best) ? split : best)
}

export function sitePages(): Plugin {
  return {
    name: 'nightmail:site-pages', apply: 'build', enforce: 'post',
    generateBundle: { order: 'post', handler(_options, bundle) {
      const index = bundle['index.html']
      if (index?.type !== 'asset') return this.error('The site\'s pages are made from index.html, and the bundle has none.')
      const source = String(index.source)
      const origin = /<meta property="og:image" content="([^"]+)\/og\.png"/.exec(source)?.[1]
      if (!origin) return this.error('The site\'s pages need index.html\'s og:image, to name their cards\' address beside it.')

      const document = JSON.parse(readFileSync(openApi, 'utf8')) as { info: { description?: string }; paths: Record<string, Record<string, unknown>> }
      const operations = operationEntries(document)
      const docsCard: CardWords = { name: 'docs', lines: ['API documentation.', `${operations.length} operations.`], caption: `The ${productName} API reference and ${GUIDE_NAMES.length} guides.` }
      const legal = readdirSync(legalContent).filter(file => file.endsWith('.md')).sort().map(file => {
        const text = readFileSync(legalContent + file, 'utf8').replace(/\r\n/g, '\n'), doc = renderLegal(text, file)
        return { slug: file.slice(0, -3), ...doc, body: text.replace(/^---\n[\s\S]*?\n---\n/, '').trim() }
      })
      const legalTitle = (title: string) => `${title} · ${productName.toLowerCase()}`
      const latest = legal.map(doc => doc.updated).sort((a, b) => Date.parse(b) - Date.parse(a))[0]!
      const pages: SitePage[] = [
        { path: '/docs', title: docsTitle(null), description: document.info.description ?? '', markdown: '/docs.md', card: docsCard },
        ...GUIDE_NAMES.map(guide => ({ path: `/docs/${guide.id}`, title: docsTitle(guide.title), names: [guide.title], description: guide.summary, markdown: '/docs.md', card: { name: `docs-${guide.id}`, lines: titleLines(guide.title), caption: `Guide · ${productName} API docs` } })),
        ...operations.map(operation => ({ path: `/docs/api/${operation.id}`, title: docsTitle(operation.summary), names: [operation.summary, operationTitle(operation.id)], description: operationDescription(operation), markdown: `/docs/operations/${operation.id}.md`, card: docsCard })),
        { path: '/legal', title: legalTitle('Legal'), description: `The terms and policies that apply to ${productName}: ${legal.map(doc => doc.title).join(', ')}.`, markdown: '/legal.md',
          card: { name: 'legal', lines: ['Terms and policies'], caption: `${legal.length} documents, last updated ${latest}.` },
          twin: [`# Legal`, `Canonical page: ${publicOrigin}/legal`, `The terms and policies that apply to ${productName}.`, legal.map(doc => `- [${doc.title}](${publicOrigin}/legal/${doc.slug}.md): ${doc.description} Updated ${doc.updated}.`).join('\n')].join('\n\n') + '\n' },
        ...legal.map(doc => ({ path: `/legal/${doc.slug}`, title: legalTitle(doc.title), description: doc.description, markdown: `/legal/${doc.slug}.md`,
          card: { name: `legal-${doc.slug}`, lines: titleLines(doc.title), caption: `Updated ${doc.updated}.` },
          twin: [`# ${doc.title}`, `Canonical page: ${publicOrigin}/legal/${doc.slug}`, `Updated ${doc.updated}. Effective ${doc.effective}.`, doc.body].join('\n\n') + '\n' })),
      ]
      for (const page of pages) {
        const card = linkCard(page.card)
        if (!bundle[card.file]) this.emitFile({ type: 'asset', fileName: card.file, source: card.source })
        let html = withCard(source, card, origin)
        const set = (pattern: RegExp, value: string) => {
          if (!pattern.test(html)) this.error(`index.html has no ${pattern.source} for ${page.path}.`)
          html = html.replace(pattern, (_match, start: string) => start + value)
        }
        const canonical = publicOrigin + page.path
        set(/(<title>)[^<]*/, attr(page.title))
        for (const name of ['name="description"', 'property="og:description"', 'name="twitter:description"']) set(new RegExp(`(<meta ${name} content=")[^"]*`), attr(page.description))
        // A link preview's title: the page's title if it fits a small card, else one of its names, with the docs' or alone
        // (an operation's summary, else its name: link-card.ts).
        const share = shareTitle(page.title, ...(page.names ?? []).flatMap(name => [`${name} · ${productName} docs`, name]))
        for (const name of ['property="og:title"', 'name="twitter:title"']) set(new RegExp(`(<meta ${name} content=")[^"]*`), attr(share))
        set(/(<!-- Link previews\.)[^>]*-->/, ' This page\'s own (app/site-pages.ts). -->')
        set(/(<meta property="og:type" content="website" \/>)/, `\n    <meta property="og:url" content="${attr(canonical)}" />\n    <link rel="canonical" href="${attr(canonical)}" />`)
        set(/(<link rel="alternate" type="text\/markdown" href=")[^"]*(?=" title=")/, attr(publicOrigin + page.markdown))
        set(/(<link rel="alternate" type="text\/markdown" href="[^"]*" title=")[^"]*/, attr(`${page.title}, in Markdown`))
        this.emitFile({ type: 'asset', fileName: `${page.path.slice(1)}.html`, source: html })
        if (page.twin) this.emitFile({ type: 'asset', fileName: page.markdown.slice(1), source: page.twin })
      }
      // An old name redirects to its new page (site-index.ts): the page must exist, and the old name must be no operation's.
      for (const [old, now] of Object.entries(RENAMED_OPERATIONS)) if (!pages.some(page => page.path === `/docs/api/${now}`) || pages.some(page => page.path === `/docs/api/${old}`)) this.error(`RENAMED_OPERATIONS (api/src/site-index.ts) sends ${old} to ${now}, which has no reference page, or ${old} is an operation again.`)
      if (!pages.some(page => page.path === '/docs/api/sendEmail')) this.error(`The docs pages have no sendEmail: api/openapi.json isn't ${productName}'s API definition.`)
      if (!pages.some(page => page.path === '/legal/terms')) this.error('The legal pages have no terms: features/legal/content has no terms.md.')
    } },
  }
}
