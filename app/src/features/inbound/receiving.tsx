// Receiving: Addresses, Rules and Destinations (the API's routes, rules and endpoints), in the order mail meets them:
// received, processed, delivered. One read (getInboundOverview) per screen.
import { useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Check, X } from 'lucide-react'
import { Button, ConfirmDialog, DataTable, DropdownMenu, EmptyState, ErrorState, FacetRail, IconButton, LoadingRegion, PageHeader, Pagination, SearchField, Select, SplitPane, StatusBadge, Tabs, useToast } from '../../components/ui'
import { useApiDef, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { request } from '../../data/live'
import { errorText } from '../../data/types'
import { number } from '../../lib/format'
import { useCursorPagination, useSearchDraft } from '../../lib/pagination'
import { CreateAddressDialog } from './addresses'
import { concepts, kindNote, kinds, type KindFilter } from './concepts'
import { NewInboxDialog } from './inboxes'
import { ConnectAgentButton } from '../docs/connect-agent'
import { ago, expiresIn, receivingDomains, typeLabel, useEndpointPage, useOverview, type Overview, type OverviewEndpoint, type RouteEntry } from './overview'
import { Chain, Match, RouteIcon, TargetIcon, Targets, targetName } from './parts'
import { RulesTab } from './recipes'
import { CreatedEndpointDialog, EndpointDialog, endpointStatusLabel, endpointStatusTone, type EditableEndpoint, type Endpoint } from './ritual-connections'
import { RouteEditor } from './routing'
import { actorText, useLiveVersion } from './live'
import '../settings/settings.css'
import './inbound.css'
import './receiving.css'
import { AddressList, PrivateAddress } from '../../components/PrivateAddress'
import { isMailbox } from '../../lib/private-address'
import { resourceOf } from '../../data/invalidation'

type Tab = 'addresses' | 'rules' | 'destinations'
// Links from before the rename keep working: tab=routes, tab=endpoints and tab=rituals land on today's tab.
const legacyTab: Record<string, Tab> = { routes: 'addresses', endpoints: 'destinations', rituals: 'rules' }
const PAGE = 50
const kindQuery: Record<KindFilter, { kind?: string; origin?: 'api' | 'auto' }> = {
  all: {}, address: { kind: 'address,route', origin: 'api' }, pattern: { kind: 'pattern' }, catch_all: { kind: 'catch_all' }, inbox: { kind: 'inbox' }, auto: { kind: 'address', origin: 'auto' },
}
const kindCount = (counts: Overview['counts'], kind: KindFilter) => kind === 'all' ? counts.address + counts.auto + counts.route + counts.pattern + counts.catch_all + counts.inbox
  : kind === 'address' ? counts.address + counts.route : counts[kind]

// Under each route's address: what it is, in a few words.
function note(r: RouteEntry) {
  const a = r.address
  if (r.kind === 'catch_all') return r.catchAll ? (r.catchAll === 'create_address' ? 'Catch-all · creates an address per recipient' : 'Catch-all · unknown addresses') : 'Catch-all route'
  if (r.kind === 'route') return kindNote.route
  if (r.kind === 'pattern') return a ? <>Wildcard for <PrivateAddress value={a.address} /></> : kindNote.pattern
  if (r.kind === 'inbox') return [kindNote.inbox, a?.displayName, expiresIn(a?.expiresAt)].filter(Boolean).join(' · ')
  if (a?.origin === 'auto') return kindNote.auto
  const also = a?.aliases.length ? <>also <AddressList values={a.aliases.map(x => x.slice(0, x.indexOf('@') + 1))} /></> : null
  const parts = [a?.displayName, a?.expiresAt ? expiresIn(a.expiresAt) : null, also].filter(Boolean)
  return parts.length ? parts.map((part, i) => <span key={i}>{i > 0 && ' · '}{part}</span>) : 'Address'
}
// The same line as text for a tooltip, when the cell clips it. An address never goes in: it stays masked until revealed.
const noteTitle = (r: RouteEntry) => r.kind === 'catch_all' || r.kind === 'route' || r.address?.origin === 'auto' ? undefined
  : [r.kind === 'inbox' ? kindNote.inbox : null, r.address?.displayName, expiresIn(r.address?.expiresAt)].filter(Boolean).join(' · ') || undefined
const targetsTitle = (r: RouteEntry) => r.to.map(t => isMailbox(t.name) ? typeLabel[t.type] : targetName(t, r.address?.id)).join(', ')
// Where a row leads: its address or its agent inbox (real links). Every other route, including a domain's default
// catch-all, opens its own route editor here, never the domain's page (Back from there led to Domains, not Receiving).
const hrefOf = (r: RouteEntry) => r.kind === 'inbox' && r.address ? `/receiving/inboxes/${r.address.id}` : r.address ? `/receiving/addresses/${r.address.id}` : null

/** A new account: the three steps everything else builds on, each with the one action that starts it. */
function GettingStarted({ overview, onCreate }: { overview: Overview; onCreate: () => void }) {
  const live = overview.domains.filter(d => d.status === 'active'), sendOnly = overview.domains.filter(d => ['off', 'disabled'].includes(d.status))
  const step = (n: number, done: boolean, title: string, action: ReactNode) => <li className="rcv-step" data-done={done || undefined}>
    <span className="rcv-step__n" aria-hidden="true">{done ? <Check size={13} /> : n}</span><div className="rcv-step__body"><h3>{title}</h3>{action}</div></li>
  // Each step is its heading and the action that starts it; the second waits on the first (its button is off until a
  // domain receives). An agent inbox needs no DNS, so testing can start before any of it.
  return <ol className="rcv-steps">
    {step(1, live.length > 0, 'Receive on a domain', !live.length && <Link className="ui-button ui-button--secondary ui-button--md" to={sendOnly[0] ? `/domains/${sendOnly[0].id}` : '/domains'}>Set up receiving</Link>)}
    {step(2, false, 'Create an address', <Button disabled={!live.length} onClick={onCreate}>New address</Button>)}
    {step(3, false, 'Choose where mail goes', <div className="cluster"><Link className="ui-button ui-button--ghost ui-button--md" to="/receiving/rules/new">New rule</Link><Link className="ui-button ui-button--ghost ui-button--md" to="/receiving?tab=destinations">New destination</Link></div>)}
    <li className="rcv-steps__aside"><Link className="ui-button ui-button--ghost ui-button--md" to="/receiving/inboxes">Try an agent inbox</Link></li>
  </ol>
}

function RoutesTab({ overview, fetching, filters, setFilter, page, onPage, onCreate, onEditRoute }: { overview: Overview; fetching: boolean; filters: { kind: KindFilter; domain: string; q: string }; setFilter: (patch: Partial<{ kind: KindFilter; domain: string; q: string }>) => void; page: number; onPage: (next: number) => void; onCreate: () => void; onEditRoute: (r: RouteEntry) => void }) {
  const { canAdminister } = useWorkspaceAccess()
  const [newInbox, setNewInbox] = useState(false)
  const [draft, type] = useSearchDraft(filters.q, value => setFilter({ q: value }))
  const hosts = receivingDomains(overview.domains)
  const total = kindCount(overview.counts, 'all')
  if (!overview.manage && !total && !filters.q) return <EmptyState title="No addresses to show" />
  if (overview.manage && !hosts.length && !total) return <GettingStarted overview={overview} onCreate={onCreate} />
  const rows = overview.routes.data
  const empty = filters.q ? 'Nothing matches' : filters.kind === 'all' ? 'No addresses yet' : `No ${kinds[filters.kind].label.toLowerCase()} yet`
  const open = (r: RouteEntry) => { if (!hrefOf(r)) onEditRoute(r) }
  // The kinds are the rail's facets, each with its count; below 1200 px they are a row over the table.
  const kindFacets = (Object.keys(kinds) as KindFilter[]).filter(k => overview.manage || ['all', 'address', 'inbox', 'auto'].includes(k))
    .map(k => ({ key: k, label: kinds[k].label, count: kindCount(overview.counts, k), selected: filters.kind === k, onSelect: () => setFilter({ kind: k }) }))
  return <div className="stack rcv-tab"><SplitPane className="rcv-split" collapse="row" rail={<FacetRail label="Show" groups={[{ key: 'kind', title: 'Kind', items: kindFacets }]} />}>
    <div className="rcv-toolbar">
      <div className="rcv-toolbar__end">
        {hosts.length > 1 && <Select className="rcv-domain" aria-label="Domain" value={filters.domain || 'all'} onValueChange={v => setFilter({ domain: v === 'all' ? '' : v })} options={[{ value: 'all', label: 'All domains' }, ...hosts.map(d => ({ value: d.name, label: d.name }))]} />}
        <SearchField className="search-box--list" aria-label="Search addresses" placeholder="Search address or name" value={draft} onChange={e => type(e.target.value)} />
        {/* New address is the page's own action; agent inboxes add theirs while they are the filter. */}
        {canAdminister && filters.kind === 'inbox' && <div className="cluster"><ConnectAgentButton /><Button onClick={() => setNewInbox(true)}>New agent inbox</Button></div>}
      </div>
    </div>
    <DataTable className="rcv-table" rows={rows} rowKey={r => r.id} rowHref={hrefOf} onRowClick={open} loading={false} minRows={Math.min(8, rows.length)}
      empty={<EmptyState title={empty} action={!filters.q && filters.kind === 'address' && canAdminister ? <Button onClick={onCreate}>New address</Button> : undefined} />}
      columns={[
        // One line per address: what it receives, the rules that process it, where it is delivered, its last mail. A
        // card: the address (its link) and its unread count or last mail, what it is, then where its mail goes.
        { key: 'match', label: 'Address', width: '33%', render: r => <div className="rcv-cell"><RouteIcon entry={r} /><div className="settings-cell-stack"><Match value={r.match} host={!filters.domain} /><span className="muted receiving-clip" title={noteTitle(r)}>{note(r)}</span></div></div>,
          cardRender: r => <span className="rcv-cell"><RouteIcon entry={r} /><Match value={r.match} host={!filters.domain} /></span> },
        { key: 'note', label: 'Kind', table: false, card: 'line', render: r => note(r) },
        { key: 'rules', label: 'Rules', width: '17%', card: 'hide', render: r => <Chain keys={r.rules} max={1} empty={overview.manage && r.address && r.kind !== 'pattern'
          ? <Link className="rcv-add" to={`/receiving/addresses/${r.address.id}?tab=flow`} onClick={e => e.stopPropagation()}>No rule · add</Link> : <span className="muted">—</span>} /> },
        { key: 'to', label: 'Delivers to', width: '32%', card: 'line', render: r => <span className="rcv-to" title={targetsTitle(r)}><Targets to={r.to} total={r.toTotal} ownId={r.address?.id} max={2} /></span>, cardRender: r => <span className="rcv-card-to">{r.rules.length > 0 && <><code className="rcv-card-to__ritual">{r.rules[0]}</code>{r.rules.length > 1 && <span className="muted">+{r.rules.length - 1}</span>}<span aria-hidden="true">→</span></>}<Targets to={r.to} total={r.toTotal} ownId={r.address?.id} max={2} /></span> },
        { key: 'unread', label: 'Unread', align: 'right', width: '8%', card: 'hide', render: r => r.address && r.kind !== 'pattern' ? (r.address.stats.unreadThreads ? <strong>{number(r.address.stats.unreadThreads)}</strong> : <span className="muted">0</span>) : <span className="muted">—</span> },
        { key: 'last', label: 'Last mail', align: 'right', card: 'aside', render: r => r.address?.stats.lastMessageAt && r.kind !== 'pattern' ? ago(r.address.stats.lastMessageAt) : <span className="muted">—</span>,
          cardRender: r => r.address && r.kind !== 'pattern' ? <>{r.address.stats.unreadThreads > 0 && <strong className="rcv-unread">{number(r.address.stats.unreadThreads)} new</strong>}{r.address.stats.lastMessageAt ? ago(r.address.stats.lastMessageAt) : null}</> : null },
      ]} />
    <div className="rcv-foot" data-busy={fetching || undefined}>
      <span className="muted">{number(kindCount(overview.counts, filters.kind))} {kindCount(overview.counts, filters.kind) === 1 ? 'address' : 'addresses'}{filters.domain ? ` at ${filters.domain}` : ''}</span>
      <Pagination page={page} pageSize={PAGE} total={kindCount(overview.counts, filters.kind)} nextCursor={overview.routes.nextCursor} onPageChange={onPage} />
    </div>
  </SplitPane>
    <NewInboxDialog open={newInbox} onOpenChange={setNewInbox} />
  </div>
}

const ENDPOINT_PAGE = 50
/** Destinations (the API's endpoints): where processed mail is delivered. Webhooks, Slack, Discord and forwards. */
function DestinationsTab({ overview, refresh }: { overview: Overview; refresh: () => void }) {
  const toast = useToast(), navigate = useNavigate(), client = useQueryClient()
  // Every endpoint, a page at a time; ?address= keeps the webhooks that get that address's received mail (an address's "more webhooks" link).
  const [params, setParams] = useSearchParams(), address = params.get('address') ?? undefined
  const pagination = useCursorPagination()
  // With nothing to list the overview already says so, and the empty state shows at once.
  const none = !address && !overview.endpoints.length && !overview.endpointsTruncated
  const list = useEndpointPage({ addressId: address, cursor: pagination.cursor, limit: ENDPOINT_PAGE }, !none)
  const addresses = useApiDef(queries.inboundAddressOptions(), { enabled: !!address })
  const reload = () => { refresh(); void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && resourceOf(query.queryKey) === 'inbound-endpoints' }) }
  const showAll = () => { setParams(previous => { const next = new URLSearchParams(previous); next.delete('address'); return next }, { replace: true }); pagination.reset() }
  // The first page holds as many rows as the overview counted, so the list keeps its height while it loads.
  const expected = address ? 2 : Math.max(1, Math.min(ENDPOINT_PAGE, overview.endpoints.length))
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<(Endpoint & { secret?: string }) | null>(null)
  // Kept after closing, so the dialog's title and fields don't change while it animates out.
  const [editing, setEditing] = useState<EditableEndpoint | null>(null), [editOpen, setEditOpen] = useState(false)
  const [deleting, setDeleting] = useState<OverviewEndpoint | null>(null), [deleteOpen, setDeleteOpen] = useState(false)
  async function act(e: OverviewEndpoint, path: string, method: string, body: unknown, done: string) {
    try {
      const result = await request<{ ok?: boolean; error?: string | null }>(`/v1/endpoints/${encodeURIComponent(e.name)}${path}`, { method, ...(body === undefined ? {} : { body }) })
      toast(result.ok === false ? `${e.name} answered ${result.error ?? 'an error'}.` : done, result.ok === false ? 'error' : 'success')
      reload()
    } catch (error) { toast(errorText(error), 'error') }
  }
  // A webhook opens its own page (events, deliveries, headers, secret), named or not.
  const webhookPage = (e: OverviewEndpoint) => e.type === 'webhook' ? `/receiving/webhooks/${e.id}` : null
  const used = (e: OverviewEndpoint) => [e.routes ? `${number(e.routes)} ${e.routes === 1 ? 'address' : 'addresses'}` : null, e.rules.length ? `rule ${e.rules.join(', ')}` : null, e.eventTypes.length ? `${e.eventTypes.length === 1 ? e.eventTypes[0] : `${e.eventTypes.length} events`}` : null].filter(Boolean).join(' · ')
  return <div className="stack rcv-tab">
    <div className="rcv-kindline">
      {address && <span className="rcv-filter-chip">{(a => a ? <PrivateAddress value={a} /> : 'One address')(addresses.data?.find(item => item.id === address)?.address)}<IconButton size="sm" label="Show every destination" onClick={showAll}><X size={14} aria-hidden="true" /></IconButton></span>}
      <div className="cluster"><Button size="sm" onClick={() => setCreating(true)}>New destination</Button></div>
    </div>
    {list.error && !list.data ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : <DataTable className="rcv-table" rows={none ? [] : list.data?.data ?? []} rowKey={e => e.id} rowHref={webhookPage}
      loading={!none && !list.data} skeletonRows={expected} minRows={none ? 0 : Math.min(expected, list.data?.data.length ?? expected)}
      empty={address ? <EmptyState title="No webhook gets this address’s mail" /> : <EmptyState title="No destinations yet" action={<Button onClick={() => setCreating(true)}>New destination</Button>} />}
      columns={[
        { key: 'name', label: 'Destination', width: '30%', render: e => <div className="rcv-cell"><TargetIcon type={e.type} /><div className="settings-cell-stack"><span className="receiving-clip" title={e.call ?? e.name}>{e.call ? <code>{e.call}</code> : e.name}</span><span className="muted receiving-clip"><PrivateAddress value={e.target} /></span></div></div>,
          cardRender: e => <span className="rcv-cell"><TargetIcon type={e.type} />{e.call ? <code>{e.call}</code> : e.name}</span> },
        { key: 'target', label: 'Target', table: false, card: 'line', render: e => <PrivateAddress value={e.target} /> },
        { key: 'type', label: 'Type', width: '14%', card: 'hide', render: e => ({ webhook: 'Webhook', slack: 'Slack', discord: 'Discord', forward: 'Forward' }[e.type]) },
        { key: 'used', label: 'Used by', width: '30%', card: 'line', render: e => used(e) || <span className="muted">Nothing yet</span> },
        { key: 'status', label: 'Status', width: '16%', card: 'aside', render: e => <StatusBadge status={endpointStatusLabel[e.status]} tone={endpointStatusTone[e.status]} /> },
        { key: 'actions', label: '', width: 52, align: 'right', render: e => e.source === 'inbound_webhook' ? <DropdownMenu label={`Actions for ${e.name}`} items={[{ label: 'Open', onSelect: () => navigate(webhookPage(e)!) }]} /> : <DropdownMenu label={`Actions for ${e.name}`} items={[
          ...(e.type === 'webhook' ? [{ label: 'Open', onSelect: () => navigate(webhookPage(e)!) }] : []),
          { label: 'Edit', onSelect: () => { setEditing(e); setEditOpen(true) } },
          ...(e.type !== 'forward' ? [{ label: 'Send a test message', onSelect: () => void act(e, '/test', 'POST', undefined, `Test posted to ${e.call}.`) }] : []),
          ...(e.type === 'forward' && e.status !== 'ready' ? [{ label: 'Resend confirmation', onSelect: () => void act(e, '/verification', 'POST', {}, 'Confirmation email queued.') }] : []),
          { label: e.status === 'paused' ? 'Resume' : 'Pause', onSelect: () => void act(e, '', 'PATCH', { paused: e.status !== 'paused' }, e.status === 'paused' ? 'Resumed.' : 'Paused. Calls wait until you resume.') },
          { label: 'Delete', destructive: true, onSelect: () => { setDeleting(e); setDeleteOpen(true) } },
        ]} /> },
      ]} />}
    {list.data && <Pagination page={pagination.page} pageSize={ENDPOINT_PAGE} nextCursor={list.data.nextCursor} count={list.data.data.length} onPageChange={next => pagination.onPageChange(next, list.data?.nextCursor)} />}
    <EndpointDialog open={creating} onOpenChange={setCreating} onCreated={e => { setCreating(false); setCreated(e); reload() }} />
    <EndpointDialog open={editOpen} editing={editing} onOpenChange={setEditOpen} onSaved={e => { setEditOpen(false); toast(`Saved ${e.name}.`, 'success'); reload() }} />
    <CreatedEndpointDialog created={created} onClose={() => setCreated(null)} />
    <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} danger title={`Delete ${deleting?.name ?? 'this destination'}?`} description="Rules and addresses that send to it stop delivering. This can’t be undone." confirmLabel="Delete destination"
      onConfirm={() => deleting ? act(deleting, '', 'DELETE', undefined, `${deleting.name} deleted.`) : undefined} />
  </div>
}

export function ReceivingPage() {
  const [params, setParams] = useSearchParams()
  const { canAdminister } = useWorkspaceAccess()
  // A link from before a rename shows today's tab at once, and the address bar then says its name.
  const asked = params.get('tab') ?? '', legacy = legacyTab[asked]
  const tab: Tab = legacy ?? (asked === 'rules' || asked === 'destinations' ? asked : 'addresses')
  useEffect(() => { if (legacy) setParams(previous => { const next = new URLSearchParams(previous); if (legacy === 'addresses') next.delete('tab'); else next.set('tab', legacy); return next }, { replace: true }) }, [legacy, setParams])
  const kind = (params.get('kind') ?? 'all') as KindFilter
  const filters = { kind: kind in kinds ? kind : 'all' as KindFilter, domain: params.get('domain') ?? '', q: params.get('q') ?? '' }
  const pagination = useCursorPagination()
  const overview = useOverview({ ...kindQuery[filters.kind], domain: filters.domain || undefined, q: filters.q.trim() || undefined, cursor: pagination.cursor, limit: PAGE }, true)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<RouteEntry | null>(null)
  function update(patch: Record<string, string | null | undefined>) {
    // From the latest URL: a debounced search write must not undo a filter picked while it waited.
    setParams(previous => {
      const next = new URLSearchParams(previous)
      for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined || v === '' || (k === 'kind' && v === 'all') || (k === 'tab' && v === 'addresses')) next.delete(k); else next.set(k, v) }
      return next
    }, { replace: true })
    pagination.reset()
  }
  const data = overview.data
  const manage = data?.manage ?? canAdminister
  // Live: a route, rule or endpoint saved elsewhere (an agent over MCP, an API key, another tab) refreshes the lists
  // in place and says who saved it. This person's own saves refresh through their mutations and say nothing here.
  const client = useQueryClient(), toast = useToast()
  useLiveVersion(manage && !!data, change => {
    if (change.first) return
    void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && ['inbound-overview', 'inbound-endpoints'].includes(resourceOf(query.queryKey)) })
    if (change.actor?.self && change.actor.type === 'member') return
    toast(`${change.versionMoved ? 'Addresses and rules' : 'Destinations'} updated by ${actorText(change.actor)}${change.versionMoved ? ` · version ${change.version}` : ''}`, 'info')
  }, { endpoints: true })
  const counts = data && { addresses: kindCount(data.counts, 'all'), rules: data.rules.length, destinations: data.endpoints.length }
  return <div className="stack inbound-stack">
    {/* The page's one action. An address's mail is on its own page; every address's mail is in Logs. */}
    <PageHeader title="Receiving" actions={manage && <Button variant="primary" disabled={!data || !receivingDomains(data.domains).length} onClick={() => setCreating(true)}>New address</Button>} />
    {overview.error && !data ? <ErrorState error={overview.error} onRetry={() => void overview.refetch()} /> : !data || !counts ? <LoadingRegion label="Loading receiving"><div className="rcv-skeleton" aria-hidden="true"><span /><span /><span /><span /></div></LoadingRegion> : <div className="rcv-page">
      <Tabs label="Receiving" value={tab} onValueChange={value => update({ tab: value, kind: null, address: null })}
        items={[{ value: 'addresses', label: concepts.addresses.title, count: counts.addresses }, ...(data.manage ? [{ value: 'rules', label: concepts.rules.title, count: counts.rules }, { value: 'destinations', label: concepts.destinations.title, count: counts.destinations }] : [])]} />
      {tab === 'rules' && data.manage ? <RulesTab overview={data} refresh={() => overview.refetch()} />
        : tab === 'destinations' && data.manage ? <DestinationsTab overview={data} refresh={() => void overview.refetch()} />
        : <RoutesTab overview={data} fetching={overview.isFetching} filters={filters} onCreate={() => setCreating(true)} onEditRoute={setEditing}
          page={pagination.page} onPage={next => pagination.onPageChange(next, data.routes.nextCursor)} setFilter={patch => update(patch)} />}
    </div>}
    {data && <CreateAddressDialog open={creating} onOpenChange={setCreating} domains={data.domains} />}
    {editing && <RouteEditor match={editing.match} route={editing.route} onClose={() => { setEditing(null); void overview.refetch() }} />}
  </div>
}
