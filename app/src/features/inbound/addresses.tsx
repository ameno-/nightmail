import { useEffect, useRef, useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'
import { Alert, Button, ConfirmDialog, Dialog, Disclosure, ErrorState, Field, IconButton, Input, LoadingRegion, PageHeader, SectionHeader, Select, SkeletonText, useToast, fieldError, MutationError } from '../../components/ui'
import { useApiDef, useApiMutation, useApiQuery, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { date, number } from '../../lib/format'
import { request } from '../../data/live'
import { errorText, type InboundAddress, type InboundAddressInput, type InboundAddressPatch, type MailboxDomain } from '../../data/types'
import { AliasEditor, aliasState, commitAliases, type AliasState } from './aliases'
import { steps } from './concepts'
import { typeLabel, useOverview } from './overview'
import { Match, RitualIcon, TargetIcon, targetName } from './parts'
import { RouteEditor } from './routing'
import { when } from './shared'
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

/** Route → Rules → Goes to for one address, with what can be done at each step right there. */
function AddressPath({ address, overview, onAddAlias, onAddPattern }: { address: InboundAddress; overview: ReturnType<typeof useOverview>; onAddAlias: () => void; onAddPattern: () => void }) {
  const toast = useToast()
  const entry = overview.data?.routes.data.find(r => r.address?.id === address.id)
  const [ritual, setRitual] = useState('')
  const [busy, setBusy] = useState(false)
  const [routing, setRouting] = useState(false)
  // Single flight: attaching reads the saved version and writes against it, so a second click would conflict with the first.
  const attach = useSingleFlight('rules.attachments', async (change: (list: RuleConfig['config']['attachments']) => RuleConfig['config']['attachments'], done: string) => {
    setBusy(true)
    try {
      const current = await request<RuleConfig>('/v1/rules')
      await request('/v1/rules/attachments', { method: 'PUT', body: { attachments: change(current.config.attachments) }, ifMatch: current.version })
      toast(done, 'success'); setRitual(''); await overview.refetch()
    } catch (e) { toast(errorText(e), 'error') } finally { setBusy(false) }
  }, address.id)
  const attached = entry?.rules ?? []
  const available = (overview.data?.rules ?? []).filter(r => !attached.includes(r.key))
  return <div className="addr-path" aria-label="How mail to this address is handled">
    <section className="addr-step" id="route">
      <h2>{steps.route.title}</h2>
      <ul>
        <li><Match value={address.address} /></li>
        {address.aliases.map(a => <li key={a}><Match value={a} /><span className="muted">alias</span></li>)}
        {address.rules.map(r => <li key={r}><Match value={r} /><span className="muted">pattern</span></li>)}
      </ul>
      {!address.expiresAt && <div className="addr-step__actions"><Button size="sm" variant="ghost" onClick={onAddAlias}>Add alias</Button><Button size="sm" variant="ghost" onClick={onAddPattern}>Add pattern</Button></div>}
    </section>
    <span className="addr-arrow" aria-hidden="true">→</span>
    <section className="addr-step" id="rules">
      <h2>{steps.rules.title}</h2>
      {!entry ? <SkeletonText width="50%" /> : attached.length ? <ul>{attached.map((k, i) => <li key={k}><RitualIcon /><Link to={`/receiving/rules/${encodeURIComponent(k)}`}><code>{k}</code></Link>{i < attached.length - 1 && <span className="addr-then">then</span>}<span className="addr-grow" />
        <IconButton size="sm" label={`Detach ${k}`} disabled={busy} onClick={() => void attach(list => list.filter(b => !(b.rule === k && b.target === address.id)), `${k} detached.`)}><X size={14} aria-hidden="true" /></IconButton></li>)}</ul>
        : <p className="addr-step__empty">{steps.rules.empty}</p>}
      <div className="addr-step__foot">
        {available.length > 0 && <div className="addr-step__actions">
          <Select aria-label="Rule to attach" value={ritual} onValueChange={setRitual} options={[{ value: '', label: 'Attach a rule…' }, ...available.map(r => ({ value: r.key, label: r.key }))]} />
          <Button size="sm" disabled={!ritual || busy || attached.length >= RITUALS_PER_ADDRESS} onClick={() => void attach(list => [...list, { rule: ritual, target: address.id, continue: !!available.find(r => r.key === ritual)?.recipe }], `${ritual} attached.`)}>Attach</Button>
        </div>}
        <div className="addr-step__actions"><Link className="ui-button ui-button--ghost ui-button--sm" to={`/receiving/rules/new?address=${encodeURIComponent(address.id)}`}>New rule</Link></div>
      </div>
    </section>
    <span className="addr-arrow" aria-hidden="true">→</span>
    <section className="addr-step" id="goes-to">
      <h2>{steps.goesTo.title}</h2>
      {/* The list is where its mail goes, a route's changes included (no Inbox when the route sends it elsewhere,
          Dropped when it drops it); webhooks past the first 50 are one link away. */}
      {!entry ? <SkeletonText width="50%" /> : <ul>{entry.to.map(t => <li key={`${t.type}:${t.id}`}><TargetIcon type={t.type} /><span>{targetName(t, address.id)}</span>{(t.via || t.status === 'paused' || t.type !== 'inbox' || t.id !== address.id) && <span className="muted">{t.via ? `via ${t.via}` : t.status === 'paused' ? 'Paused' : typeLabel[t.type]}</span>}</li>)}
        {entry.toTruncated && <li><Link to={`/receiving?tab=endpoints&address=${encodeURIComponent(address.id)}`}>{number(entry.toTotal - entry.to.length)} more {entry.toTotal - entry.to.length === 1 ? 'webhook' : 'webhooks'}</Link></li>}</ul>}
      <div className="addr-step__actions"><Button size="sm" onClick={() => setRouting(true)}>{entry?.route ? 'Edit route' : 'Add a route'}</Button></div>
    </section>
    {routing && <RouteEditor match={address.address} route={entry?.route} to={[address.id]} onClose={() => { setRouting(false); void overview.refetch() }} />}
  </div>
}

/** Wildcard patterns that also deliver here, such as reply+*@acme.com. */
function PatternsField({ address, inputRef }: { address: InboundAddress; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [draft, setDraft] = useState('')
  const save = useApiMutation((api, rules: string[]) => api.inbound.updateAddress(address.id, { rules } as InboundAddressPatch), 'Patterns saved', false, true, address.id)
  const rules = save.data?.rules ?? address.rules
  const domain = address.address.split('@')[1]
  async function add() {
    const value = draft.trim().toLowerCase(), full = value.includes('@') ? value : `${value}@${domain}`
    if (!value) return
    try { await save.mutateAsync([...rules, full]); setDraft('') } catch { /* Shown below. */ }
  }
  return <div className="ui-field addr-patterns">
    <label className="ui-field__label" htmlFor="address-pattern">Patterns</label>
    {rules.length > 0 && <ul>{rules.map(r => <li key={r}><Match value={r} /><IconButton size="sm" label="Remove pattern" disabled={save.isPending} onClick={() => void save.mutateAsync(rules.filter(x => x !== r)).catch(() => undefined)}><X size={14} aria-hidden="true" /></IconButton></li>)}</ul>}
    <div className="addr-patterns__add"><Input ref={inputRef} id="address-pattern" value={draft} disabled={save.isPending} placeholder={`name+*@${domain}`} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void add() } }} autoComplete="off" spellCheck={false} />
      <Button disabled={!draft.trim() || save.isPending} loading={save.isPending} onClick={() => void add()}>Add</Button></div>
    {save.error && <div className="ui-field__hint ui-field__error" role="alert">{errorText(save.error)}</div>}
  </div>
}

function RecentMail({ address, threads }: { address: InboundAddress; threads: ReturnType<typeof useAddressThreads> }) {
  if (threads.error) return <ErrorState error={threads.error} onRetry={() => void threads.refetch()} />
  if (!threads.data) return <div aria-hidden="true"><SkeletonText width="60%" /></div>
  if (!threads.data.length) return <p className="muted">No mail yet</p>
  return <ul className="addr-recent">{threads.data.slice(0, 5).map(t => <li key={t.id}><Link to={`/receiving/inbox?address=${address.id}&thread=${t.id}`}><span className="addr-recent__subject" title={t.subject || undefined}>{t.subject || '(no subject)'}</span><span className="addr-recent__snippet muted" title={t.snippet || undefined}>{t.snippet}</span><time>{when(t.lastMessageAt)}</time></Link></li>)}</ul>
}

const useAddressThreads = (id: string) => useApiDef(queries.inboundThreads(id, 'inbox', '', undefined))

export function InboundAddressDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { canAdminister } = useWorkspaceAccess()
  const address = useApiQuery(['inbound-address', id], (api, signal) => api.inbound.address(id, signal))
  const save = useApiMutation((api, patch: InboundAddressPatch) => api.inbound.updateAddress(id, patch), 'Address saved', false, true, id)
  const remove = useApiMutation((api, _: void) => api.inbound.deleteAddress(id), 'Address deleted', false, true, id)
  const [edited, setInput] = useState<AddressForm | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const patternInput = useRef<HTMLInputElement>(null)
  const current = address.data
  // The path and recent mail are separate reads; the page shows once all of them settle, so nothing moves in.
  const overview = useOverview({ q: current?.address ?? '', kind: current?.kind === 'inbox' ? 'inbox' : 'address', limit: 5 }, false, canAdminister && !!current)
  const threads = useAddressThreads(id)
  const ready = !!current && (!canAdminister || overview.data !== undefined || !!overview.error) && (threads.data !== undefined || !!threads.error)
  const input = edited ?? (current ? formOf(current) : null)
  if (address.error) return <><PageHeader title="Address" backTo="/receiving" /><ErrorState error={address.error} onRetry={() => void address.refetch()} /></>
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
  // Opens the aliases and patterns first when the field is inside them.
  const focus = (target: () => HTMLElement | null) => { const el = target(); el?.closest('details')?.setAttribute('open', ''); el?.scrollIntoView({ block: 'center' }); el?.focus() }
  return <div className="stack inbound-stack">
    {/* The actions hold their place while the address loads, as the same buttons disabled (their labels give their exact
        widths): on a phone they take a row of their own. */}
    <PageHeader title={current ? <PrivateAddress value={current.address} /> : <SkeletonText width={240} lineHeight={28} />} backTo="/receiving" actions={current ? <>
      {canAdminister && <Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/trace" state={{ to: current.address }}>Trace</Link>}
      <Link className="ui-button ui-button--secondary ui-button--md" to={`/receiving/inbox?address=${encodeURIComponent(current.id)}`}>Open in Inbox</Link>
      {canAdminister && <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>}
    </> : <>{canAdminister && <Button disabled>Trace</Button>}<Button disabled>Open in Inbox</Button>{canAdminister && <Button variant="danger" disabled>Delete</Button>}</>} />
    {!ready ? <LoadingRegion label="Loading address"><div className="addr-skeleton" aria-hidden="true"><span /><span /><span /></div></LoadingRegion> : current && <div className="stack inbound-stack addr-page">
      <dl className="settings-facts">
        <div><dt>Domain</dt><dd><Link to="/domains">{current.domain}</Link></dd></div>
        {current.publicAddress && current.publicAddress !== current.address && <div><dt>Sends as</dt><dd className="settings-break"><PrivateAddress value={current.publicAddress} /></dd></div>}
        <div><dt>Created</dt><dd>{current.origin === 'auto' ? 'By the catch-all, ' : ''}{date(current.createdAt)}</dd></div>
        {current.expiresAt && <div><dt>Expires</dt><dd>{date(current.expiresAt)}</dd></div>}
      </dl>
      {current.expiresAt && Date.parse(current.expiresAt) <= Date.now() && <Alert tone="info">This temporary address expired. It can’t receive or send, but its mail stays readable.</Alert>}
      {canAdminister && <AddressPath address={current} overview={overview} onAddAlias={() => focus(() => document.getElementById('inbound-address-aliases'))} onAddPattern={() => focus(() => patternInput.current)} />}
      <section className="section stack" aria-labelledby="address-recent">
        {/* The thread count heads the list; its newest row is the last message. */}
        <SectionHeader title={<span id="address-recent">Recent mail{current.stats.threads > 0 && <span className="muted"> · {number(current.stats.threads)} {current.stats.threads === 1 ? 'thread' : 'threads'}{current.stats.unreadThreads > 0 && `, ${number(current.stats.unreadThreads)} unread`}</span>}</span>} />
        <RecentMail address={current} threads={threads} />
      </section>
      {canAdminister && <section className="section section--bordered stack">
        <SectionHeader title="Settings" />
        {input && <form className="stack inbound-settings-form" onSubmit={submit} noValidate>
          <MutationError error={save.error} />
          <Field label="Display name" htmlFor="inbound-address-display" error={fieldError(save.error, 'displayName')}><Input id="inbound-address-display" value={input.displayName} onChange={event => setInput({ ...input, displayName: event.target.value })} disabled={save.isPending} placeholder="Support" /></Field>
          {/* The route above lists them; editing them is one click away (Add alias and Add pattern open it). A temporary
              address can have neither, so it has no editor for them. */}
          {!current.expiresAt && <Disclosure className="addr-more" title="Aliases and patterns" defaultOpen={!!fieldError(save.error, 'aliases')}>
            <AliasEditor id="inbound-address-aliases" address={current.address} saved={input.base.aliases} value={input.aliases} onChange={aliases => setInput({ ...input, aliases })} disabled={save.isPending} error={fieldError(save.error, 'aliases')} />
            <PatternsField key={current.updatedAt} address={current} inputRef={patternInput} />
          </Disclosure>}
          <div className="cluster form-actions"><Button variant="primary" type="submit" loading={save.isPending} disabled={!dirty}>Save changes</Button>{dirty && !save.isPending && <Button onClick={() => { setInput(null); save.reset() }}>Discard</Button>}</div>
        </form>}
      </section>}
    </div>}
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete this address?" description="Stored messages stay, without their read, star and archive state. New mail to it and its aliases follows the domain’s catch-all, and routes stop delivering here." confirmLabel="Delete address" danger pending={remove.isPending} onConfirm={async () => { await remove.mutateAsync(); navigate('/receiving') }} />
  </div>
}
