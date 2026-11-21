import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { Alert, Button, ConfirmDialog, Dialog, Disclosure, ErrorState, Field, IconButton, Input, KeyValues, LoadingRegion, PageHeader, Select, SkeletonText, Tabs, useToast, fieldError, MutationError } from '../../components/ui'
import { useApiMutation, useApiQuery, useWorkspaceAccess } from '../../data/context'
import { date, number } from '../../lib/format'
import { AddressMail } from './threads'
import { request } from '../../data/live'
import { errorText, type InboundAddress, type InboundAddressInput, type InboundAddressPatch, type MailboxDomain } from '../../data/types'
import { AliasEditor, aliasState, commitAliases, type AliasState } from './aliases'
import { steps } from './concepts'
import { typeLabel, useOverview } from './overview'
import { Match, RitualIcon, TargetIcon, targetName } from './parts'
import { RuleLine } from './recipes'
import { RouteEditor } from './routing'
import '../settings/settings.css'
import './inbound.css'
import './receiving.css'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useSingleFlight } from '../../lib/single-flight'
import { RITUALS_PER_ADDRESS } from '../../../../api/src/ritual-schema'

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/
// How long an address receives: always, or for a while, then it stops (its mail stays readable).
const lifetimes = [{ value: '', label: 'Always' }, { value: '3600', label: '1 hour' }, { value: '86400', label: '1 day' }, { value: '604800', label: '7 days' }, { value: '2592000', label: '30 days' }]
export const receivingDomains = <D extends Pick<MailboxDomain, 'status'>>(domains: D[]) => domains.filter(domain => !['off', 'disabled'].includes(domain.status))

export function CreateAddressDialog({ open, onOpenChange, domains }: { open: boolean; onOpenChange: (open: boolean) => void; domains: Pick<MailboxDomain, 'id' | 'name' | 'status'>[] }) {
  const navigate = useNavigate()
  const [address, setAddress] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [publicAddress, setPublicAddress] = useState('')
  const [lifetime, setLifetime] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const create = useApiMutation((api, input: InboundAddressInput) => api.inbound.createAddress(input), 'Address created')
  const receiving = receivingDomains(domains)
  useEffect(() => { if (open) { create.reset(); setErrors({}); setAddress(''); setDisplayName(''); setPublicAddress(''); setLifetime('') } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = address.trim().toLowerCase()
    const next: Record<string, string> = {}
    if (!EMAIL.test(value)) next.address = 'Enter a full email address, such as support@example.com.'
    else if (receiving.length && !receiving.some(domain => domain.name === value.split('@')[1])) next.address = `Use a receiving domain: ${receiving.map(domain => domain.name).join(', ')}.`
    const sender = publicAddress.trim().toLowerCase()
    // The API accepts a public sender only on permanent addresses; the form keeps the two exclusive.
    if (sender && lifetime) next.publicAddress = 'Temporary addresses cannot have a public sender address.'
    else if (sender && !EMAIL.test(sender)) next.publicAddress = 'Enter a full email address.'
    else if (sender && EMAIL.test(value) && (sender.split('@')[0] !== value.split('@')[0] || !value.split('@')[1]!.endsWith(`.${sender.split('@')[1]}`))) next.publicAddress = `Use ${value.split('@')[0]}@ on a parent domain of ${value.split('@')[1]}.`
    setErrors(next)
    if (Object.keys(next).length) return
    try { const row = await create.mutateAsync({ address: value, displayName: displayName.trim() || null, ...(sender ? { publicAddress: sender } : {}), ...(lifetime ? { ttlSeconds: Number(lifetime) } : {}) }); onOpenChange(false); navigate(`/receiving/addresses/${row.id}`) } catch { /* Shown in the form. */ }
  }
  return <Dialog open={open} onOpenChange={next => { if (!create.isPending) onOpenChange(next) }} title="New address" footer={<><Button disabled={create.isPending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" form="inbound-create-address" loading={create.isPending}>Create address</Button></>}>
    <form id="inbound-create-address" className="stack" onSubmit={submit} noValidate>
      <MutationError error={create.error} />
      {/* A domain that doesn't receive is named in the error, with the ones that do. */}
      <Field label="Address" htmlFor="inbound-address" error={errors.address || fieldError(create.error, 'address')}>
        <Input id="inbound-address" type="email" value={address} onChange={event => setAddress(event.target.value)} disabled={create.isPending} placeholder={`support@${receiving[0]?.name ?? 'example.com'}`} autoFocus autoComplete="off" />
      </Field>
      <Field label="Display name" htmlFor="inbound-address-name" error={fieldError(create.error, 'displayName')}><Input id="inbound-address-name" value={displayName} onChange={event => setDisplayName(event.target.value)} disabled={create.isPending} placeholder="Support" /></Field>
      {/* Most people never need these: folded away, both left empty by default. Reply as is for permanent addresses only,
          so it goes away while a lifetime is set; its placeholder is the address it would answer as. */}
      <details className="inbound-advanced" open={!!lifetime || !!publicAddress || !!errors.publicAddress || undefined}>
        <summary>Lifetime and reply-as</summary>
        <div className="stack inbound-advanced__body">
          <Field label="Receives mail for" htmlFor="inbound-address-lifetime" error={fieldError(create.error, 'ttlSeconds')}>
            <Select id="inbound-address-lifetime" value={lifetime} onValueChange={value => { setLifetime(value); if (value) setPublicAddress('') }} disabled={create.isPending} options={lifetimes} />
          </Field>
          {!lifetime && <Field label="Reply as" htmlFor="inbound-address-public" error={errors.publicAddress || fieldError(create.error, 'publicAddress')}>
            <Input id="inbound-address-public" type="email" value={publicAddress} onChange={event => setPublicAddress(event.target.value)} disabled={create.isPending} placeholder={address.includes('@') ? `${address.split('@')[0]}@${address.split('@')[1]!.split('.').slice(1).join('.') || 'example.com'}` : `support@${receiving[0] ? receiving[0].name.split('.').slice(receiving[0].name.split('.').length > 2 ? 1 : 0).join('.') : 'example.com'}`} autoComplete="off" />
          </Field>}
        </div>
      </details>
    </form>
  </Dialog>
}

// `base` is the saved address the edit started from, so a just-saved form doesn't wait on the refetch.
type AddressForm = { base: InboundAddress; displayName: string; aliases: AliasState }
const formOf = (address: InboundAddress): AddressForm => ({ base: address, displayName: address.displayName ?? '', aliases: aliasState(address.aliases) })
const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')

type RuleConfig = { version: number; config: { attachments: { rule: string; target: string; continue: boolean }[] } }

/** Address → Rules → Destinations for one address, with what can be done at each step right there. Its aliases and
 *  wildcards are edited in one place, its Settings tab. */
function AddressPath({ address, overview }: { address: InboundAddress; overview: ReturnType<typeof useOverview> }) {
  const toast = useToast()
  const entry = overview.data?.routes.data.find(r => r.address?.id === address.id)
  const [ritual, setRitual] = useState('')
  const [busy, setBusy] = useState(false)
  const [routing, setRouting] = useState(false)
  // Single flight: attaching reads the saved version and writes against it, so a second click would conflict with the first.
  type Attachments = RuleConfig['config']['attachments']
  const attach = useSingleFlight('rules.attachments', async (change: (list: Attachments) => Attachments, done: string, undo?: (list: Attachments) => Attachments) => {
    setBusy(true)
    try {
      const current = await request<RuleConfig>('/v1/rules')
      await request('/v1/rules/attachments', { method: 'PUT', body: { attachments: change(current.config.attachments) }, ifMatch: current.version })
      // Detaching changes how live mail is handled: Undo puts the rule back where it was.
      toast(done, 'success', undo && { label: 'Undo', onSelect: () => void attach(undo, 'Rule put back.') }); setRitual(''); await overview.refetch()
    } catch (e) { toast(errorText(e), 'error') } finally { setBusy(false) }
  }, address.id)
  const detach = (key: string) => void attach(list => list.filter(b => !(b.rule === key && b.target === address.id)), 'Rule detached.', list => {
    if (list.some(b => b.rule === key && b.target === address.id)) return list
    const before = attachedNow.indexOf(key), after = attachedNow[before + 1]
    const at = after ? list.findIndex(b => b.rule === after && b.target === address.id) : -1
    const entry = { rule: key, target: address.id, continue: !!overview.data?.rules.find(r => r.key === key)?.recipe }
    return at < 0 ? [...list, entry] : [...list.slice(0, at), entry, ...list.slice(at)]
  })
  const attached = entry?.rules ?? [], attachedNow = attached
  const available = (overview.data?.rules ?? []).filter(r => !attached.includes(r.key))
  return <div className="addr-path" aria-label="How mail to this address is handled">
    <section className="addr-step" id="route">
      <h2>{steps.receive.title}</h2>
      <ul>
        <li><Match value={address.address} /></li>
        {address.aliases.map(a => <li key={a}><Match value={a} /><span className="muted">alias</span></li>)}
        {address.rules.map(r => <li key={r}><Match value={r} /><span className="muted">wildcard</span></li>)}
      </ul>
    </section>
    <span className="addr-arrow" aria-hidden="true">→</span>
    <section className="addr-step" id="rules">
      <h2>{steps.process.title}</h2>
      {!entry ? <SkeletonText width="50%" /> : attached.length ? <ul>{attached.map((k, i) => <li key={k}><RitualIcon /><Link className="addr-rule" to={`/receiving/rules/${encodeURIComponent(k)}`}><RuleLine rule={overview.data?.rules.find(r => r.key === k)} keyName={k} /></Link>{i < attached.length - 1 && <span className="addr-then">then</span>}<span className="addr-grow" />
        <IconButton size="sm" label={`Detach ${k}`} disabled={busy} onClick={() => detach(k)}><X size={14} aria-hidden="true" /></IconButton></li>)}</ul>
        : <p className="addr-step__empty">{steps.process.empty}</p>}
      <div className="addr-step__foot">
        {available.length > 0 && <div className="addr-step__actions">
          <Select aria-label="Rule to attach" value={ritual} onValueChange={setRitual} options={[{ value: '', label: 'Attach a rule…' }, ...available.map(r => ({ value: r.key, text: r.key, label: <RuleLine rule={r} keyName={r.key} /> }))]} />
          <Button size="sm" disabled={!ritual || busy || attached.length >= RITUALS_PER_ADDRESS} onClick={() => void attach(list => [...list, { rule: ritual, target: address.id, continue: !!available.find(r => r.key === ritual)?.recipe }], `${ritual} attached.`)}>Attach</Button>
        </div>}
        <div className="addr-step__actions"><Link className="ui-button ui-button--ghost ui-button--sm" to={`/receiving/rules/new?address=${encodeURIComponent(address.id)}`}>New rule</Link></div>
      </div>
    </section>
    <span className="addr-arrow" aria-hidden="true">→</span>
    <section className="addr-step" id="goes-to">
      <h2>{steps.deliver.title}</h2>
      {/* The list is where its mail goes, a route's changes included (no Inbox when the route sends it elsewhere,
          Dropped when it drops it); webhooks past the first 50 are one link away. */}
      {!entry ? <SkeletonText width="50%" /> : <ul>{entry.to.map(t => <li key={`${t.type}:${t.id}`}><TargetIcon type={t.type} /><span>{targetName(t, address.id)}</span>{(t.via || t.status === 'paused' || t.type !== 'inbox' || t.id !== address.id) && <span className="muted">{t.via ? 'via a rule' : t.status === 'paused' ? 'Paused' : typeLabel[t.type]}</span>}</li>)}
        {entry.toTruncated && <li><Link to={`/receiving?tab=destinations&address=${encodeURIComponent(address.id)}`}>{number(entry.toTotal - entry.to.length)} more {entry.toTotal - entry.to.length === 1 ? 'webhook' : 'webhooks'}</Link></li>}</ul>}
      <div className="addr-step__actions"><Button size="sm" onClick={() => setRouting(true)}>Change</Button></div>
    </section>
    {routing && <RouteEditor match={address.address} route={entry?.route} to={[address.id]} onClose={() => { setRouting(false); void overview.refetch() }} />}
  </div>
}

/** Wildcard patterns that also deliver here, such as reply+*@acme.com. */
function PatternsField({ address, inputRef }: { address: InboundAddress; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [draft, setDraft] = useState('')
  const save = useApiMutation((api, rules: string[]) => api.inbound.updateAddress(address.id, { rules } as InboundAddressPatch), 'Wildcards saved', false, true, address.id)
  const rules = save.data?.rules ?? address.rules
  const domain = address.address.split('@')[1]
  async function add() {
    const value = draft.trim().toLowerCase(), full = value.includes('@') ? value : `${value}@${domain}`
    if (!value) return
    try { await save.mutateAsync([...rules, full]); setDraft('') } catch { /* Shown below. */ }
  }
  return <div className="ui-field addr-patterns">
    <label className="ui-field__label" htmlFor="address-pattern">Wildcards</label>
    {rules.length > 0 && <ul>{rules.map(r => <li key={r}><Match value={r} /><IconButton size="sm" label="Remove wildcard" disabled={save.isPending} onClick={() => void save.mutateAsync(rules.filter(x => x !== r)).catch(() => undefined)}><X size={14} aria-hidden="true" /></IconButton></li>)}</ul>}
    <div className="addr-patterns__add"><Input ref={inputRef} id="address-pattern" value={draft} disabled={save.isPending} placeholder={`name+*@${domain}`} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void add() } }} autoComplete="off" spellCheck={false} />
      <Button disabled={!draft.trim() || save.isPending} loading={save.isPending} onClick={() => void add()}>Add</Button></div>
    {save.error && <div className="ui-field__hint ui-field__error" role="alert">{errorText(save.error)}</div>}
  </div>
}

type AddressTab = 'mail' | 'flow' | 'settings'

export function InboundAddressDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { canAdminister } = useWorkspaceAccess()
  const address = useApiQuery(['inbound-address', id], (api, signal) => api.inbound.address(id, signal))
  const save = useApiMutation((api, patch: InboundAddressPatch) => api.inbound.updateAddress(id, patch), 'Address saved', false, true, id)
  const remove = useApiMutation((api, _: void) => api.inbound.deleteAddress(id), 'Address deleted', false, true, id)
  const [edited, setInput] = useState<AddressForm | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const patternInput = useRef<HTMLInputElement>(null)
  const current = address.data
  // Mail first: opening an address shows its mail. Where its mail goes and its settings are for owners and admins.
  const asked = params.get('tab')
  const tab: AddressTab = canAdminister && (asked === 'flow' || asked === 'settings') ? asked : 'mail'
  // The open conversation stays in the URL (and its unsent reply in the page) while another tab is looked at.
  const show = (next: AddressTab) => setParams(previous => {
    const query = new URLSearchParams()
    if (next !== 'mail') query.set('tab', next)
    for (const key of ['view', 'thread', 'message']) { const value = previous.get(key); if (value) query.set(key, value) }
    return query
  }, { replace: true })
  const overview = useOverview({ q: current?.address ?? '', kind: current?.kind === 'inbox' ? 'inbox' : 'address', limit: 5 }, false, canAdminister && !!current && tab === 'flow')
  const input = edited ?? (current ? formOf(current) : null)
  // Only a failed first load replaces the page: a later refetch that fails keeps the Settings form and its edits.
  if (address.error && !current) return <><PageHeader title="Address" backTo="/receiving" /><ErrorState error={address.error} onRetry={() => void address.refetch()} /></>
  const base = input?.base
  const dirty = !!base && !!input && (input.displayName.trim() !== (base.displayName ?? '') || !sameList(input.aliases.list, base.aliases) || !!input.aliases.draft.trim())
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!input || !base) return
    // Text still in the alias box counts: add it, or stop on it so nothing invalid is sent.
    const aliases = commitAliases(input.aliases, { address: base.address, temporary: !!base.expiresAt })
    if (!aliases.ok) { setInput({ ...input, aliases: { list: aliases.list, draft: aliases.draft, message: aliases.message } }); focus(() => document.getElementById('inbound-address-aliases')); return }
    const patch: InboundAddressPatch = {}
    if (input.displayName.trim() !== (base.displayName ?? '')) patch.displayName = input.displayName.trim() || null
    if (!sameList(aliases.list, base.aliases)) patch.aliases = aliases.list
    if (!Object.keys(patch).length) { setInput(null); return }
    setInput({ ...input, aliases: { list: aliases.list, draft: '', message: null } })
    try { setInput(formOf(await save.mutateAsync(patch))) } catch { /* Shown in the form. */ }
  }
  // Opens the aliases and wildcards (on the Settings tab) first when the field is inside them.
  const focus = (target: () => HTMLElement | null) => { const el = target(); el?.closest('details')?.setAttribute('open', ''); el?.scrollIntoView({ block: 'center' }); el?.focus() }
  const focusSettings = (target: () => HTMLElement | null) => { show('settings'); requestAnimationFrame(() => requestAnimationFrame(() => focus(target))) }
  const expired = !!current?.expiresAt && Date.parse(current.expiresAt) <= Date.now()
  return <div className="stack inbound-stack addr-root" data-tab={tab}>
    <PageHeader title={current ? <PrivateAddress value={current.address} /> : <SkeletonText width={240} lineHeight={28} />} backTo="/receiving" />
    {canAdminister && <Tabs label="Address" value={tab} onValueChange={value => show(value as AddressTab)}
      items={[{ value: 'mail', label: 'Mail' }, { value: 'flow', label: 'Where mail goes' }, { value: 'settings', label: 'Settings' }]} />}
    {expired && <Alert tone="info">This temporary address expired. It can’t receive or send, but its mail stays readable.</Alert>}
    {/* Mail stays mounted, hidden, behind the other tabs: a reply being written survives a look at them. */}
    <AddressMail addressId={id} hidden={tab !== 'mail'} />
    {tab === 'mail' ? null
      : !current || (tab === 'flow' && overview.data === undefined && !overview.error) ? <LoadingRegion label="Loading address"><div className="addr-skeleton" aria-hidden="true"><span /><span /><span /></div></LoadingRegion>
      : tab === 'flow' ? <div className="stack addr-page"><AddressPath address={current} overview={overview} />
        <div className="cluster"><Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/trace" state={{ to: current.address }}>Test</Link></div></div>
      : <div className="stack addr-page">
        <KeyValues className="addr-facts" items={[
          ['Domain', <Link key="d" to="/domains">{current.domain}</Link>],
          ...(current.publicAddress && current.publicAddress !== current.address ? [['Sends as', <PrivateAddress key="s" value={current.publicAddress} />] as [string, ReactNode]] : []),
          ['Created', `${current.origin === 'auto' ? 'By the catch-all, ' : ''}${date(current.createdAt)}`],
          ...(current.expiresAt ? [['Expires', date(current.expiresAt)] as [string, ReactNode]] : []),
        ]} />
        {input && <form className="stack inbound-settings-form" onSubmit={submit} noValidate>
          <MutationError error={save.error} />
          <Field label="Display name" htmlFor="inbound-address-display" error={fieldError(save.error, 'displayName')}><Input id="inbound-address-display" value={input.displayName} onChange={event => setInput({ ...input, displayName: event.target.value })} disabled={save.isPending} placeholder="Support" /></Field>
          {/* A temporary address can have neither aliases nor wildcards, so it has no editor for them. */}
          {!current.expiresAt && <Disclosure className="addr-more" title="Aliases and wildcards" defaultOpen={!!fieldError(save.error, 'aliases') || current.aliases.length + current.rules.length > 0}>
            <AliasEditor id="inbound-address-aliases" address={current.address} saved={input.base.aliases} value={input.aliases} onChange={aliases => setInput({ ...input, aliases })} disabled={save.isPending} error={fieldError(save.error, 'aliases')} />
            <PatternsField key={current.updatedAt} address={current} inputRef={patternInput} />
          </Disclosure>}
          <div className="cluster form-actions"><Button variant="primary" type="submit" loading={save.isPending} disabled={!dirty}>Save changes</Button>{dirty && !save.isPending && <Button onClick={() => { setInput(null); save.reset() }}>Discard</Button>}</div>
        </form>}
        <div className="addr-danger"><Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete address</Button></div>
      </div>}
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete this address?" description="Its mail stays in Logs. New mail to it and its aliases follows the domain’s catch-all, and nothing else delivers here." confirmLabel="Delete address" danger pending={remove.isPending} onConfirm={async () => { await remove.mutateAsync(); navigate('/receiving') }} />
  </div>
}
