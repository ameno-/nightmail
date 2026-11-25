// Checks the dashboard against its design rules (design-lint.config.ts): stylesheets with Stylelint, components on the
// TypeScript AST. Every violation says where, which rule, why the rule exists and what to use instead.
//
// From app/: bun run design-lint [files…] [--rule <id>[,<id>]] [--limit <n> | --all] [--summary] [--json]
//   files      check only these (paths from the current directory); default: every file the config includes
//   --rule     only these rules
//   --limit    violations to print after the summary (default 30); --all prints every one
//   --summary  counts by rule only
//   --json     { rules, violations } for an agent to act on
// Exits 1 when a rule at level 'error' has a violation ('report' rules never fail), 2 when a stylesheet doesn't parse.
import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import stylelint from 'stylelint'
import config, { type Allow, type Level, type RuleId } from '../../design-lint.config.ts'
import { SEPARATOR, cssPlugins } from './css.ts'
import { checkSource } from './tsx.ts'
import { readTokens, type Tokens } from './values.ts'

export type Violation = { file: string; line: number; column: number; rule: RuleId; found: string; use: string }
export type Context = { config: typeof config; tokens: Tokens; allowed(rule: RuleId, file: string, selector: string): boolean }

const app = fileURLToPath(new URL('../../', import.meta.url))
const fromApp = (file: string) => relative(app, file).split('\\').join('/')
const globs = new Map<string, RegExp>()
// A glob (**, *, ?, {a,b}) as a regular expression over paths relative to app/.
const glob = (pattern: string) => globs.get(pattern) ?? globs.set(pattern, new RegExp('^' + pattern.split(/(\*\*\/|\*\*|\*|\?|\{[^}]*\})/).map(part =>
  part === '**/' ? '(.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.startsWith('{') ? '(' + part.slice(1, -1).split(',').join('|') + ')' : part.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('') + '$')).get(pattern)!
const matches = (allow: Allow, file: string, selector: string) =>
  (!allow.files || allow.files.some(p => glob(p).test(fromApp(file)))) && (!allow.selector || allow.selector.test(selector))

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const json = flag('--json'), summaryOnly = flag('--summary')
const limit = flag('--all') ? Infinity : Number(option('--limit') ?? 30)
const only = option('--rule')?.split(',').map(r => r.trim()) as RuleId[] | undefined
const ruleIds = Object.keys(config.rules) as RuleId[]
for (const id of only ?? []) if (!ruleIds.includes(id)) { console.error('Unknown rule ' + id + '. Rules: ' + ruleIds.join(', ')); process.exit(2) }
const named = args.filter((a, i) => !a.startsWith('--') && !['--rule', '--limit'].includes(args[i - 1] ?? '')).map(a => resolve(a))

const included = (file: string) => config.include.some(p => glob(p).test(fromApp(file))) && !config.ignore.some(a => matches(a, file, ''))
const everything = () => readdirSync(resolve(app, 'src'), { recursive: true, encoding: 'utf8' }).map(f => resolve(app, 'src', f))
const files = (named.length ? named : everything()).filter(included).sort()
if (named.length > files.length) console.error(named.length - files.length + " of the files named are outside the rules' scope (design-lint.config.ts include and ignore) and were not checked.")
const css = files.filter(f => f.endsWith('.css')), sources = files.filter(f => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))

const ctx: Context = {
  config,
  tokens: readTokens(resolve(app, 'src/styles/tokens.css')),
  allowed: (rule, file, selector) => (config.rules[rule].allow ?? []).some((a: Allow) => matches(a, file, selector)),
}

const violations: Violation[] = []
const want = (rule: RuleId) => !only || only.includes(rule)
if (css.length) {
  const result = await stylelint.lint({
    files: css, cwd: app, allowEmptyInput: true, config: {
      plugins: cssPlugins(ctx),
      rules: Object.fromEntries(ruleIds.filter(want).map(id => ['nightmail/' + id, true])),
    },
  })
  for (const r of result.results) for (const w of r.warnings) {
    const file = relative(process.cwd(), r.source ?? ''), rule = w.rule.replace(/^nightmail\//, '') as RuleId
    // A stylesheet that doesn't parse wasn't checked: say so and fail, whatever the levels.
    if (!ruleIds.includes(rule)) { console.error(file + ':' + w.line + ':' + w.column + '  ' + w.text); process.exitCode = 2; continue }
    const [found, use] = w.text.slice(0, w.text.lastIndexOf(' (' + w.rule + ')')).split(SEPARATOR)
    violations.push({ file, line: w.line, column: w.column, rule, found: found!, use: use ?? config.rules[rule].use })
  }
}
for (const file of sources) for (const v of checkSource(file, relative(process.cwd(), file), readFileSync(file, 'utf8'), ctx)) if (want(v.rule)) violations.push(v)
violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)

const count = (rule: RuleId) => violations.filter(v => v.rule === rule).length
const level = (rule: RuleId): Level => config.rules[rule].level
const blocking = violations.filter(v => level(v.rule) === 'error')
if (json) {
  console.log(JSON.stringify({
    rules: Object.fromEntries(ruleIds.filter(want).map(id => [id, { level: level(id), title: config.rules[id].title, why: config.rules[id].why, use: config.rules[id].use, count: count(id) }])),
    violations: violations.map(v => ({ ...v, why: config.rules[v.rule].why })),
  }, null, 2))
} else {
  const width = Math.max(...ruleIds.map(id => id.length))
  const filesWith = new Set(violations.map(v => v.file)).size
  console.log('Design rules (app/design-lint.config.ts): ' + violations.length + ' violation' + (violations.length === 1 ? '' : 's') + ' in ' + filesWith + ' of ' + files.length + ' files, ' + (blocking.length ? blocking.length + ' blocking.' : 'none blocking.'))
  for (const id of ruleIds.filter(want)) console.log('  ' + id.padEnd(width) + '  ' + String(count(id)).padStart(4) + '  ' + (level(id) === 'error' ? 'error ' : 'report') + '  ' + config.rules[id].title)
  if (!summaryOnly && violations.length) {
    // Every violation by file when they all fit; otherwise a sample: the blocking ones, then one of each rule in turn.
    let shown = [...blocking, ...violations.filter(v => !blocking.includes(v))]
    if (shown.length > limit) {
      const groups = ruleIds.map(id => violations.filter(v => v.rule === id && !blocking.includes(v))), turns: Violation[] = []
      for (let i = 0; turns.length < limit && groups.some(g => i < g.length); i++) for (const g of groups) if (g[i]) turns.push(g[i]!)
      shown = [...blocking, ...turns].slice(0, limit)
      console.log('\nA sample of ' + shown.length + ', one rule at a time (in app/: bun run design-lint --all for every one, --rule <id> for one rule, --json for an agent):')
    } else console.log('')
    for (const v of shown) {
      console.log(v.file + ':' + v.line + ':' + v.column + '  ' + v.rule + '  ' + v.found)
      console.log('  why  ' + config.rules[v.rule].why)
      console.log('  use  ' + v.use)
    }
  }
}
if (blocking.length && !process.exitCode) process.exitCode = 1
