import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { MAX_RULES, withFileRules } from './asset-headers.ts'
import { renderLegal } from './legal-markdown.ts'
import { headerPrefix, publicOrigin as hostedOrigin } from '../api/src/brand.ts'

// @react-email/editor's own "react-email" imports resolve to a slim shim (src/features/campaigns/react-email-shim.ts
// explains why); everything else, the shim included, gets the real package.
const reactEmailShim = fileURLToPath(new URL('./src/features/campaigns/react-email-shim.ts', import.meta.url))
const slimReactEmail: Plugin = {
  name: 'nightmail:slim-react-email', enforce: 'pre',
  resolveId(source, importer) { return source === 'react-email' && importer?.includes('/node_modules/@react-email/editor/') ? reactEmailShim : null },
}

// dist/_headers for Cloudflare: public/_headers, then a cache rule for each built file under assets/ and each font
// (asset-headers.ts explains why they are listed by name). The files every page loads come first, because past
// Cloudflare's rule limit the rest only revalidate.
const fileHeaders = (): Plugin => {
  let publicDir = '', outDir = ''
  return {
    name: 'nightmail:file-headers', apply: 'build',
    configResolved(config) { publicDir = config.publicDir; outDir = resolve(config.root, config.build.outDir) },
    writeBundle(_options, bundle) {
      const first = new Set<string>()
      const add = (name: string) => {
        const file = bundle[name]
        if (first.has(name) || !file) return
        first.add(name)
        if (file.type === 'chunk') for (const dependency of [...file.imports, ...file.viteMetadata?.importedCss ?? []]) add(dependency)
      }
      // The dashboard's entry only: the commercial's two files (below) take their turn in the sorted list after it.
      for (const file of Object.values(bundle)) if (file.type === 'chunk' && file.isEntry && file.name === 'index') add(file.fileName)
      const fonts = readdirSync(resolve(publicDir, 'fonts')).sort().map(name => `fonts/${name}`)
      const { headers, uncached } = withFileRules(readFileSync(resolve(publicDir, '_headers'), 'utf8'), [...first, ...fonts, ...Object.keys(bundle).sort()])
      writeFileSync(resolve(outDir, '_headers'), headers)
      if (uncached.length) this.warn(`${uncached.length} files have no cache rule and revalidate on every load (Cloudflare reads ${MAX_RULES} rules, and a rule needs a plain file name): ${uncached.join(', ')}`)
    },
  }
}

// The legal pages' Markdown becomes { title, description, updated, effective, html, headings } at build time
// (legal-markdown.ts), so the page ships HTML and no Markdown parser.
const legalMarkdown: Plugin = {
  name: 'nightmail:legal-markdown',
  transform(source, id) {
    if (!id.endsWith('.md')) return null
    return { code: `export default ${JSON.stringify(renderLegal(source, id))}`, map: null }
  },
}

// The commit a build was made from, recorded with each UI note (features/ui-notes). Only that lazy chunk reads it.
const buildSha = (() => {
  const named = process.env.NIGHTMAIL_BUILD_SHA ?? process.env.GITHUB_SHA
  if (named) return named.slice(0, 12)
  try { return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return 'unknown' }
})()

// Link-preview images need an absolute URL: the deploy sets VITE_PUBLIC_URL per stage; other builds name the hosted origin.
const publicOrigin: Plugin = {
  name: 'nightmail:public-origin',
  transformIndexHtml: html => html.replaceAll('%PUBLIC_ORIGIN%', (process.env.VITE_PUBLIC_URL || hostedOrigin).replace(/\/$/, '')),
}

// public/theme.js runs before the app's modules and is served as written, so the request header names it shares with the
// app and the API come from brand.ts here: %HEADER_PREFIX% becomes X-Nightmail-, in the dev server and in the build.
const brandedBootScript = (): Plugin => {
  const file = 'theme.js'
  let publicDir = '', outDir = ''
  const filled = () => readFileSync(resolve(publicDir, file), 'utf8').replaceAll('%HEADER_PREFIX%', headerPrefix)
  return {
    name: 'nightmail:branded-boot-script',
    configResolved(config) { publicDir = config.publicDir; outDir = resolve(config.root, config.build.outDir) },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== `/${file}`) return next()
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        response.end(filled())
      })
    },
    writeBundle() { writeFileSync(resolve(outDir, file), filled()) },
  }
}

// /commercial/ is the television commercial (commercial/README.md): a page of its own with one script and one stylesheet,
// so no dashboard page loads any of it and it loads none of the dashboard. The dev server serves commercial/index.html
// as it is. The build takes the page's script as a second entry and writes the page with the built files' names here:
// as a second HTML entry it would share Vite's module-preload polyfill with the dashboard as a chunk, and every
// dashboard page would fetch one more file.
const commercial = { page: fileURLToPath(new URL('./commercial/index.html', import.meta.url)), script: fileURLToPath(new URL('./commercial/src/main.js', import.meta.url)), tag: '<script type="module" src="./src/main.js"></script>' }
const commercialPage = (): Plugin => {
  let outDir = ''
  return {
    name: 'nightmail:commercial-page', apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    writeBundle(_options, bundle) {
      const entry = Object.values(bundle).find(file => file.type === 'chunk' && file.isEntry && file.name === 'commercial')
      const source = readFileSync(commercial.page, 'utf8')
      if (entry?.type !== 'chunk' || !source.includes(commercial.tag)) return this.error(`The commercial's page needs its entry and ${commercial.tag}.`)
      const styles = [...entry.viteMetadata?.importedCss ?? []].map(file => `    <link rel="stylesheet" href="/${file}" />\n`).join('')
      mkdirSync(resolve(outDir, 'commercial'), { recursive: true })
      writeFileSync(resolve(outDir, 'commercial/index.html'), source.replace('  </head>', `${styles}  </head>`).replace(commercial.tag, `<script type="module" src="/${entry.fileName}"></script>`))
    },
  }
}

export default defineConfig({
  define: { __NIGHTMAIL_BUILD__: JSON.stringify(buildSha) },
  // (The homepage's station kit is inlined whatever its size: it is one lazily loaded stylesheet, features/home/machines.tsx.)
  build: { assetsInlineLimit: file => file.includes('/features/home/kit/') || undefined, rolldownOptions: { input: { index: fileURLToPath(new URL('./index.html', import.meta.url)), commercial: commercial.script } } },
  plugins: [slimReactEmail, legalMarkdown, react(), fileHeaders(), publicOrigin, brandedBootScript(), commercialPage()],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: Object.fromEntries(['/v1', '/api/auth', '/mcp', '/.well-known', '/unsubscribe', '/health', '/openapi.json', '/internal'].map(path => [path, {target: 'http://127.0.0.1:8793', changeOrigin: false}])),
  },
})
