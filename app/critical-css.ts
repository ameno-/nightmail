// The CSS a page painted from its HTML alone needs (price-pages.ts): the app's stylesheets, less every style rule that
// can't match anything in that HTML. A rule stays unless one of the classes, ids or attribute names its selectors
// require is missing from the page, so nothing on the page loses a style (matches, below); at-rules that hold rules
// (@media, @supports, @container, @layer, @scope) are pruned the
// same way inside; @font-face, @keyframes, @property and the rest stay whole, as does a kept rule's nested rules (each
// of which needs its parent's match). No dependencies: it reads the minified stylesheets Vite writes.

type Used = { classes: Set<string>; ids: Set<string>; attributes: Set<string> }
/** The classes, ids and attribute names an HTML page uses; `attributes` adds names a script sets (theme.js on <html>). */
export function usedNames(html: string, attributes: string[] = []): Used {
  const classes = new Set<string>(), ids = new Set<string>(), names = new Set(attributes)
  for (const [, value] of html.matchAll(/\sclass="([^"]*)"/g)) for (const name of value!.split(/\s+/)) if (name) classes.add(name)
  for (const [, value] of html.matchAll(/\sid="([^"]*)"/g)) ids.add(value!)
  for (const [, name] of html.matchAll(/<[a-zA-Z][\w-]*((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>/g)) for (const [, attribute] of name!.matchAll(/\s([^\s=>/]+)/g)) names.add(attribute!.toLowerCase())
  return { classes, ids, attributes: names }
}

const NESTED = /^@(?:media|supports|container|layer|scope|document)\b/i
/** The end of the block that opens at css[open] ("{"), past strings, comments and nested blocks. */
function blockEnd(css: string, open: number) {
  let depth = 0
  for (let i = open; i < css.length; i++) {
    const ch = css[i]
    if (ch === '"' || ch === "'") { i = skipString(css, i); continue }
    if (ch === '/' && css[i + 1] === '*') { i = css.indexOf('*/', i + 2); if (i < 0) return css.length - 1; i++; continue }
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i
  }
  return css.length - 1
}
function skipString(css: string, start: number) {
  const quote = css[start]
  for (let i = start + 1; i < css.length; i++) { if (css[i] === '\\') i++; else if (css[i] === quote) return i }
  return css.length - 1
}
/** A selector list's selectors (top-level commas only). */
function selectors(list: string) {
  const out: string[] = []
  let depth = 0, from = 0
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === '"' || ch === "'") i = skipString(list, i)
    else if (ch === ',' && depth === 0) { out.push(list.slice(from, i)); from = i + 1 }
  }
  return [...out, list.slice(from)]
}
const ANY_OF = new Set(['is', 'where', 'matches', '-webkit-any', '-moz-any', 'has'])
const ident = (selector: string, from: number) => { let i = from; while (i < selector.length && (/[\w-]/.test(selector[i]!) || selector[i] === '\\')) i += selector[i] === '\\' ? 2 : 1; return i }
const unescape = (name: string) => name.replace(/\\(.)/g, '$1')
/** Whether a selector could match something on the page: every class, id and attribute name it needs is there, and
 *  of :is(), :where() and :has(), one alternative could; :not() and the other functions never rule it out. */
function matches(selector: string, used: Used): boolean {
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if (ch === '\\') { i++; continue }
    if (ch === '"' || ch === "'") { i = skipString(selector, i); continue }
    if (ch === '.' || ch === '#') {
      const end = ident(selector, i + 1), name = unescape(selector.slice(i + 1, end))
      if (name && !/^\d/.test(name) && !(ch === '.' ? used.classes : used.ids).has(name)) return false
      i = end - 1
    } else if (ch === '[') {
      const close = closing(selector, i, '[', ']'), name = /^\s*([\w-]+)/.exec(selector.slice(i + 1, close))?.[1]
      if (name && !used.attributes.has(name.toLowerCase())) return false
      i = close
    } else if (ch === ':') {
      while (selector[i + 1] === ':') i++
      const end = ident(selector, i + 1), name = selector.slice(i + 1, end).toLowerCase()
      if (selector[end] === '(') {
        const close = closing(selector, end, '(', ')')
        if (ANY_OF.has(name) && !selectors(selector.slice(end + 1, close)).some(inner => matches(inner.replace(/^\s*[>+~]/, ''), used))) return false
        i = close
      } else i = end - 1
    }
  }
  return true
}
/** The index of the bracket that closes the one at `open`. */
function closing(text: string, open: number, start: string, end: string) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue }
    if (text[i] === '"' || text[i] === "'") { i = skipString(text, i); continue }
    if (text[i] === start) depth++
    else if (text[i] === end && --depth === 0) return i
  }
  return text.length - 1
}

export function pruneCss(css: string, used: Used): string {
  let out = '', i = 0
  while (i < css.length) {
    // The next statement: a prelude up to "{" (a rule) or ";" (an at-rule without a block).
    let j = i
    while (j < css.length && css[j] !== '{' && css[j] !== ';' && css[j] !== '}') {
      if (css[j] === '"' || css[j] === "'") j = skipString(css, j)
      else if (css[j] === '/' && css[j + 1] === '*') { const end = css.indexOf('*/', j + 2); j = end < 0 ? css.length : end + 1 }
      j++
    }
    if (j >= css.length) { out += css.slice(i); break }
    if (css[j] === ';' || css[j] === '}') { out += css.slice(i, j + 1); i = j + 1; continue }
    const prelude = css.slice(i, j).trim(), end = blockEnd(css, j), body = css.slice(j + 1, end)
    if (prelude.startsWith('@')) {
      if (NESTED.test(prelude)) { const inner = pruneCss(body, used); if (inner.trim()) out += `${prelude}{${inner}}` }
      else out += css.slice(i, end + 1)
    } else if (selectors(prelude).some(selector => matches(selector, used))) out += css.slice(i, end + 1)
    i = end + 1
  }
  return out
}
