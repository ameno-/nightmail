// New address, and where its mail goes, in one place; Edit opens it for an address whose flow it can draw (builderFits:
// one destination, or one two-way rule, and not paused). Anything more is the address's steps, on its page. New: the
// address, then its flow, then the result with Test. Editing: the flow, then the result. The flow is drawn as the flow
// panel draws it: the email at the top, an optional rule that forks it two ways, and the destination slots below.
// Saving makes any new destination first (createEndpoint, or createInboundAddress for a new inbox; kept for a retry),
// then writes the flow in one version. A new address is createInboundAddress with its flow: when any of it fails,
// nothing is created. An address that exists is setInboundAddressFlow with only what changed and the version the
// builder read, so a change made meanwhile is shown, never overwritten. The API keeps a paused route paused and gives
// this address its own copy of a rule another address shares.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Alert, Button, ConfirmDialog, Dialog, Field, Input, Select, type SelectOption } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useApiDef, useApiQuery } from '../../data/context'
import { queries } from '../../data/queries'
import { request } from '../../data/live'
import { staleAfterWrite } from '../../data/invalidation'
import { ApiError, errorText, type InboundAddress, type MailboxDomain } from '../../data/types'
import { idempotencyFor, addressOption } from './shared'
import { Flow, FlowFork, FlowItem, FlowStage, isSplit, splitOf } from './flow'
import { FlowPanel } from './panel'
import { receivingDomains, useOverview, type Overview, type OverviewRule, type RouteEntry, type Target } from './overview'
import { Match, TargetIcon } from './parts'
import { AwaitingConfirm, discordUrl, slackUrl, targetProblem, urlHint } from './ritual-connections'
import { catchAllNote, outcomes } from './concepts'
import { RuleLine } from './recipes'

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/
const FULL = 'Enter a full email address.'
const onDomains = (receiving: { name: string }[]) => `Use a receiving domain: ${receiving.map(d => d.name).join(', ')}.`
const lifetimes = [{ value: '', label: 'Always' }, { value: '3600', label: '1 hour' }, { value: '86400', label: '1 day' }, { value: '604800', label: '7 days' }, { value: '2592000', label: '30 days' }]

/** What the rule checks, in plain words. ai asks the AI (a decision) whether the email looks like what is described. */
export type Condition = 'from' | 'subject' | 'text' | 'attachment' | 'ai'
export const conditions: { value: Condition; label: string; placeholder?: string }[] = [
  { value: 'subject', label: 'The subject mentions', placeholder: 'refund, return' },
  { value: 'text', label: 'The email mentions', placeholder: 'invoice' },
  { value: 'from', label: 'The sender is', placeholder: 'ceo@example.com, @partner.example' },
  { value: 'attachment', label: 'It has an attachment' },
  { value: 'ai', label: 'It looks like', placeholder: 'a refund request' },
]
type NewType = 'inbox' | 'slack' | 'discord' | 'webhook' | 'forward'
/** A destination slot's choice: own (its inbox), inbox:<ID>, endpoint:<name>, hook:<ID> (an event webhook, routes only), store, drop or new:<type>. */
type Slot = string
type Side = 'then' | 'otherwise'
type Plan = { split: boolean; condition: Condition; value: string; then: Slot; otherwise: Slot; targets: Record<string, string> }
/** The flow as saved when the builder opened it: the rule it draws, the route, and what else the route delivers to. */
type Base = { rule: OverviewRule | null; plan: Plan; also: Target[] }
type Resolved = { param: string; route: string[] | 'drop' | null; chat: boolean }
type NewEndpoint = { type: 'slack' | 'discord' | 'webhook'; name: string; url: string }
type Change = { endpoints?: NewEndpoint[]; rule?: string; split?: { recipe: string; params: Record<string, string> } | null; deliver?: string[] | 'drop' | null }
const newLabel: Record<NewType, string> = { inbox: 'New inbox', slack: 'New Slack channel', discord: 'New Discord channel', webhook: 'New webhook', forward: 'Forward to someone new' }
const newField: Record<NewType, { label: string; placeholder: string }> = {
  inbox: { label: 'Its address', placeholder: 'refunds@' },
  slack: { label: 'Slack webhook URL', placeholder: 'https://hooks.slack.com/services/…' },
  discord: { label: 'Discord webhook URL', placeholder: 'https://discord.com/api/webhooks/…' },
  webhook: { label: 'Your URL', placeholder: 'https://' },
  forward: { label: 'Their address', placeholder: 'team@example.com' },
}
const blank: Plan = { split: false, condition: 'subject', value: '', then: 'own', otherwise: 'own', targets: {} }
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56)
const freeName = (base: string, taken: Set<string>) => { const stem = slug(base) || 'desk'; for (let n = 1; ; n++) { const name = n === 1 ? stem : `${stem}-${n}`; if (!taken.has(name)) return name } }
const words = (v: unknown) => Array.isArray(v) ? v.join(', ') : String(v ?? '')
const list = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean).join(',')

/** Whether the builder can draw (and so change) an address's flow: an address with at most one two-way rule, a route
 *  that isn't paused, and no more than one place its route sends to unless a rule splits it. */
export function builderFits(entry: RouteEntry, overview: Overview): boolean {
  if (entry.kind !== 'address' || !entry.address) return false
  if (entry.route && !entry.route.enabled) return false
  const splits = entry.rules.map(key => overview.rules.find(r => r.key === key)).filter(isSplit)
  if (splits.length > 1) return false
  return splits.length === 1 ? entry.route?.to !== 'drop' : !(Array.isArray(entry.route?.to) && entry.route.to.length > 1)
}

/** The address's flow as the builder draws it, from the overview's row; null when a destination is one it can't name. */
function baseOf(entry: RouteEntry, overview: Overview, boxes: InboundAddress[], key?: string): Base | null {
  const own = entry.address?.id
  const pickOfParam = (param: string): Slot | null => {
    if (param === 'store' || param === 'drop') return param
    if (param.startsWith('inbox:')) { const key = param.slice(6), box = entry.address?.key === key ? entry.address : boxes.find(b => b.key === key); return !box ? null : box.id === own ? 'own' : `inbox:${box.id}` }
    return overview.endpoints.some(e => e.source === 'endpoint' && e.name === param) ? `endpoint:${param}` : null
  }
  const pickOfRoute = (id: string): Slot | null => {
    if (id === own) return 'own'
    if (boxes.some(b => b.id === id)) return `inbox:${id}`
    const e = overview.endpoints.find(x => x.id === id)
    return !e ? null : e.source === 'endpoint' ? `endpoint:${e.name}` : `hook:${e.id}`
  }
  // What the route delivers on its own, beside a rule: drawn under the fork as Also, and kept unless replaced.
  const also = entry.to.filter(t => !t.via && t.type !== 'store' && t.type !== 'drop')
  // One rule asked for by key (a split's Rules row, or its line on the address's page): that one, whichever it is.
  const rule = key ? overview.rules.find(r => r.key === key && isSplit(r) && entry.rules.includes(r.key)) ?? null : splitOf(entry, overview) ?? null
  if (key && !rule) return null
  if (rule?.recipe) {
    const p = rule.recipe.params, ai = rule.recipe.id === 'split-by-meaning', always = !ai && p.test === 'always'
    const then = pickOfParam(words(p.then)), otherwise = always ? 'own' : pickOfParam(words(p.otherwise))
    if (!then || !otherwise) return null
    return { rule, also, plan: { ...blank, split: !always, condition: ai ? 'ai' : always ? 'subject' : p.test as Condition, value: ai ? words(p.meaning) : words(p.value), then, otherwise } }
  }
  const to = entry.route?.to
  const then = !to ? 'own' : to === 'drop' ? 'drop' : !to.length ? 'store' : pickOfRoute(to[0]!)
  return then ? { rule: null, also: [], plan: { ...blank, then } } : null
}

/** A rule's fields as the builder writes them, and as the overview reads them back, for telling an unchanged one. */
const sameRule = (a: { recipe: string; params: Record<string, string> }, rule: OverviewRule) => {
  if (a.recipe !== rule.recipe?.id) return false
  const b = rule.recipe.params, keys = new Set([...Object.keys(a.params), ...Object.keys(b)])
  return [...keys].every(k => list(words(a.params[k])) === list(words(b[k])))
}
/** Where a route sends mail, compared as a set; no route and a route to its own inbox are the same. */
const sameDeliver = (a: string[] | 'drop' | null, b: string[] | 'drop' | null, own: string) => {
  const norm = (x: string[] | 'drop' | null) => x === null ? 'own' : x === 'drop' ? 'drop' : x.length === 1 && x[0] === own ? 'own' : [...x].sort().join(',')
  return norm(a) === norm(b)
}
/** Whether an address's route and two-way rule are what they were: a change elsewhere in the workspace doesn't count. */
const sameFlow = (a: RouteEntry | undefined, b: RouteEntry | undefined, ao: Overview, bo: Overview) => {
  if (!a || !b) return a === b
  const ra = splitOf(a, ao), rb = splitOf(b, bo)
  return JSON.stringify([a.route?.to ?? null, a.route?.enabled ?? null, ra?.key ?? null, ra?.recipe ?? null, ra?.enabled ?? null, ra?.attachedTo ?? null])
    === JSON.stringify([b.route?.to ?? null, b.route?.enabled ?? null, rb?.key ?? null, rb?.recipe ?? null, rb?.enabled ?? null, rb?.attachedTo ?? null])
}

/** One destination slot: a picker of every place mail can go, and the field a new one needs. */
function DestinationPicker({ id, value, onChange, target, onTarget, own, boxes, overview, routeOnly, error, domain }: {
  id: string; value: Slot; onChange: (next: Slot) => void; target: string; onTarget: (next: string) => void; own: string; boxes: InboundAddress[]; overview: Overview; routeOnly: boolean; error?: string; domain?: string
}) {
  // A rule names its destinations; a webhook made for events (no name) can only be a route's, with nothing else to choose.
  const named = overview.endpoints.filter(e => e.source === 'endpoint')
  const options: SelectOption[] = [
    { value: 'own', label: <>Its inbox</>, text: 'Its inbox' },
    ...boxes.filter(b => b.address !== own && b.kind !== 'inbox').map(b => ({ ...addressOption(`inbox:${b.id}`, b.address, b.displayName ?? undefined), label: <>{b.displayName ? `${b.displayName} inbox` : <><PrivateAddress value={b.address} /> inbox</>}</> })),
    ...named.map(e => ({ value: `endpoint:${e.name}`, text: e.name, disabled: e.type === 'forward' && e.status !== 'ready', label: <span className="builder-option"><TargetIcon type={e.type} />{e.name}<span className="muted"> · {typeWord[e.type]}</span></span> })),
    ...(routeOnly ? overview.endpoints.filter(e => e.source === 'inbound_webhook').map(e => ({ value: `hook:${e.id}`, text: e.name, label: <span className="builder-option"><TargetIcon type="webhook" />{e.name}<span className="muted"> · Webhook</span></span> })) : []),
    { value: 'store', label: outcomes.store },
    { value: 'drop', label: outcomes.drop },
    ...(['inbox', 'slack', 'discord', 'webhook', 'forward'] as NewType[]).map(type => ({ value: `new:${type}`, label: newLabel[type] })),
  ]
  const fresh = value.startsWith('new:') ? value.slice(4) as NewType : null
  return <div className="stack builder-slot">
    <Select id={id} aria-label="Destination" value={value} onValueChange={onChange} options={options} />
    {fresh && <Field label={newField[fresh].label} htmlFor={id + '-target'} error={error} hint={fresh === 'slack' || fresh === 'discord' ? urlHint[fresh] : undefined}>
      <Input id={id + '-target'} type={fresh === 'forward' || fresh === 'inbox' ? 'email' : 'url'} value={target} placeholder={fresh === 'inbox' ? `refunds@${domain ?? 'example.com'}` : newField[fresh].placeholder} autoComplete="off" onChange={e => onTarget(e.target.value)} aria-invalid={!!error || undefined} />
    </Field>}
    {!fresh && error && <p className="ui-field__error" role="alert">{error}</p>}
  </div>
}
const typeWord = { webhook: 'Webhook', slack: 'Slack', discord: 'Discord', forward: 'Forward' } as const
const targetWord = (t: Target, own: string | undefined, start = false) => t.type === 'inbox' ? (t.id === own ? (start ? 'Its inbox' : 'its inbox') : <><PrivateAddress value={t.name} /> inbox</>) : t.name

type Step = 'address' | 'flow' | 'done'
/**
 * The builder. New: the address, then where its mail goes, then the result with Test. Editing (address given): where
 * its mail goes, then the result; split preselects a two-way rule of that kind when the address has none (New rule's
 * Split by words or meaning). Wildcards and catch-alls keep "Where should this mail go?" (routing.tsx).
 */
export function AddressBuilder({ open, onOpenChange, domains, initial = '', address, split, rule: ruleKey, onSaved, onPattern }: { open: boolean; onOpenChange: (open: boolean) => void; domains: Pick<MailboxDomain, 'id' | 'name' | 'status'>[] | Overview['domains']; initial?: string; address?: InboundAddress; split?: Condition; rule?: string; onSaved?: (address: InboundAddress) => void; onPattern?: (match: string) => void }) {
  const client = useQueryClient()
  const receiving = receivingDomains(domains)
  const navigate = useNavigate()
  // Editing an address that exists: one given, or the one this builder just made (Edit on its result).
  const [editing, setEditing] = useState(!!address)
  const [step, setStep] = useState<Step>(address ? 'flow' : 'address')
  const [saved, setSaved] = useState<InboundAddress | null>(address ?? null)
  const [form, setForm] = useState({ address: initial, displayName: '', lifetime: '', publicAddress: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [problem, setProblem] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [leaving, setLeaving] = useState<(() => void) | null>(null)
  // Each write's idempotency (a retry of the same body reuses its key), and the destinations a save made, reused by a retry.
  const attempts = useRef(new Map<string, { key: string; body: string }>())
  const made = useRef(new Map<string, { id: string; name: string; key?: string | null }>())
  const attempt = (name: string) => { let a = attempts.current.get(name); if (!a) attempts.current.set(name, a = { key: '', body: '' }); return a }
  const boxes = useApiDef(queries.inboundAddressOptions(), { enabled: open })
  const current = saved?.address ?? form.address.trim().toLowerCase()
  const overview = useOverview({ q: current, kind: 'address', limit: 5 }, false, open && step !== 'address')
  const entry = saved ? overview.data?.routes.data.find(r => r.address?.id === saved.id) : undefined
  // The flow as it was when the builder opened it: what a save compares with, and the version it sends.
  const [opened, setOpened] = useState<{ entry: RouteEntry; overview: Overview } | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  // Opening starts afresh. Before the effects below, so the flow they capture from cached data isn't cleared after.
  useEffect(() => { if (open) { setEditing(!!address); setStep(address ? 'flow' : 'address'); setSaved(address ?? null); setForm({ address: initial, displayName: '', lifetime: '', publicAddress: '' }); setErrors({}); setProblem(null); setPlan(null); setWaiting(null); setConflict(false); setOpened(null); setReplace(false); made.current.clear() } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open && editing && !opened && entry && overview.data && boxes.data) setOpened({ entry, overview: overview.data }) }, [open, editing, opened, entry, overview.data, boxes.data])
  // A rule given by key changes that rule only (its fork and its sides), on an address with any number of rules:
  // the address's route and its other rules stay.
  const ruleMode = editing && !!ruleKey
  const base = opened && boxes.data ? baseOf(opened.entry, opened.overview, boxes.data, ruleMode ? ruleKey : undefined) : null
  const fits = !editing || !opened || ((ruleMode || builderFits(opened.entry, opened.overview)) && !!base)
  // New rule's Split on an address that already splits its mail: replacing that rule is asked first, never assumed.
  const [replace, setReplace] = useState(false)
  const asking = !!split && !!base?.rule && !replace && !ruleMode
  const draft = plan ?? base?.plan ?? blank
  // Opened from New rule's Split by words or meaning: the address's flow split on that kind of check, where its mail went
  // before on both sides until one is chosen. One that already splits its mail opens on that rule, to change it.
  useEffect(() => { if (open && split && base && !base.rule && !plan) setPlan({ ...base.plan, split: true, condition: split, otherwise: base.plan.then }) }, [open, split, base, plan])
  // Rules the builder doesn't draw (ready-made ones, scripts) keep running beside it.
  const others = (opened?.entry.rules ?? entry?.rules ?? []).filter(key => key !== base?.rule?.key).length
  const catalog = useApiQuery(['rule-recipes'], (_api, signal) => request<{ decisionPricePerThousand: string }>('/v1/rules/recipes', { signal }), { enabled: open && draft.condition === 'ai' })
  const set = (patch: Partial<Plan>) => { setPlan({ ...draft, ...patch }); setProblem(null); setErrors({}) }
  const refresh = () => client.invalidateQueries({ predicate: query => staleAfterWrite(query.queryKey, false) })
  const dirty = step !== 'done' && (plan !== null || form.address !== initial || !!form.displayName || !!form.lifetime || !!form.publicAddress)
  // Leaving with something typed asks first: closing, Cancel, or a link out of the builder.
  const close = (then?: () => void) => {
    if (busy) return
    const go = () => { onOpenChange(false); then?.() }
    if (dirty) setLeaving(() => go); else go()
  }
  const leaveTo = (to: string) => (event: { preventDefault: () => void }) => { event.preventDefault(); close(() => navigate(to)) }

  // The * the address step turned away, for its button to the catch-all's or wildcard's route editor.
  const typed = form.address.trim().toLowerCase()
  const pattern = errors.address && EMAIL.test(typed) && typed.split('@')[0]!.includes('*') && receiving.some(d => d.name === typed.split('@')[1]) ? typed : null
  const existing = errors.address ? (boxes.data ?? []).find(b => b.address === typed || b.aliases.includes(typed)) : undefined
  function next(event: FormEvent) {
    event.preventDefault()
    const value = form.address.trim().toLowerCase(), sender = form.publicAddress.trim().toLowerCase(), found: Record<string, string> = {}
    if (!EMAIL.test(value)) found.address = 'Enter a full email address, such as support@example.com.'
    // A * makes a catch-all or wildcard (a route), never an address with a * in its name.
    else if (value.split('@')[0]!.includes('*')) found.address = value.startsWith('*@') ? catchAllNote : 'An address with * is a wildcard.'
    else if (receiving.length && !receiving.some(d => d.name === value.split('@')[1])) found.address = onDomains(receiving)
    else if ((boxes.data ?? []).some(b => b.address === value || b.aliases.includes(value))) found.address = 'That address exists.'
    if (sender && form.lifetime) found.publicAddress = 'Temporary addresses cannot have a public sender address.'
    else if (sender && !EMAIL.test(sender)) found.publicAddress = FULL
    // The API takes a public sender only as the same local part on a parent domain.
    else if (sender && EMAIL.test(value) && (sender.split('@')[0] !== value.split('@')[0] || !value.split('@')[1]!.endsWith(`.${sender.split('@')[1]}`))) found.publicAddress = `Use ${value.split('@')[0]}@ on a parent domain of ${value.split('@')[1]}.`
    setErrors(found)
    if (!Object.keys(found).length) setStep('flow')
  }

  const own = saved?.address ?? form.address.trim().toLowerCase()
  const ownKeys = () => new Set((boxes.data ?? []).map(b => b.key).filter((k): k is string => !!k))
  /** A key for an inbox a rule names, which a new one gets from its address (another inbox: PATCH, a write to its name only). */
  async function keyed(box: InboundAddress): Promise<string> {
    if (box.key) return box.key
    const updated = await request<InboundAddress>(`/v1/inbound/addresses/${encodeURIComponent(box.id)}`, { method: 'PATCH', body: { key: freeName(box.address.split('@')[0]!, ownKeys()) } })
    return updated.key!
  }
  const targetError = (pick: Slot, value: string) => {
    if (!pick.startsWith('new:')) return ''
    const type = pick.slice(4) as NewType, v = value.trim().toLowerCase()
    if (!v) return type === 'forward' || type === 'inbox' ? 'Enter its address.' : 'Paste the URL.'
    if (type === 'inbox') return !EMAIL.test(v) || v.split('@')[0]!.includes('*') ? FULL : !receiving.some(d => d.name === v.split('@')[1]) ? onDomains(receiving) : v === own || (boxes.data ?? []).some(b => b.address === v) ? 'That address exists: pick it above.' : ''
    return type === 'slack' && !slackUrl.test(v) ? targetProblem('slack', v) : type === 'discord' && !discordUrl.test(v) ? targetProblem('discord', v) : targetProblem(type, v)
  }

  /** Makes the new destinations a draft names (each once: a retry reuses what an earlier try made) and says how a rule
   *  and a route name each slot. New names are chosen for both slots before either is made, so they never collide. */
  async function realize(sides: Side[], ownKey: string | null | undefined, from: string | undefined, endpoints: NewEndpoint[]): Promise<Record<Side, Resolved> | 'waiting'> {
    const o = overview.data!, taken = new Set([...o.endpoints.map(e => e.name), ...[...made.current.values()].map(m => m.name)])
    const names: Partial<Record<Side, string>> = {}
    const asRule = draft.split || ruleMode
    for (const side of sides) {
      const pick = draft[side], value = (draft.targets[side] ?? '').trim()
      if (!pick.startsWith('new:') || pick === 'new:inbox' || made.current.has(`${pick}|${value}`)) continue
      const type = pick.slice(4) as NewType
      names[side] = freeName(type === 'forward' ? value.split('@')[0]! : `${own.split('@')[0]}-${type}`, taken)
      taken.add(names[side]!)
    }
    const out = {} as Record<Side, Resolved>
    for (const side of sides) {
      const pick = draft[side], value = (draft.targets[side] ?? '').trim()
      if (pick === 'own') { out[side] = { param: `inbox:${ownKey ?? ''}`, route: null, chat: false }; continue }
      if (pick === 'store') { out[side] = { param: 'store', route: [], chat: false }; continue }
      if (pick === 'drop') { out[side] = { param: 'drop', route: 'drop', chat: false }; continue }
      if (pick.startsWith('inbox:')) { const box = (boxes.data ?? []).find(b => b.id === pick.slice(6))!; out[side] = { param: asRule ? `inbox:${await keyed(box)}` : '', route: [box.id], chat: false }; continue }
      if (pick.startsWith('hook:')) { out[side] = { param: '', route: [pick.slice(5)], chat: false }; continue }
      if (pick.startsWith('endpoint:')) {
        const e = o.endpoints.find(x => x.source === 'endpoint' && x.name === pick.slice(9))!
        out[side] = { param: e.name, route: e.type === 'webhook' || e.type === 'forward' ? [e.id] : null, chat: e.type === 'slack' || e.type === 'discord' }
        continue
      }
      const type = pick.slice(4) as NewType, cache = `${pick}|${value}`
      // A new Slack, Discord or webhook endpoint is made with the flow, in its one write: nothing is left if that fails.
      if (type === 'slack' || type === 'discord' || type === 'webhook') {
        endpoints.push({ type, name: names[side]!, url: value })
        out[side] = { param: names[side]!, route: type === 'webhook' ? [`webhook:${names[side]}`] : null, chat: type !== 'webhook' }
        continue
      }
      let thing = made.current.get(cache)
      if (!thing && type === 'inbox') {
        const address = value.toLowerCase(), body = { address, key: freeName(address.split('@')[0]!, new Set([...ownKeys(), ...(ownKey ? [ownKey] : [])])) }
        const box = await request<InboundAddress>('/v1/inbound/addresses', { method: 'POST', body, idempotencyKey: idempotencyFor(attempt(cache), body) })
        thing = { id: box.id, name: box.address, key: box.key }
        made.current.set(cache, thing)
      } else if (!thing) {
        // A forward is made first: its recipient confirms by email before a route or rule can use it.
        const post = (body: Record<string, unknown>) => request<{ id: string; name: string; status: string }>('/v1/endpoints', { method: 'POST', body, idempotencyKey: idempotencyFor(attempt(cache), body) })
        const body = { type, name: names[side]!, address: value, ...(from ? { from } : {}) }
        let created: { id: string; name: string; status: string }
        try { created = await post({ ...body, preverify: true }) } catch (e) { if (!(e instanceof ApiError && e.code === 'PREVERIFY_NOT_ALLOWED')) throw e; created = await post(body) }
        thing = { id: created.id, name: created.name }
        made.current.set(cache, thing)
        if (created.status !== 'ready') { setWaiting(value); return 'waiting' }
      } else if (type === 'forward') {
        // Made by an earlier try and waiting for its recipient: saved once they confirm.
        const now = await request<{ status: string }>(`/v1/endpoints/${encodeURIComponent(thing.name)}`)
        if (now.status !== 'ready') { setWaiting(value); return 'waiting' }
      }
      out[side] = type === 'inbox' ? { param: `inbox:${thing.key ?? ''}`, route: [thing.id], chat: false } : { param: thing.name, route: [thing.id], chat: false }
    }
    return out
  }

  /** The two-way rule a draft makes: a fork, or one destination that only a rule reaches (a Slack or Discord post). */
  function plannedRule(r: Record<Side, Resolved>): { recipe: string; params: Record<string, string> } | null {
    if (!draft.split && !r.then.chat && !ruleMode) return null
    if (!draft.split) return { recipe: 'split', params: { test: 'always', then: r.then.param } }
    if (draft.condition === 'ai') return { recipe: 'split-by-meaning', params: { meaning: draft.value.trim(), then: r.then.param, otherwise: r.otherwise.param } }
    return { recipe: 'split', params: { test: draft.condition, ...(draft.condition === 'attachment' ? {} : { value: draft.value.trim() }), then: r.then.param, otherwise: r.otherwise.param } }
  }
  // Destinations the route sends to beside the rule, which saving one destination would stop: said before Save.
  const replacing = editing && !!base?.rule && !draft.split && base.also.length > 0

  async function save(event: FormEvent) {
    event.preventDefault()
    const found: Record<string, string> = {}
    if (draft.split && draft.condition !== 'attachment' && !draft.value.trim()) found.value = draft.condition === 'ai' ? 'Describe it, like a refund request.' : draft.condition === 'from' ? 'Add an address or @domain.' : 'Add a word to look for.'
    const thenProblem = targetError(draft.then, draft.targets.then ?? ''), otherProblem = draft.split ? targetError(draft.otherwise, draft.targets.otherwise ?? '') : ''
    if (thenProblem) found.then = thenProblem
    if (otherProblem) found.otherwise = otherProblem
    setErrors(found)
    if (Object.keys(found).length) return
    setBusy(true); setProblem(null); setWaiting(null); setConflict(false)
    try {
      const sides: Side[] = draft.split ? ['then', 'otherwise'] : ['then']
      // A rule names its own inbox by key; one destination reaches it with no route at all.
      const needsOwn = draft.split && sides.some(side => draft[side] === 'own')
      if (!editing) {
        // A new address: its new destinations first, then the address and its flow in one call.
        const local = form.address.trim().toLowerCase().split('@')[0]!
        const ownKey = needsOwn ? freeName(local, ownKeys()) : null
        const endpoints: NewEndpoint[] = []
        const r = await realize(sides, ownKey, undefined, endpoints)
        if (r === 'waiting') return
        const rule = plannedRule(r)
        const flow = { ...(endpoints.length ? { endpoints } : {}), ...(rule ? { split: rule, deliver: [] } : r.then.route !== null ? { deliver: r.then.route } : {}) }
        const value = form.address.trim().toLowerCase(), sender = form.publicAddress.trim().toLowerCase()
        const body = { address: value, displayName: form.displayName.trim() || null, ...(ownKey ? { key: ownKey } : {}), ...(sender ? { publicAddress: sender } : {}), ...(form.lifetime ? { ttlSeconds: Number(form.lifetime) } : {}), ...(Object.keys(flow).length ? { flow } : {}) }
        const self = await request<InboundAddress>('/v1/inbound/addresses', { method: 'POST', body, idempotencyKey: idempotencyFor(attempt('address'), body) })
        setSaved(self); setEditing(true)
        await refresh()
        onSaved?.(self)
      } else {
        if (!base || !opened || !saved) return
        const ownKey = needsOwn ? await keyed(saved) : saved.key
        const endpoints: NewEndpoint[] = []
        const r = await realize(sides, ownKey, saved.id, endpoints)
        if (r === 'waiting') return
        const rule = plannedRule(r)
        const change: Change = endpoints.length ? { endpoints } : {}
        if (!rule && base.rule) { change.rule = base.rule.key; change.split = null }
        else if (rule && (!base.rule || !sameRule(rule, base.rule))) { if (base.rule) change.rule = base.rule.key; change.split = rule }
        // A rule decides where mail goes, so the route sends nowhere else; a route that already sent beside the rule (Also)
        // is kept, and one rule changed by key never touches the route.
        const deliver = ruleMode ? undefined : rule ? (base.rule ? undefined : []) : r.then.route
        if (deliver !== undefined && !sameDeliver(deliver, opened.entry.route?.to ?? null, saved.id)) change.deliver = deliver
        if (Object.keys(change).length === (endpoints.length ? 1 : 0)) delete change.endpoints
        if (Object.keys(change).length) await write(change, opened.overview.version, false)
        await refresh()
        onSaved?.(saved)
      }
      // Edit after Done reads the saved flow back, not this draft.
      setPlan(null); setOpened(null)
      setStep('done')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') setConflict(true)
      else if (error instanceof ApiError && error.fields['params.value']) setErrors({ value: error.fields['params.value'] })
      else setProblem(error)
    } finally { setBusy(false) }
  }
  /** setInboundAddressFlow with the version the builder read. When that version is stale only because something else in
   *  the workspace changed, it is sent once more with the new one; when this address's flow changed, Conflict says so. */
  async function write(change: Change, version: number | undefined, retried: boolean): Promise<void> {
    try {
      await request(`/v1/inbound/addresses/${encodeURIComponent(saved!.id)}/flow`, { method: 'PATCH', body: change, ifMatch: version })
    } catch (error) {
      if (retried || !(error instanceof ApiError && error.code === 'VERSION_CONFLICT')) throw error
      const fresh = (await overview.refetch()).data
      const now = fresh?.routes.data.find(r => r.address?.id === saved!.id)
      if (!fresh || !now || !sameFlow(opened!.entry, now, opened!.overview, fresh)) throw error
      await write(change, fresh.version, true)
    }
  }
  const startOver = async () => {
    const fresh = (await overview.refetch()).data, now = fresh?.routes.data.find(r => r.address?.id === saved?.id)
    if (fresh && now) setOpened({ entry: now, overview: fresh })
    setPlan(null); setConflict(false); setErrors({}); setProblem(null)
  }

  const title = step === 'address' ? 'New address' : step === 'flow' && asking ? 'Replace the existing split?' : <PrivateAddress value={own} />
  const ready = step !== 'flow' || (!!boxes.data && overview.data !== undefined && (!editing || !!opened))
  const stepsPath = saved ? `/receiving/addresses/${saved.id}?tab=flow&edit=1` : null
  const footer = step === 'address' ? <><Button onClick={() => close()}>Cancel</Button><Button variant="primary" type="submit" form="builder-address">Next</Button></>
    : step === 'flow' && asking ? <><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" onClick={() => { setReplace(true); setPlan({ ...base!.plan, split: true, condition: split!, value: '' }) }}>Replace it</Button></>
    : step === 'flow' ? <>{editing ? <Button disabled={busy} onClick={() => close()}>Cancel</Button> : <Button disabled={busy} onClick={() => setStep('address')}>Back</Button>}{fits && <Button variant="primary" type="submit" form="builder-flow" loading={busy} disabled={!ready || conflict}>Save</Button>}</>
    : <>{saved && <Link className="ui-button ui-button--secondary ui-button--md" to={`/receiving/addresses/${saved.id}`} onClick={() => onOpenChange(false)}>Open address</Link>}<Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button></>
  const picker = (side: Side, routeOnly: boolean) => <DestinationPicker id={`builder-${side}`} value={draft[side]} onChange={value => set({ [side]: value })} target={draft.targets[side] ?? ''} onTarget={value => set({ targets: { ...draft.targets, [side]: value } })} own={own} boxes={boxes.data ?? []} overview={overview.data!} routeOnly={routeOnly} error={errors[side]} domain={own.split('@')[1]} />
  let body: ReactNode
  if (step === 'address') body = <form id="builder-address" className="stack" onSubmit={next} noValidate>
    <Field label="Address" htmlFor="builder-address-input" error={errors.address}>
      <Input id="builder-address-input" type="email" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder={`support@${receiving[0]?.name ?? 'example.com'}`} autoFocus autoComplete="off" />
    </Field>
    {onPattern && pattern && <div className="cluster"><Button size="sm" onClick={() => { onOpenChange(false); onPattern(pattern) }}>{pattern.startsWith('*@') ? 'Edit the catch-all' : 'Set up the wildcard'}</Button></div>}
    {existing && <div className="cluster"><Link className="ui-button ui-button--secondary ui-button--sm" to={`/receiving/addresses/${existing.id}?tab=flow`} onClick={() => onOpenChange(false)}>Open it</Link></div>}
    <Field label="Display name" htmlFor="builder-address-name"><Input id="builder-address-name" value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} placeholder="Support" /></Field>
    <details className="inbound-advanced" open={!!form.lifetime || !!form.publicAddress || !!errors.publicAddress || undefined}>
      <summary>Lifetime and reply-as</summary>
      <div className="stack inbound-advanced__body">
        <Field label="Receives mail for" htmlFor="builder-lifetime"><Select id="builder-lifetime" value={form.lifetime} onValueChange={value => setForm({ ...form, lifetime: value, ...(value ? { publicAddress: '' } : {}) })} options={lifetimes} /></Field>
        {!form.lifetime && <Field label="Reply as" htmlFor="builder-public" error={errors.publicAddress}><Input id="builder-public" type="email" value={form.publicAddress} onChange={e => setForm({ ...form, publicAddress: e.target.value })} autoComplete="off" /></Field>}
      </div>
    </details>
  </form>
  else if (step === 'flow' && fits && asking) body = <div className="stack">
    <p>It already splits its mail with this rule. Replacing it changes where that mail goes.</p>
    <Flow label="Its rule now"><FlowStage kind="process"><FlowItem><RuleLine rule={base!.rule!} keyName={base!.rule!.key} endpoints={overview.data?.endpoints} /></FlowItem></FlowStage></Flow>
  </div>
  else if (step === 'flow' && !fits) body = <div className="stack">
    <Alert tone="info">Its mail goes further than this editor shows.</Alert>
    {stepsPath && <p><Link to={stepsPath} onClick={leaveTo(stepsPath)}>Edit on its page</Link></p>}
  </div>
  else if (step === 'flow') body = <form id="builder-flow" className="stack" onSubmit={save} noValidate>
    {!ready ? <div className="flow-skeleton" aria-hidden="true"><span /><span /><span /></div> : <Flow label="Where this mail goes">
      <FlowStage kind="receive"><FlowItem><Match value={own} /></FlowItem></FlowStage>
      <FlowStage kind="process">
        {/* One rule changed by key keeps its shape: the toggle would reroute the address, which isn't this editor's. */}
        {!ruleMode && <div className="builder-ways" role="group" aria-label="How many ways">
          <button type="button" className="rcv-kind" aria-pressed={!draft.split} onClick={() => set({ split: false })}>One destination</button>
          <button type="button" className="rcv-kind" aria-pressed={draft.split} onClick={() => set({ split: true })}>Split with a rule</button>
        </div>}
        {draft.split && <div className="builder-condition">
          <Select aria-label="If" value={draft.condition} onValueChange={value => set({ condition: value as Condition })} options={conditions.map(c => ({ value: c.value, label: c.label }))} />
          {draft.condition !== 'attachment' && <Field label={<span className="sr-only">{conditions.find(c => c.value === draft.condition)!.label}</span>} htmlFor="builder-value" error={errors.value}>
            <Input id="builder-value" value={draft.value} placeholder={conditions.find(c => c.value === draft.condition)!.placeholder} autoComplete="off" onChange={e => set({ value: e.target.value })} aria-invalid={!!errors.value || undefined} />
          </Field>}
          {draft.condition === 'ai' && <p className="builder-note">Checked by AI · ${catalog.data?.decisionPricePerThousand ?? '0.10'} per 1,000 emails</p>}
        </div>}
        {others > 0 && stepsPath && <FlowItem><Link to={stepsPath} onClick={leaveTo(stepsPath)}>{others} more {others === 1 ? 'rule' : 'rules'}</Link></FlowItem>}
      </FlowStage>
      {draft.split ? <FlowFork labels={['If yes', 'Otherwise']} yes={picker('then', false)} no={picker('otherwise', false)} />
        : <FlowStage kind="deliver">{picker('then', !ruleMode)}</FlowStage>}
      {draft.split && base?.rule && base.also.length > 0 && <FlowStage kind="deliver" title="Also">
        {base.also.map(t => <FlowItem key={`${t.type}:${t.id}`} icon={<TargetIcon type={t.type} />}>{targetWord(t, saved?.id, true)}</FlowItem>)}
      </FlowStage>}
    </Flow>}
    {base?.rule && base.rule.attachedTo.length > 1 && <Alert tone="info">Its rule also runs on other addresses. A change here applies to this one only.</Alert>}
    {replacing && <Alert tone="warning">Its mail also goes to {base!.also.map((t, i) => <span key={`${t.type}:${t.id}`}>{i > 0 && (i === base!.also.length - 1 ? ' and ' : ', ')}{targetWord(t, saved?.id)}</span>)}. Saving stops that.</Alert>}
    {conflict && <><Alert tone="warning">Its flow changed since you opened it. Nothing was saved.</Alert><div className="cluster"><Button size="sm" onClick={() => void startOver()}>Show the saved flow</Button></div></>}
    {waiting && <AwaitingConfirm address={waiting} />}
    {problem !== null && <Alert tone="danger">{errorText(problem)}</Alert>}
  </form>
  else body = entry && overview.data ? <div className="addr-flow"><FlowPanel entry={entry} overview={overview.data} onEdit={() => { if (builderFits(entry, overview.data!)) { setPlan(null); setStep('flow') } else close(() => navigate(stepsPath!)) }} mailLink={false} /></div>
    : <div className="flow-skeleton" aria-hidden="true"><span /><span /><span /></div>
  return <>
    <Dialog size="lg" open={open} onOpenChange={next => { if (!next) close() }} title={title} analytics="address-builder" footer={footer} className="builder">{body}</Dialog>
    <ConfirmDialog open={!!leaving} onOpenChange={next => { if (!next) setLeaving(null) }} title="Discard changes?" description="What you set here isn’t saved." confirmLabel="Discard" danger onConfirm={() => { const go = leaving; setLeaving(null); go?.() }} />
  </>
}
