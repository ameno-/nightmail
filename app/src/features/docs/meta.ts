// (With extensions: the build's config imports this file, site-pages.ts.)
import { productName } from '../../../../api/src/brand.ts'

// What each docs page is called in the browser tab, search results and link previews, and its description there. The
// page sets them as it renders (index.tsx, useDocumentMeta) and the build writes the same into the page's own HTML
// (app/site-pages.ts), so a crawler that doesn't run the script reads them too.

type Schema = Record<string, any>
export type OperationEntry = { id: string; method: string; path: string; tag: string; summary: string; description: string; operation: Schema; pathItem: Schema }

const methods = ['get', 'post', 'put', 'patch', 'delete']
const acronyms = new Set(['api', 'dns', 'url', 'id', 'sdk', 'smtp', 'imap', 'mcp'])
export function operationTitle(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ').map((word, index) => acronyms.has(word.toLowerCase()) ? word.toUpperCase() : index === 0 ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase()).join(' ')
}
/** Tag names are API identifiers (ApiKeys); people read them with spaces (API keys). */
export const tagTitle = (tag: string) => tag === 'ApiKeys' ? 'API keys' : tag === 'Auth' ? 'Agent tokens' : tag

/** Every operation of an OpenAPI document, in path order, named by its summary (or its ID, spaced, without one). */
export function operationEntries(document: { paths: Record<string, Schema> }): OperationEntry[] {
  return Object.entries(document.paths).flatMap(([path, pathItem]) => methods.flatMap(method => {
    const operation = pathItem[method] as Schema | undefined
    return operation?.operationId ? [{ id: operation.operationId as string, method, path, tag: operation.tags?.[0] ?? 'API', summary: operation.summary ?? operationTitle(operation.operationId), description: operation.description ?? '', operation, pathItem }] : []
  }))
}

/** The tab's title: a page's, or with none the overview's. */
export const docsTitle = (page: string | null) => page === null ? `${productName} API documentation` : `${page} · ${productName} API docs`
/** A reference page's description: its name and call, then the start of what the API says about it (or, where it says
 *  nothing, the section it's in), cut at a word to 160 characters. */
export function operationDescription(operation: Pick<OperationEntry, 'method' | 'path' | 'tag' | 'summary' | 'description'>) {
  const lead = `${operation.summary}: ${operation.method.toUpperCase()} ${operation.path}.`
  return clip(`${lead} ${operation.description || `In the ${tagTitle(operation.tag)} section of the ${productName} API reference.`}`, 160)
}
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, text.lastIndexOf(' ', max - 1)).replace(/[\s,;:(–—-]+$/, '')}…`
