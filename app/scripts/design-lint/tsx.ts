// The design rules for components, on the TypeScript AST: icon imports and hand-drawn SVG glyphs, and literal values in
// style={{…}} and on SVG colour attributes. Computed values (a width from data) are layout, not design, and pass.
import { createRequire } from 'node:module'
import type * as TS from '../../../api/node_modules/typescript'
import type { Context, Violation } from './index.ts'
import { colorAdvice, lengths, nearest, rawColors, scale } from './values.ts'

// app/ builds with TypeScript 7, which has no JS compiler API; api/ has TypeScript 6 (check-premerge.ts reads the AST
// with it too). A second TypeScript in app/ would race TypeScript 7 for node_modules/.bin/tsc.
const ts: typeof TS = (() => {
  try { return createRequire(new URL('../../../api/package.json', import.meta.url))('typescript') }
  catch { throw new Error('The component checks use the TypeScript compiler API installed in api/: run bun install in api/.') }
})()

const iconPacks = /^(?:lucide|lucide-static|lucide-preact|react-icons|react-feather|phosphor-react|iconoir-react|@phosphor-icons\/|@heroicons\/|@tabler\/icons|@radix-ui\/react-icons|@fortawesome\/|@iconify|@mui\/icons-material|@remixicon\/|@hugeicons\/|@primer\/octicons|@carbon\/icons)|(?:^|[/@-])icons?(?:$|[/-])/
const svgFile = /\.svg(?:\?.*)?$/

export function checkSource(file: string, rel: string, text: string, ctx: Context): Violation[] {
  const out: Violation[] = [], rules = ctx.config.rules
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const space = scale(ctx.tokens, '--space-'), radius = scale(ctx.tokens, '--radius-'), type = scale(ctx.tokens, '--text-')
  const emit = (rule: keyof typeof rules, node: TS.Node, found: string, use: string = rules[rule].use) => {
    if (ctx.allowed(rule, file, '')) return
    const at = source.getLineAndCharacterOfPosition(node.getStart(source))
    out.push({ file: rel, line: at.line + 1, column: at.character + 1, rule, found, use })
  }
  const iconUse = rules['lucide-icons'].use
  // A small, static glyph: a literal viewBox no larger than maxViewBox, or a literal width or height up to maxSize.
  const iconLike = (viewBox?: string, width?: string, height?: string) => {
    const box = viewBox?.trim().split(/[\s,]+/).map(Number)
    const small = (v?: string) => v !== undefined && /^\d+(\.\d+)?(px)?$/.test(v) && parseFloat(v) <= rules['lucide-icons'].maxSize
    return (box?.length === 4 && box.every(n => !Number.isNaN(n)) && Math.max(box[2]!, box[3]!) <= rules['lucide-icons'].maxViewBox) || small(width) || small(height)
  }
  const literal = (e: TS.Expression | undefined): string | undefined => {
    if (!e) return undefined
    if (ts.isStringLiteralLike(e)) return e.text
    if (ts.isNumericLiteral(e)) return e.text
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return '-' + e.operand.text
    if (ts.isJsxExpression(e as TS.Node)) return literal((e as unknown as TS.JsxExpression).expression)
    return undefined
  }
  const attr = (attrs: TS.JsxAttributes, name: string) => {
    const a = attrs.properties.find((p): p is TS.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(source) === name)
    return a?.initializer ? literal(a.initializer as TS.Expression) : undefined
  }
  const px = (value: string) => /^-?\d*\.?\d+$/.test(value) ? Number(value) : lengths(value).find(l => l.unit === 'px' || l.unit === 'rem')?.px

  // style={{ … }}: one literal property at a time, as the CSS rules read it.
  const styleProperty = (name: string, value: string, node: TS.Node) => {
    const kebab = name.replace(/[A-Z]/g, c => '-' + c.toLowerCase()).replace(/^webkit-/, '-webkit-')
    const shown = `style={{ ${node.getText(source)} }}`
    for (const color of rawColors(value)) emit('token-color', node, shown, colorAdvice(ctx.tokens, color, name, rules['token-color'].use))
    const n = px(value)
    if (rules['token-space'].properties.includes(kebab) && n) emit('token-space', node, shown, nearest(space, n))
    if (/^border(-[a-z]+)*-radius$/.test(kebab) && n && n < 999) emit('token-radius', node, shown, nearest(radius, n))
    if (kebab === 'font-size' && value !== 'inherit') emit('token-font-size', node, shown, n ? nearest(type, n) : rules['token-font-size'].use)
    if (kebab === 'font-family' && !/^var\(--font-(body|mono|email)\)$|^inherit$/.test(value)) emit('font-family', node, shown)
    if (/^(border(-(top|right|bottom|left|block|inline))?(-(start|end))?|outline)$/.test(kebab) && !/^(0|none|0px)$/.test(value)) emit('borderless', node, shown)
    if (kebab === 'max-width' && n && n >= rules['page-full-width'].minCapPx) emit('page-full-width', node, shown)
    if ((kebab === 'text-overflow' && value === 'ellipsis') || /line-clamp$/.test(kebab)) emit('no-label-truncation', node, shown)
  }

  const visit = (node: TS.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text
      if (from !== 'lucide-react' && !/^[./]/.test(from) && iconPacks.test(from)) emit('lucide-icons', node, `import from '${from}'`, from.startsWith('lucide') ? "Import from 'lucide-react' and render <Icon icon={Glyph} /> (components/ui/icon.tsx)." : iconUse)
      if (svgFile.test(from)) emit('lucide-icons', node, `import '${from}'`, `${iconUse} A brand mark belongs with the brand's (components/NightmailLogo.tsx).`)
    }
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === 'svg') {
      if (iconLike(attr(node.attributes, 'viewBox'), attr(node.attributes, 'width'), attr(node.attributes, 'height'))) emit('lucide-icons', node, `an inline <svg> glyph`, `${iconUse} A brand mark belongs with the brand's (components/NightmailLogo.tsx).`)
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) && /<svg[\s>]/.test(node.text)) {
      const m = (name: string) => new RegExp(`${name}=["']([^"']+)["']`).exec(node.text)?.[1]
      if (iconLike(m('viewBox'), m('width'), m('height'))) emit('lucide-icons', node, 'an SVG glyph written as markup', `${iconUse} For markup built outside React, render the Lucide glyph (lucide-react) instead of drawing one.`)
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source)
      if (name === 'style' && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isObjectLiteralExpression(node.initializer.expression)) {
        for (const p of node.initializer.expression.properties) {
          if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) continue
          const value = literal(p.initializer)
          if (value !== undefined) styleProperty(p.name.text, value, p)
        }
      }
      if (['fill', 'stroke', 'color', 'stopColor', 'floodColor', 'lightingColor'].includes(name) && node.initializer) {
        const value = literal(node.initializer as TS.Expression)
        if (value) for (const color of rawColors(value)) emit('token-color', node, `${name}="${value}"`, colorAdvice(ctx.tokens, color, name, rules['token-color'].use))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}
