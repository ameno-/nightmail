// New address, and where its mail goes, in one place; the same builder changes an address later. The address first,
// then the flow it will run, drawn as the flow panel draws it: the email at the top, an optional rule that forks it two
// ways, and the destination slots below. Saving composes the public API's own calls: createInboundAddress,
// createEndpoint for a new destination, the two-way rules (createRuleFromRecipe or updateRuleFromRecipe with split or
// split-by-meaning) and the address's route. Each step adds before it removes, so mail is never lost halfway: a new rule
// runs before the route stops the inbox, and the route is back on the inbox before an old rule goes.
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Dialog, Field, Input, Select, type SelectOption } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useApi, useApiDef, useApiQuery } from '../../data/context'
import { queries } from '../../data/queries'
import { request } from '../../data/live'
import { staleAfterWrite } from '../../data/invalidation'
import { ApiError, errorText, type InboundAddress, type MailboxDomain } from '../../data/types'
import { idempotencyFor, addressOption } from './shared'
import { Flow, FlowFork, FlowItem, FlowStage } from './flow'
import { FlowPanel } from './panel'
import { receivingDomains, useOverview, type Overview, type OverviewRule, type RouteEntry } from './overview'
import { Match, TargetIcon } from './parts'
import { AwaitingConfirm, discordUrl, slackUrl, targetProblem } from './ritual-connections'
import { TITLE } from './routing'

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/
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
type NewType = 'slack' | 'discord' | 'webhook' | 'forward'
/** A destination slot's choice: the address's own inbox, another inbox, a destination by name, kept, dropped, or a new one. */
type Slot = string
type Plan = { split: boolean; condition: Condition; value: string; then: Slot; otherwise: Slot; targets: Record<string, string> }
const SPLIT = ['split', 'split-by-meaning']
const newLabel: Record<NewType, string> = { slack: 'New Slack channel', discord: 'New Discord channel', webhook: 'New webhook', forward: 'Forward to someone new' }
const newField: Record<NewType, { label: string; placeholder: string }> = {
  slack: { label: 'Slack incoming webhook URL', placeholder: 'https://hooks.slack.com/services/…' },
  discord: { label: 'Discord webhook URL', placeholder: 'https://discord.com/api/webhooks/…' },
  webhook: { label: 'Your URL', placeholder: 'https://' },
  forward: { label: 'Their address', placeholder: 'team@example.com' },
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56)
const freeName = (base: string, taken: Set<string>) => { const stem = slug(base) || 'desk'; for (let n = 1; ; n++) { const name = n === 1 ? stem : `${stem}-${n}`; if (!taken.has(name)) return name } }

/** The address's flow as the builder edits it, from the overview's row: its two-way rule, or else its route. */
function planOf(entry: RouteEntry | undefined, overview: Overview | undefined, boxes: InboundAddress[]): { plan: Plan; rule: OverviewRule | null; extra: boolean } {
  const blank: Plan = { split: false, condition: 'subject', value: '', then: 'own', otherwise: 'own', targets: {} }
  if (!entry || !overview) return { plan: blank, rule: null, extra: false }
  const own = entry.address?.id
  const pickOf = (param: string | undefined): Slot => {
    if (!param) return 'own'
    if (param === 'store' || param === 'drop') return param
    if (param.startsWith('inbox:')) { const box = boxes.find(b => b.key === param.slice(6)); return !box || box.id === own ? 'own' : `inbox:${box.id}` }
    return `endpoint:${param}`
  }
  const rule = overview.rules.find(r => r.recipe && SPLIT.includes(r.recipe.id) && entry.rules.includes(r.key)) ?? null
  if (rule?.recipe) {
    const p = rule.recipe.params, one = (v: unknown) => Array.isArray(v) ? v.join(', ') : String(v ?? '')
    const ai = rule.recipe.id === 'split-by-meaning'
    return { rule, extra: false, plan: { ...blank, split: ai || p.test !== 'always', condition: ai ? 'ai' : (p.test === 'always' ? 'subject' : p.test as Condition), value: ai ? one(p.meaning) : one(p.value), then: pickOf(one(p.then)), otherwise: pickOf(one(p.otherwise) || undefined) } }
  }
  const to = entry.route?.to
  if (!to) return { plan: blank, rule: null, extra: false }
  if (to === 'drop') return { plan: { ...blank, then: 'drop' }, rule: null, extra: false }
  if (!to.length) return { plan: { ...blank, then: 'store' }, rule: null, extra: false }
  const first = to[0]!, box = boxes.find(b => b.id === first), hook = overview.endpoints.find(e => e.id === first)
  return { rule: null, extra: to.length > 1, plan: { ...blank, then: first === own ? 'own' : box ? `inbox:${box.id}` : hook ? `hook:${hook.id}` : 'own' } }
}

/** One destination slot: a picker of every place mail can go, and the field a new one needs. */
function DestinationPicker({ id, value, onChange, target, onTarget, own, boxes, overview, routeOnly, error }: {
  id: string; value: Slot; onChange: (next: Slot) => void; target: string; onTarget: (next: string) => void; own: string; boxes: InboundAddress[]; overview: Overview; routeOnly: boolean; error?: string
}) {
  // A rule names its destinations; a webhook made for events (no name) can only be a route's, with nothing else to choose.
  const named = overview.endpoints.filter(e => e.source === 'endpoint')
  const options: SelectOption[] = [
    { value: 'own', label: <>Its inbox</> , text: 'Its inbox' },
    ...boxes.filter(b => b.address !== own && b.kind !== 'inbox').map(b => ({ ...addressOption(`inbox:${b.id}`, b.address, b.displayName ?? undefined), label: <>{b.displayName ? `${b.displayName} inbox` : <><PrivateAddress value={b.address} /> inbox</>}</> })),
    ...named.map(e => ({ value: `endpoint:${e.name}`, text: e.name, disabled: e.type === 'forward' && e.status !== 'ready', label: <span className="builder-option"><TargetIcon type={e.type} />{e.name}<span className="muted"> · {typeWord[e.type]}</span></span> })),
    ...(routeOnly ? overview.endpoints.filter(e => e.source === 'inbound_webhook').map(e => ({ value: `hook:${e.id}`, text: e.name, label: <span className="builder-option"><TargetIcon type="webhook" />{e.name}<span className="muted"> · Webhook</span></span> })) : []),
    { value: 'store', label: 'Keep it, no inbox' },
    { value: 'drop', label: 'Drop it' },
    ...(['slack', 'discord', 'webhook', 'forward'] as NewType[]).map(type => ({ value: `new:${type}`, label: newLabel[type] })),
  ]
  const fresh = value.startsWith('new:') ? value.slice(4) as NewType : null
  return <div className="stack builder-slot">
    <Select id={id} aria-label="Destination" value={value} onValueChange={onChange} options={options} />
    {fresh && <Field label={newField[fresh].label} htmlFor={id + '-target'} error={error}>
      <Input id={id + '-target'} type={fresh === 'forward' ? 'email' : 'url'} value={target} placeholder={newField[fresh].placeholder} autoComplete="off" onChange={e => onTarget(e.target.value)} aria-invalid={!!error || undefined} />
    </Field>}
    {!fresh && error && <p className="ui-field__error" role="alert">{error}</p>}
  </div>
}
const typeWord = { webhook: 'Webhook', slack: 'Slack', discord: 'Discord', forward: 'Forward' } as const

type Step = 'address' | 'flow' | 'done'
/**
 * The builder. New: the address, then where its mail goes, then the result with Test. Editing (address given): where its
 * mail goes, then the result. Wildcards and catch-alls keep "Where should this mail go?" (routing.tsx).
 */
export function AddressBuilder({ open, onOpenChange, domains, initial = '', address, onSaved, split }: { open: boolean; onOpenChange: (open: boolean) => void; domains: Pick<MailboxDomain, 'id' | 'name' | 'status'>[] | Overview['domains']; initial?: string; address?: InboundAddress; onSaved?: (address: InboundAddress) => void; split?: Condition }) {
  const api = useApi(), client = useQueryClient()
  const receiving = receivingDomains(domains)
  const [step, setStep] = useState<Step>(address ? 'flow' : 'address')
  const [saved, setSaved] = useState<InboundAddress | null>(address ?? null)
  const [form, setForm] = useState({ address: initial, displayName: '', lifetime: '', publicAddress: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [problem, setProblem] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState<string | null>(null)
  const [attempt] = useState({ key: '', body: '' })
  const boxes = useApiDef(queries.inboundAddressOptions(), { enabled: open })
  const current = saved?.address ?? form.address.trim().toLowerCase()
  const overview = useOverview({ q: current, kind: 'address', limit: 5 }, false, open && (step !== 'address'))
  const entry = overview.data?.routes.data.find(r => r.address?.id === saved?.id)
  const decoded = planOf(entry, overview.data, boxes.data ?? [])
  const [plan, setPlan] = useState<Plan | null>(null)
  // Opened from New rule's "Send mail two ways": the address's flow, already split on that kind of check.
  useEffect(() => { if (open && split && overview.data && !plan) setPlan({ ...decoded.plan, split: true, condition: split }) }, [open, split, overview.data]) // eslint-disable-line react-hooks/exhaustive-deps
  // Rules the builder doesn't draw (ready-made ones, scripts) keep running beside it.
  const others = (entry?.rules ?? []).filter(key => key !== decoded.rule?.key).length
  const draft = plan ?? decoded.plan
  const catalog = useApiQuery(['rule-recipes'], (_api, signal) => request<{ decisionPricePerThousand: string }>('/v1/rules/recipes', { signal }), { enabled: open && draft.condition === 'ai' })
  useEffect(() => { if (open) { setStep(address ? 'flow' : 'address'); setSaved(address ?? null); setForm({ address: initial, displayName: '', lifetime: '', publicAddress: '' }); setErrors({}); setProblem(null); setPlan(null); setWaiting(null) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<Plan>) => { setPlan({ ...draft, ...patch }); setProblem(null); setErrors({}) }
  const refresh = () => client.invalidateQueries({ predicate: query => staleAfterWrite(query.queryKey, false) })

  function next(event: FormEvent) {
    event.preventDefault()
    const value = form.address.trim().toLowerCase(), sender = form.publicAddress.trim().toLowerCase(), found: Record<string, string> = {}
    if (!EMAIL.test(value)) found.address = 'Enter a full email address, such as support@example.com.'
    else if (receiving.length && !receiving.some(d => d.name === value.split('@')[1])) found.address = `Use a receiving domain: ${receiving.map(d => d.name).join(', ')}.`
    else if ((boxes.data ?? []).some(b => b.address === value || b.aliases.includes(value))) found.address = 'That address exists. Open it from the list to change where its mail goes.'
    if (sender && form.lifetime) found.publicAddress = 'Temporary addresses cannot have a public sender address.'
    else if (sender && !EMAIL.test(sender)) found.publicAddress = 'Enter a full email address.'
    // The API takes a public sender only as the same local part on a parent domain.
    else if (sender && EMAIL.test(value) && (sender.split('@')[0] !== value.split('@')[0] || !value.split('@')[1]!.endsWith(`.${sender.split('@')[1]}`))) found.publicAddress = `Use ${value.split('@')[0]}@ on a parent domain of ${value.split('@')[1]}.`
    setErrors(found)
    if (!Object.keys(found).length) setStep('flow')
  }

  /** Makes sure an inbox can be named by a rule: it needs a key, which a new one gets from its address. */
  async function keyed(box: InboundAddress): Promise<string> {
    if (box.key) return box.key
    const taken = new Set((boxes.data ?? []).map(b => b.key).filter((k): k is string => !!k))
    const updated = await request<InboundAddress>(`/v1/inbound/addresses/${encodeURIComponent(box.id)}`, { method: 'PATCH', body: { key: freeName(box.address.split('@')[0]!, taken) } })
    return updated.key!
  }
  /** A slot's choice as a two-way rule names it (inbox:<key>, an endpoint, store or drop), making a new destination first. */
  async function realize(pick: Slot, target: string, self: InboundAddress): Promise<{ param: string; route: string[] | 'drop' | null; chat: boolean } | 'waiting'> {
    if (pick === 'own') return { param: `inbox:${await keyed(self)}`, route: null, chat: false }
    if (pick === 'store') return { param: 'store', route: [], chat: false }
    if (pick === 'drop') return { param: 'drop', route: 'drop', chat: false }
    if (pick.startsWith('inbox:')) { const box = (boxes.data ?? []).find(b => b.id === pick.slice(6))!; return { param: `inbox:${await keyed(box)}`, route: [box.id], chat: false } }
    if (pick.startsWith('hook:')) return { param: '', route: [pick.slice(5)], chat: false }
    if (pick.startsWith('endpoint:')) {
      const e = overview.data!.endpoints.find(x => x.source === 'endpoint' && x.name === pick.slice(9))!
      return { param: e.name, route: e.type === 'webhook' || e.type === 'forward' ? [e.id] : null, chat: e.type === 'slack' || e.type === 'discord' }
    }
    const type = pick.slice(4) as NewType, value = target.trim()
    const taken = new Set(overview.data!.endpoints.map(e => e.name))
    const name = freeName(type === 'forward' ? value.split('@')[0]! : `${self.address.split('@')[0]}-${type}`, taken)
    const post = (body: Record<string, unknown>) => request<{ id: string; name: string; status: string }>('/v1/endpoints', { method: 'POST', body, idempotencyKey: idempotencyFor(attempt, body) })
    let created: { id: string; name: string; status: string }
    if (type === 'forward') {
      const body = { type, name, address: value, from: self.id }
      try { created = await post({ ...body, preverify: true }) } catch (e) { if (!(e instanceof ApiError && e.code === 'PREVERIFY_NOT_ALLOWED')) throw e; created = await post(body) }
      if (created.status !== 'ready') { setWaiting(value); await refresh(); return 'waiting' }
    } else created = await post({ type, name, url: value })
    return { param: created.name, route: type === 'webhook' || type === 'forward' ? [created.id] : null, chat: type === 'slack' || type === 'discord' }
  }
  const targetError = (pick: Slot, value: string) => {
    if (!pick.startsWith('new:')) return ''
    const type = pick.slice(4) as NewType, v = value.trim()
    if (!v) return type === 'forward' ? 'Enter their address.' : 'Paste the URL.'
    return type === 'slack' && !slackUrl.test(v) ? targetProblem('slack', v) : type === 'discord' && !discordUrl.test(v) ? targetProblem('discord', v) : targetProblem(type, v)
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    const found: Record<string, string> = {}
    if (draft.split && draft.condition !== 'attachment' && !draft.value.trim()) found.value = draft.condition === 'ai' ? 'Describe it, like a refund request.' : draft.condition === 'from' ? 'Add an address or @domain.' : 'Add a word to look for.'
    const thenProblem = targetError(draft.then, draft.targets.then ?? ''), otherProblem = draft.split ? targetError(draft.otherwise, draft.targets.otherwise ?? '') : ''
    if (thenProblem) found.then = thenProblem
    if (otherProblem) found.otherwise = otherProblem
    setErrors(found)
    if (Object.keys(found).length) return
    setBusy(true); setProblem(null); setWaiting(null)
    try {
      // 1. The address (a new one receives into its own inbox until the route below says otherwise).
      let self = saved
      if (!self) {
        const value = form.address.trim().toLowerCase(), sender = form.publicAddress.trim().toLowerCase()
        self = await api.inbound.createAddress({ address: value, displayName: form.displayName.trim() || null, ...(sender ? { publicAddress: sender } : {}), ...(form.lifetime ? { ttlSeconds: Number(form.lifetime) } : {}) })
        setSaved(self)
      }
      // 2. Its destinations, made first when new.
      const then = await realize(draft.then, draft.targets.then ?? '', self)
      const otherwise = draft.split ? await realize(draft.otherwise, draft.targets.otherwise ?? '', self) : null
      if (then === 'waiting' || otherwise === 'waiting') return
      // 3. A rule when the mail forks, or when its one destination is a channel (only a rule writes a post).
      const rule = draft.split || then.chat || (then.param && then.route === null && draft.then !== 'own')
      const route = entry?.route ?? null
      const setRoute = async (to: string[] | 'drop' | null) => {
        if (to === null) { if (route) await api.routing.deleteRoute(route.id); return }
        if (route) await api.routing.updateRoute(route.id, { to, enabled: true }); else await api.routing.createRoute({ match: self!.address, to })
      }
      const existing = decoded.rule
      if (rule) {
        const recipe = draft.split && draft.condition === 'ai' ? 'split-by-meaning' : 'split'
        const params = !draft.split ? { test: 'always', then: then.param }
          : draft.condition === 'ai' ? { meaning: draft.value, then: then.param, otherwise: otherwise!.param }
          : { test: draft.condition, ...(draft.condition === 'attachment' ? {} : { value: draft.value }), then: then.param, otherwise: otherwise!.param }
        if (existing) await request(`/v1/rules/scripts/${encodeURIComponent(existing.key)}/recipe`, { method: 'PUT', body: { recipe, params } })
        else await request('/v1/rules/recipes', { method: 'POST', body: { recipe, params, addresses: [self.id] } })
        await setRoute([])
      } else {
        await setRoute(then.route)
        if (existing) await request(`/v1/rules/scripts/${encodeURIComponent(existing.key)}`, { method: 'DELETE' })
      }
      await refresh()
      onSaved?.(self)
      // Edit after Done reads the saved flow back, not this draft.
      setPlan(null)
      setStep('done')
    } catch (error) {
      if (error instanceof ApiError && error.fields['params.value']) setErrors({ value: error.fields['params.value'] })
      else setProblem(error)
    } finally { setBusy(false) }
  }

  const own = saved?.address ?? form.address.trim().toLowerCase()
  const title = step === 'address' ? 'New address' : step === 'flow' ? TITLE : 'Done'
  const ready = step !== 'flow' || (!!boxes.data && overview.data !== undefined)
  const footer = step === 'address' ? <><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" form="builder-address">Next</Button></>
    : step === 'flow' ? <>{!address && !saved && <Button disabled={busy} onClick={() => setStep('address')}>Back</Button>}<Button variant="primary" type="submit" form="builder-flow" loading={busy} disabled={!ready}>Save</Button></>
    : <>{!address && saved && <Link className="ui-button ui-button--secondary ui-button--md" to={`/receiving/addresses/${saved.id}`} onClick={() => onOpenChange(false)}>Open address</Link>}<Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button></>
  return <Dialog size="lg" open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }} title={title} footer={footer} className="builder">
    {step === 'address' ? <form id="builder-address" className="stack" onSubmit={next} noValidate>
      <Field label="Address" htmlFor="builder-address-input" error={errors.address}>
        <Input id="builder-address-input" type="email" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder={`support@${receiving[0]?.name ?? 'example.com'}`} autoFocus autoComplete="off" />
      </Field>
      <Field label="Display name" htmlFor="builder-address-name"><Input id="builder-address-name" value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} placeholder="Support" /></Field>
      <details className="inbound-advanced" open={!!form.lifetime || !!form.publicAddress || !!errors.publicAddress || undefined}>
        <summary>Lifetime and reply-as</summary>
        <div className="stack inbound-advanced__body">
          <Field label="Receives mail for" htmlFor="builder-lifetime"><Select id="builder-lifetime" value={form.lifetime} onValueChange={value => setForm({ ...form, lifetime: value, ...(value ? { publicAddress: '' } : {}) })} options={lifetimes} /></Field>
          {!form.lifetime && <Field label="Reply as" htmlFor="builder-public" error={errors.publicAddress}><Input id="builder-public" type="email" value={form.publicAddress} onChange={e => setForm({ ...form, publicAddress: e.target.value })} autoComplete="off" /></Field>}
        </div>
      </details>
    </form>
    : step === 'flow' ? <form id="builder-flow" className="stack" onSubmit={save} noValidate>
      {!ready ? <div className="flow-skeleton" aria-hidden="true"><span /><span /><span /></div> : <Flow label="Where this mail goes">
        <FlowStage kind="receive"><FlowItem><Match value={own} /></FlowItem></FlowStage>
        <FlowStage kind="process">
          <div className="builder-ways" role="group" aria-label="How many ways">
            <button type="button" className="rcv-kind" aria-pressed={!draft.split} onClick={() => set({ split: false })}>One destination</button>
            <button type="button" className="rcv-kind" aria-pressed={draft.split} onClick={() => set({ split: true })}>Split with a rule</button>
          </div>
          {draft.split && <div className="builder-condition">
            <Select aria-label="If" value={draft.condition} onValueChange={value => set({ condition: value as Condition })} options={conditions.map(c => ({ value: c.value, label: c.label }))} />
            {draft.condition !== 'attachment' && <Field label={<span className="sr-only">{conditions.find(c => c.value === draft.condition)!.label}</span>} htmlFor="builder-value" error={errors.value}>
              <Input id="builder-value" value={draft.value} placeholder={conditions.find(c => c.value === draft.condition)!.placeholder} autoComplete="off" onChange={e => set({ value: e.target.value })} aria-invalid={!!errors.value || undefined} />
            </Field>}
            {draft.condition === 'ai' && <p className="builder-note">Checked by AI · ${catalog.data?.decisionPricePerThousand ?? '0.10'} per 1,000 emails</p>}
          </div>}
          {others > 0 && saved && <FlowItem><Link to={`/receiving/addresses/${saved.id}?tab=flow&edit=1`} onClick={() => onOpenChange(false)}>{others} more {others === 1 ? 'rule' : 'rules'}</Link></FlowItem>}
        </FlowStage>
        {draft.split ? <FlowFork labels={['If yes', 'Otherwise']}
          yes={<DestinationPicker id="builder-then" value={draft.then} onChange={value => set({ then: value })} target={draft.targets.then ?? ''} onTarget={value => set({ targets: { ...draft.targets, then: value } })} own={own} boxes={boxes.data ?? []} overview={overview.data!} routeOnly={false} error={errors.then} />}
          no={<DestinationPicker id="builder-otherwise" value={draft.otherwise} onChange={value => set({ otherwise: value })} target={draft.targets.otherwise ?? ''} onTarget={value => set({ targets: { ...draft.targets, otherwise: value } })} own={own} boxes={boxes.data ?? []} overview={overview.data!} routeOnly={false} error={errors.otherwise} />} />
          : <FlowStage kind="deliver"><DestinationPicker id="builder-then" value={draft.then} onChange={value => set({ then: value })} target={draft.targets.then ?? ''} onTarget={value => set({ targets: { ...draft.targets, then: value } })} own={own} boxes={boxes.data ?? []} overview={overview.data!} routeOnly error={errors.then} /></FlowStage>}
      </Flow>}
      {decoded.extra && <Alert tone="warning">Its mail also goes to other destinations now. Saving keeps only the ones here.</Alert>}
      {waiting && <AwaitingConfirm address={waiting} />}
      {problem !== null && <Alert tone="danger">{errorText(problem)}</Alert>}
    </form>
    : entry && overview.data ? <div className="addr-flow"><FlowPanel entry={entry} overview={overview.data} onEdit={() => setStep('flow')} mailLink={false} /></div>
    : <div className="flow-skeleton" aria-hidden="true"><span /><span /><span /></div>}
  </Dialog>
}
