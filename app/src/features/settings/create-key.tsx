import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { Button, Checkbox, Dialog, Disclosure, Field, Input, fieldError, MutationError } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useApi, useApiDef, useApiMutation } from '../../data/context'
import { useMailServers } from '../docs/mail-settings'
import { queries } from '../../data/queries'
import type { ApiKeyInput, AppPasswordInput, AppPasswordProtocol, Inbox, KeyPermission, MailPermission, PageRequest } from '../../data/types'
import '../inbound/inbound.css'
import './api-keys.css'

/** What a new API key can reach: the whole workspace (four permission sets), or only mail at chosen addresses, one
 *  agent inbox, or the inboxes it creates. `/api-keys?create=<purpose>` opens Create key on it. */
export type Purpose = 'manage' | 'send' | 'read_send' | 'read' | 'addresses' | 'inbox' | 'create'
type WorkspacePurpose = Extract<Purpose, 'manage' | 'send' | 'read_send' | 'read'>
const workspacePermissions: Record<WorkspacePurpose, KeyPermission[]> = { manage: ['read', 'send', 'manage'], send: ['send'], read_send: ['read', 'send'], read: ['read'] }
const isWorkspace = (purpose: Purpose): purpose is WorkspacePurpose => purpose in workspacePermissions
// Each choice is named for what it reaches; what it can and can't do is in "What this key can do", which opens under
// the form and follows the choices.
const purposes: { value: Purpose; label: string; does: string }[] = [
  { value: 'manage', label: 'Full access', does: 'Sends, reads, and manages domains, keys and settings.' },
  { value: 'send', label: 'Sending only', does: 'Sends email from your app. Can’t read logs or change settings.' },
  { value: 'read_send', label: 'Send and read', does: 'Sends email and reads logs and events. Can’t change settings.' },
  { value: 'read', label: 'Read only', does: 'Reads logs, events and settings. Can’t send.' },
  { value: 'addresses', label: 'Mail at chosen addresses', does: 'Reads mail at the receiving addresses you choose. Nothing else.' },
  { value: 'inbox', label: 'One agent inbox', does: 'Reads one agent inbox. Stops working when the inbox is deleted.' },
  { value: 'create', label: 'Creates agent inboxes', does: 'Creates agent inboxes and reads only the ones it created.' },
]
type Kind = 'api' | 'smtp' | 'agent' | 'app'
// The type's name says who uses it; the page's "Which key to use" compares them.
const kinds: { value: Kind; label: string }[] = [
  { value: 'api', label: 'API key for your app or script' },
  { value: 'smtp', label: 'SMTP login for an app' },
  { value: 'agent', label: 'Connect an agent over MCP' },
  { value: 'app', label: 'App password for a mail app' },
]
const forms: Partial<Record<Kind, { title: string; id: string; submit: string }>> = {
  api: { title: 'Create API key', id: 'create-key', submit: 'Create key' },
  smtp: { title: 'Create SMTP login', id: 'create-smtp-login', submit: 'Create login' },
  app: { title: 'Create app password', id: 'create-app-password', submit: 'Create password' },
}
/** sendExample: a workspace key's first send. agent: an API key, which also connects an agent over MCP. mail: the
 *  server settings a mail app or an app's SMTP needs, with the username it signs in with. */
export type CreatedSecret = { secret: string; title: string; description?: string; sendExample?: boolean; agent?: boolean; mail?: { username: ReactNode; imap: boolean; smtp: boolean } }

/** Create key: the type first (API key, SMTP login, agent token, app password), then what it can reach. An agent token
 *  is the Connect an agent flow, so choosing it hands over to that dialog. `initial` opens straight on an API key's form,
 *  as Overview's "Create key" does with the domain it just verified, or on an SMTP login's. Render only while open, so form state and the created
 *  secret in mutation state go away on close. */
export function CreateKeyDialog({ open, onOpenChange, onCreated, onConnectAgent, initial }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (created: CreatedSecret) => void; onConnectAgent: () => void; initial?: { purpose?: Purpose; domain?: string; smtp?: boolean } }) {
  // SMTP needs the installation's mail gateway: without one, the form never opens.
  const servers = useMailServers()
  const [kind, setKind] = useState<Kind | null>(initial?.smtp && servers ? 'smtp' : initial?.purpose ? 'api' : null)
  const [pending, setPending] = useState(false)
  useDomainOptions(open)
  // One dialog for every step, so moving between them keeps focus inside it.
  const form = kind && (kind !== 'smtp' || servers) ? forms[kind] : undefined
  const props = { open, onOpenChange, onPending: setPending, onCreated }
  return <Dialog open={open} onOpenChange={next => { if (!pending) onOpenChange(next) }} title={form?.title ?? 'Create key'}
    footer={form ? <><Button disabled={pending} onClick={() => setKind(null)}>Back</Button><Button variant="primary" loading={pending} type="submit" form={form.id}>{form.submit}</Button></> : <Button onClick={() => onOpenChange(false)}>Cancel</Button>}>
    {kind === 'api' ? <ApiKeyForm {...props} initial={initial} />
      : kind === 'smtp' && servers ? <SmtpLoginForm {...props} />
      : kind === 'app' ? <AppPasswordForm {...props} />
      : <ul className="keys-types" aria-label="What kind of key?">
        {kinds.filter(item => item.value !== 'smtp' || servers).map(item => <li key={item.value}>
          <button type="button" className="keys-type" onClick={() => { if (item.value === 'agent') { onOpenChange(false); onConnectAgent() } else setKind(item.value) }}>
            <span className="keys-type__label">{item.label}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </li>)}
      </ul>}
  </Dialog>
}

/** Active inboxes to choose from, a page of 50 at a time: Load more reaches the rest. */
function useInboxOptions(key: string, filter: { type?: Inbox['type'] }, enabled: boolean) {
  const api = useApi()
  return useInfiniteQuery({
    queryKey: ['nightmail', 'agent-inboxes', key],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.inboxes.list({ ...filter, status: 'active', cursor: pageParam }, signal),
    getNextPageParam: last => last.nextCursor ?? undefined,
    staleTime: 60_000,
    retry: false,
  })
}
const activeInboxes = (query: ReturnType<typeof useInboxOptions>) => (query.data?.pages.flat() ?? []).filter(box => box.status === 'active')

/** Which inbox: a radio list, because a select would show the address unmasked. With none to choose, its place is the
 *  link to make one. */
function InboxChoice({ name, query, value, onChange, disabled, error, none }: { name: string; query: ReturnType<typeof useInboxOptions>; value: string; onChange: (id: string) => void; disabled: boolean; error?: string; none: ReactNode }) {
  const inboxes = activeInboxes(query)
  return <fieldset className="settings-key-domains" disabled={disabled} aria-describedby={error ? `${name}-error` : undefined}>
    <legend className="ui-field__label">Inbox</legend>
    {query.isPending && !query.isError ? <p className="muted" role="status">Loading inboxes…</p> : !inboxes.length && !query.isError ? <div className="keys-form-note">{none}</div>
      : <div className="settings-key-domain-options">{inboxes.map(box => <label key={box.id} className="keys-choice">
        <input type="radio" name={name} value={box.id} checked={value === box.id} onChange={() => onChange(box.id)} />
        <span>{box.name ? <>{box.name} · </> : null}<PrivateAddress value={box.address} /></span>
      </label>)}</div>}
    {query.isError && <div className="stack"><MutationError error={query.error} /><Button onClick={() => { void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch()) }}>Retry loading inboxes</Button></div>}
    {query.hasNextPage && !query.isError && <Button variant="ghost" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more inboxes</Button>}
    {error && <p id={`${name}-error`} className="ui-field__error" role="alert">{error}</p>}
  </fieldset>
}

export const chooseAddress = 'Choose an address, or Every address.'
const tooManyDomains = 'Select up to 50 domains.'
/** Which receiving addresses a key reaches, or every one: one control for Create key and a key's Edit addresses.
 *  `empty` takes the options' place while they load or when there are none. */
export function AddressChoice({ id, options, every, chosen, onEvery, onToggle, disabled, error, empty }: { id: string; options: { id: string; address: string }[]; every: boolean; chosen: string[];
  onEvery: (every: boolean) => void; onToggle: (id: string, checked: boolean) => void; disabled: boolean; error?: string; empty?: ReactNode }) {
  return <fieldset className="settings-key-domains" disabled={disabled} aria-describedby={error ? `${id}-error` : undefined}>
    <legend className="ui-field__label">Addresses</legend>
    <Checkbox label="Every address, including new ones" checked={every} onCheckedChange={onEvery} disabled={disabled} />
    <div className="settings-key-domain-options">
      {empty ?? options.map(item => <Checkbox key={item.id} label={<PrivateAddress value={item.address} />} checked={!every && chosen.includes(item.id)} disabled={disabled} onCheckedChange={checked => onToggle(item.id, checked)} />)}
    </div>
    {error && <p id={`${id}-error`} className="ui-field__error" role="alert">{error}</p>}
  </fieldset>
}

/** The workspace's sending domains, 10 at a time: Load more reaches the rest. Create key loads them as it opens, and
 *  the API keys page before it opens a form from a link, so a form's domain list never grows under its other fields. */
export function useDomainOptions(enabled: boolean) {
  const api = useApi()
  return useInfiniteQuery({
    queryKey: ['nightmail', 'domains', 'key-options'],
    enabled,
    initialPageParam: { page: 1 } as Pick<PageRequest, 'page' | 'cursor'>,
    queryFn: ({ pageParam, signal }) => api.domains.list({ ...pageParam, pageSize: 10 }, signal),
    getNextPageParam: last => last.nextCursor ? { cursor: last.nextCursor } : undefined,
    staleTime: 60_000,
    retry: false,
  })
}
const domainNames = (query: ReturnType<typeof useDomainOptions>, chosen: string[]) => [...new Set([...(query.data?.pages.flatMap(page => page.items) ?? []).map(domain => domain.name.toLowerCase()), ...chosen])].sort()

/** Which domains a key sends from. `every`: the All domains choice, which an SMTP login doesn't have. */
function DomainChoice({ query, chosen, onToggle, every, disabled, error, onLeave }: { query: ReturnType<typeof useDomainOptions>; chosen: string[]; onToggle: (domain: string, checked: boolean) => void;
  every?: { checked: boolean; onChange: (checked: boolean) => void }; disabled: boolean; error?: string; onLeave: () => void }) {
  const domains = domainNames(query, chosen)
  return <fieldset className="settings-key-domains" disabled={disabled} aria-describedby={error ? 'key-domain-error' : undefined}>
    <legend className="ui-field__label">Domains it can send from</legend>
    {every && <Checkbox label="All domains, including new ones" checked={every.checked} onCheckedChange={every.onChange} disabled={disabled} />}
    <div className="settings-key-domain-options">
      {query.isPending ? <p className="muted" role="status">Loading domains…</p> : domains.length === 0 && !query.isError ? <Link className="keys-form-note" to="/domains" onClick={onLeave}>Add a domain</Link> : domains.map(domain => <Checkbox key={domain} label={domain} checked={!every?.checked && chosen.includes(domain)} onCheckedChange={checked => onToggle(domain, checked)} disabled={disabled} />)}
    </div>
    {query.isError && <div className="stack"><MutationError error={query.error} /><Button onClick={() => { void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch()) }}>Retry loading domains</Button></div>}
    {query.hasNextPage && !query.isError && <Button variant="ghost" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more domains</Button>}
    {error && <p id="key-domain-error" className="ui-field__error" role="alert">{error}</p>}
  </fieldset>
}

type FormProps = { open: boolean; onOpenChange: (open: boolean) => void; onPending: (pending: boolean) => void; onCreated: (created: CreatedSecret) => void }

function ApiKeyForm({ open, onOpenChange, onPending, onCreated, initial }: FormProps & { initial?: { purpose?: Purpose; domain?: string } }) {
  const create = useApiMutation((api, input: ApiKeyInput) => api.keys.create(input))
  const addresses = useApiDef(queries.inboundAddressOptions())
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState<Purpose>(initial?.purpose ?? 'send')
  const [allDomains, setAllDomains] = useState(!initial?.domain)
  const [selectedDomains, setSelectedDomains] = useState<string[]>(initial?.domain ? [initial.domain.toLowerCase()] : [])
  const [allAddresses, setAllAddresses] = useState(false)
  const [addressIds, setAddressIds] = useState<string[]>([])
  const [inboxId, setInboxId] = useState('')
  const [reply, setReply] = useState(false)
  const [organize, setOrganize] = useState(true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const workspace = isWorkspace(purpose)
  const pending = create.isPending
  useEffect(() => onPending(pending), [pending, onPending])
  const domainOptions = useDomainOptions(open && workspace)
  const inboxes = useInboxOptions('key-options', {}, open && purpose === 'inbox')
  const domains = domainNames(domainOptions, selectedDomains)
  // Inboxes have their own choice; this list is the receiving addresses.
  const receiving = (addresses.data ?? []).filter(item => item.kind !== 'inbox')
  const chosenInbox = inboxId || activeInboxes(inboxes)[0]?.id || ''
  const nameError = errors.name || fieldError(create.error, 'name')
  const domainError = errors.domains || fieldError(create.error, 'domains')
  const addressError = errors.addressIds || fieldError(create.error, 'access.addressIds')
  const inboxError = errors.inboxId || fieldError(create.error, 'access.inboxId')
  const mailError = fieldError(create.error, 'access.mail')

  const clearError = (field: string) => setErrors(current => { const next = { ...current }; delete next[field]; return next })
  function toggleDomain(domain: string, checked: boolean) {
    clearError('domains')
    setAllDomains(false)
    setSelectedDomains(current => checked ? [...new Set([...current, domain])] : current.filter(item => item !== domain))
  }
  function toggleAddress(id: string, checked: boolean) {
    clearError('addressIds')
    setAllAddresses(false)
    setAddressIds(current => checked ? [...new Set([...current, id])] : current.filter(item => item !== id))
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = 'Enter a name for this key.'
    if (workspace && !allDomains && !selectedDomains.length) next.domains = 'Select at least one domain, or choose All domains.'
    else if (workspace && !allDomains && selectedDomains.length > 50) next.domains = tooManyDomains
    if (purpose === 'addresses' && !allAddresses && !addressIds.length) next.addressIds = chooseAddress
    if (purpose === 'inbox' && !chosenInbox) next.inboxId = 'Choose an inbox.'
    setErrors(next)
    if (Object.keys(next).length) { if (next.name) document.getElementById('key-name')?.focus(); return }
    const mail: MailPermission[] = ['read', ...(reply ? ['send' as const] : []), ...(organize ? ['modify' as const] : [])]
    const input: ApiKeyInput = isWorkspace(purpose) ? { name: name.trim(), permissions: workspacePermissions[purpose], domains: allDomains ? [] : selectedDomains }
      : purpose === 'addresses' ? { name: name.trim(), access: { type: 'addresses', ...(allAddresses ? {} : { addressIds }), mail } }
      : purpose === 'inbox' ? { name: name.trim(), access: { type: 'inbox', inboxId: chosenInbox, mail: mail.filter(p => p !== 'create') as Exclude<MailPermission, 'create'>[] } }
      : { name: name.trim(), access: { type: 'addresses', addressIds: [], mail: ['create', 'read', 'modify'] } }
    try {
      const result = await create.mutateAsync(input)
      onOpenChange(false)
      onCreated({ secret: result.secret, title: 'API key created', sendExample: workspace, agent: true })
    } catch { /* Shown in the form. */ }
  }

  // A sending domain covers its subdomains (SENDER_DOMAIN_FORBIDDEN names "this domain or its parent domain").
  const example = selectedDomains[0] ?? domains[0]
  const placeholder = workspace ? 'Order notifications' : purpose === 'create' ? 'End-to-end tests' : purpose === 'inbox' ? 'Sign-up test' : 'Support agent'
  const where = purpose === 'inbox' ? 'this inbox' : 'these addresses'
  // What the choices above add up to, in plain lines: the detail behind "What this key can do".
  const can = [
    purposes.find(item => item.value === purpose)!.does,
    ...workspace && !allDomains ? [`Sends and email logs are limited to the chosen domains and their subdomains${example ? `: ${example} also covers mail from news.${example}` : ''}.`, 'It can’t launch campaigns or reach contacts, lists, settings, webhooks or received mail.', ...purpose === 'manage' ? ['Limited to domains, it can’t manage keys or receiving.'] : []] : [],
    ...purpose === 'addresses' || purpose === 'inbox' ? ['Lists and reads mail, events and attachments.', ...reply ? [`Replies and starts conversations, from ${where} only.${purpose === 'inbox' ? ' Needs replies on for the inbox.' : ''}`] : [], ...organize ? [`Marks read, archives, stars and labels${purpose === 'inbox' ? ', and can delete the inbox' : allAddresses ? ', and can delete agent inboxes' : ''}.`] : []] : [],
  ]

  return <>
    <form id="create-key" className="stack" onSubmit={submit} noValidate>
      <MutationError error={create.error} />
      <Field label="Name" htmlFor="key-name" error={nameError}><Input id="key-name" value={name} maxLength={100} onChange={event => setName(event.target.value)} autoFocus required disabled={pending} placeholder={placeholder} /></Field>
      <fieldset className="keys-purpose" disabled={pending}>
        <legend className="ui-field__label">What it can reach</legend>
        {purposes.map(item => <label key={item.value} className="keys-choice">
          <input type="radio" name="key-purpose" value={item.value} checked={purpose === item.value} onChange={() => { setPurpose(item.value); setErrors({}); create.reset() }} />
          <span>{item.label}</span>
        </label>)}
      </fieldset>
      {workspace && <DomainChoice query={domainOptions} chosen={selectedDomains} onToggle={toggleDomain} disabled={pending} error={domainError} onLeave={() => onOpenChange(false)}
        every={{ checked: allDomains, onChange: checked => { setAllDomains(checked); setSelectedDomains([]); clearError('domains') } }} />}
      {purpose === 'addresses' && <AddressChoice id="key-address" options={receiving} every={allAddresses} chosen={addressIds} disabled={pending} error={addressError}
        onEvery={checked => { setAllAddresses(checked); setAddressIds([]); clearError('addressIds') }} onToggle={toggleAddress}
        empty={addresses.isPending ? <p className="muted" role="status">Loading addresses…</p> : !receiving.length ? <Link className="keys-form-note" to="/receiving" onClick={() => onOpenChange(false)}>Create an address</Link> : undefined} />}
      {purpose === 'inbox' && <InboxChoice name="key-inbox" query={inboxes} value={chosenInbox} onChange={id => { setInboxId(id); clearError('inboxId') }} disabled={pending} error={inboxError}
        none={<Link to="/receiving/inboxes" onClick={() => onOpenChange(false)}>Create an agent inbox</Link>} />}
      {(purpose === 'addresses' || purpose === 'inbox') && <fieldset className="keys-purpose" disabled={pending}>
        <legend className="ui-field__label">What it can do</legend>
        {[{ value: false, label: 'Read' }, { value: true, label: 'Read and reply' }].map(item => <label key={item.label} className="keys-choice">
          <input type="radio" name="key-mail" checked={reply === item.value} onChange={() => setReply(item.value)} />
          <span>{item.label}</span>
        </label>)}
        <Checkbox checked={organize} onCheckedChange={setOrganize} disabled={pending} label="Organize mail" />
        {mailError && <p className="ui-field__error" role="alert">{mailError}</p>}
      </fieldset>}
      <Disclosure className="keys-can" title="What this key can do"><ul>{can.map(line => <li key={line}>{line}</li>)}</ul></Disclosure>
    </form>
  </>
}

function AppPasswordForm({ open, onOpenChange, onPending, onCreated }: FormProps) {
  const create = useApiMutation((api, input: AppPasswordInput) => api.credentials.createAppPassword(input))
  const inboxes = useInboxOptions('app-password-options', { type: 'persistent' }, open)
  const [inboxId, setInboxId] = useState('')
  const [name, setName] = useState('')
  const [protocols, setProtocols] = useState<AppPasswordProtocol[]>(['imap', 'smtp'])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const pending = create.isPending
  useEffect(() => onPending(pending), [pending, onPending])
  const chosen = inboxId || activeInboxes(inboxes)[0]?.id || ''
  const toggle = (protocol: AppPasswordProtocol, checked: boolean) => { setErrors(current => ({ ...current, protocols: '' })); setProtocols(current => checked ? [...new Set([...current, protocol])] : current.filter(item => item !== protocol)) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const next: Record<string, string> = {}
    if (!chosen) next.inboxId = 'Choose a persistent inbox.'
    if (!name.trim()) next.name = 'Enter a name, such as the mail app it’s for.'
    if (!protocols.length) next.protocols = 'Choose IMAP, SMTP or both.'
    setErrors(next)
    if (Object.values(next).some(Boolean)) { if (next.name && !next.inboxId) document.getElementById('app-password-name')?.focus(); return }
    try {
      const result = await create.mutateAsync({ inboxId: chosen, name: name.trim(), protocols })
      onOpenChange(false)
      const inbox = activeInboxes(inboxes).find(box => box.id === chosen)
      onCreated({ secret: result.password, title: 'App password created', description: 'Shown once: copy it now and use it as your mail app’s password.',
        mail: { username: inbox ? <PrivateAddress value={inbox.address} /> : 'The inbox address', imap: protocols.includes('imap'), smtp: protocols.includes('smtp') } })
    } catch { /* Shown in the form. */ }
  }
  const protocolError = errors.protocols || fieldError(create.error, 'protocols')
  return <>
    <form id="create-app-password" className="stack" onSubmit={submit} noValidate>
      <MutationError error={create.error} />
      {/* A mail app opens only an inbox that keeps its mail; those are made over the API, so its place links the guide. */}
      <InboxChoice name="app-password-inbox" query={inboxes} value={chosen} onChange={setInboxId} disabled={pending} error={errors.inboxId}
        none={<Link to="/docs/inboxes" onClick={() => onOpenChange(false)}>Create a persistent inbox</Link>} />
      <Field label="Name" htmlFor="app-password-name" error={errors.name || fieldError(create.error, 'name')}><Input id="app-password-name" value={name} maxLength={100} onChange={event => setName(event.target.value)} autoFocus required disabled={pending} placeholder="Apple Mail" autoComplete="off" /></Field>
      <fieldset className="keys-purpose" disabled={pending}>
        <legend className="ui-field__label">What the mail app can do</legend>
        <Checkbox checked={protocols.includes('imap')} onCheckedChange={checked => toggle('imap', checked)} disabled={pending} label="Read and file its mail (IMAP)" />
        <Checkbox checked={protocols.includes('smtp')} onCheckedChange={checked => toggle('smtp', checked)} disabled={pending} label="Send from its address (SMTP)" />
        {protocolError && <p className="ui-field__error" role="alert">{protocolError}</p>}
      </fieldset>
    </form>
  </>
}

/** An SMTP login: an API key that can only send, from chosen domains or receiving addresses. An app signs in to SMTP
 *  as apikey with it; its mail goes out like an API send. */
function SmtpLoginForm({ open, onOpenChange, onPending, onCreated }: FormProps) {
  const create = useApiMutation((api, input: ApiKeyInput) => api.keys.create(input))
  const domainOptions = useDomainOptions(open)
  const addresses = useApiDef(queries.inboundAddressOptions())
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'domains' | 'addresses'>('domains')
  const [domains, setDomains] = useState<string[]>([])
  const [allAddresses, setAllAddresses] = useState(false)
  const [addressIds, setAddressIds] = useState<string[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const pending = create.isPending
  useEffect(() => onPending(pending), [pending, onPending])
  const receiving = (addresses.data ?? []).filter(item => item.kind !== 'inbox')
  const clearError = (field: string) => setErrors(current => { const next = { ...current }; delete next[field]; return next })
  const servers = useMailServers()
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!servers) return
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = 'Enter a name, such as the app it’s for.'
    if (scope === 'domains' && !domains.length) next.domains = 'Select at least one domain.'
    else if (scope === 'domains' && domains.length > 50) next.domains = tooManyDomains
    if (scope === 'addresses' && !allAddresses && !addressIds.length) next.addressIds = chooseAddress
    setErrors(next)
    if (Object.keys(next).length) { if (next.name) document.getElementById('smtp-login-name')?.focus(); return }
    const input: ApiKeyInput = scope === 'domains' ? { name: name.trim(), permissions: ['send'], domains }
      : { name: name.trim(), access: { type: 'addresses', ...(allAddresses ? {} : { addressIds }), mail: ['send'] } }
    try {
      const result = await create.mutateAsync(input)
      onOpenChange(false)
      onCreated({ secret: result.secret, title: 'SMTP login created', description: 'Shown once: copy it now and use it as the app’s SMTP password.', mail: { username: <code>apikey</code>, imap: false, smtp: true } })
    } catch { /* Shown in the form. */ }
  }
  return <form id="create-smtp-login" className="stack" onSubmit={submit} noValidate>
    <MutationError error={create.error} />
    <Field label="Name" htmlFor="smtp-login-name" error={errors.name || fieldError(create.error, 'name')}><Input id="smtp-login-name" value={name} maxLength={100} onChange={event => setName(event.target.value)} autoFocus required disabled={pending} placeholder="Sign-in emails" autoComplete="off" /></Field>
    <fieldset className="keys-purpose" disabled={pending}>
      <legend className="ui-field__label">Sends from</legend>
      {([['domains', 'Chosen domains'], ['addresses', 'Chosen addresses']] as const).map(([value, label]) => <label key={value} className="keys-choice">
        <input type="radio" name="smtp-login-scope" value={value} checked={scope === value} onChange={() => { setScope(value); setErrors({}); create.reset() }} />
        <span>{label}</span>
      </label>)}
    </fieldset>
    {scope === 'domains' ? <DomainChoice query={domainOptions} chosen={domains} disabled={pending} error={errors.domains || fieldError(create.error, 'domains')} onLeave={() => onOpenChange(false)}
      onToggle={(domain, checked) => { clearError('domains'); setDomains(current => checked ? [...new Set([...current, domain])] : current.filter(item => item !== domain)) }} />
      : <AddressChoice id="smtp-login-address" options={receiving} every={allAddresses} chosen={addressIds} disabled={pending} error={errors.addressIds || fieldError(create.error, 'access.addressIds')}
        onEvery={checked => { setAllAddresses(checked); setAddressIds([]); clearError('addressIds') }}
        onToggle={(id, checked) => { clearError('addressIds'); setAllAddresses(false); setAddressIds(current => checked ? [...new Set([...current, id])] : current.filter(item => item !== id)) }}
        empty={addresses.isPending ? <p className="muted" role="status">Loading addresses…</p> : !receiving.length ? <Link className="keys-form-note" to="/receiving" onClick={() => onOpenChange(false)}>Create an address</Link> : undefined} />}
    <Disclosure className="keys-can" title="What this login can do"><ul>
      <li>Sends from an app over SMTP, as {scope === 'domains' ? 'any address on these domains and their subdomains' : 'these addresses'}.</li>
      <li>Mail goes out like an API send: the same limits, suppressions and events.</li>
      <li>Can’t read mail, logs or settings.</li>
    </ul></Disclosure>
  </form>
}
