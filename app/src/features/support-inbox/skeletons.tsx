import type { ReactNode } from 'react'
import { Keyboard, MoreHorizontal } from 'lucide-react'
import { useLocation } from 'react-router'
import { Button, FacetRail, IconButton, LoadingRegion, PageHeader, SearchField, Select, Skeleton, SkeletonText, SplitPane, TableSkeleton, Tabs, type FacetGroup, type SkeletonColumn, type Tone } from '../../components/ui'
import type { Channel, InboxCounts, InboxView, SupportConversation } from '../../data/support-inbox'
import { ActionsTrigger } from '../operator/skeletons'
import './support-inbox.css'

// The support inbox's column definitions (card slots included), shared by the route skeleton and the loaded list. A
// phone's card: the customer and last activity, the conversation (its subject, then the last message itself), then its
// status and priority on one line.
export const inboxColumnDefs: SkeletonColumn[] = [
  { key: 'customer', label: 'Customer', width: 'var(--sinbox-customer, 18%)', card: 'title' },
  { key: 'subject', label: 'Conversation', card: 'line' },
  { key: 'preview', label: 'Last message', card: 'line', table: false },
  { key: 'status', label: 'Status', width: 'var(--sinbox-status, 168px)', card: 'line' },
  { key: 'priority', label: 'Priority', width: 'var(--sinbox-priority, 80px)', card: 'inline' },
  { key: 'activity', label: 'Last', width: 64, align: 'right', card: 'aside' },
  { key: 'actions', label: '', width: 40, align: 'right', card: 'end' },
]
export const inboxViews: { value: InboxView; label: string; count?: keyof InboxCounts }[] = [{ value: 'needs_you', label: 'Needs you', count: 'needsYou' }, { value: 'agent', label: 'AI handling', count: 'agent' },
  { value: 'waiting', label: 'Waiting on customer', count: 'waiting' }, { value: 'done', label: 'Done' }, { value: 'all', label: 'All' }]
export const viewOf = (search: string): InboxView => { const view = new URLSearchParams(search).get('view'); return inboxViews.some(item => item.value === view && view !== 'needs_you') ? view as InboxView : 'needs_you' }
export const channelOf = (search: string): Channel | '' => { const channel = new URLSearchParams(search).get('channel'); return channel === 'chat' || channel === 'email' ? channel : '' }

// Where a conversation stands. Needing you, the most pressing reason first: a failed send, blocked work, a customer
// waiting, a ticket. Otherwise: the agent handling it, waiting on the customer, done or closed.
export type Triage = { key: 'failed' | 'blocked' | 'waiting' | 'ticket' | 'paused' | 'agent' | 'customer' | 'done' | 'closed'; text: string; tone: Tone }
export function triageOf(c: SupportConversation): Triage {
  const reasons = c.needsYou?.reasons
  if (!reasons) {
    if (c.done) return { key: 'done', text: 'Done', tone: 'neutral' }
    if (c.status === 'closed') return { key: 'closed', text: 'Closed', tone: 'neutral' }
    if ((c.lastAuthor === 'agent' || c.lastAuthor === 'staff') && !c.preview?.held) return { key: 'customer', text: 'Waiting on customer', tone: 'neutral' }
    return c.agentState === 'active' ? { key: 'agent', text: 'AI handling', tone: 'success' } : { key: 'paused', text: 'Paused', tone: 'neutral' }
  }
  if (reasons.includes('failed')) return { key: 'failed', text: 'Not sent', tone: 'danger' }
  if (reasons.includes('blocked')) return { key: 'blocked', text: 'Blocked', tone: 'warning' }
  if (reasons.includes('paused') && c.lastAuthor === 'customer') return { key: 'waiting', text: 'Customer waiting', tone: 'warning' }
  if (reasons.includes('ticket')) return { key: 'ticket', text: 'Ticket open', tone: c.needsYou!.urgent ? 'warning' : 'info' }
  return { key: 'paused', text: 'Waiting on you', tone: 'info' }
}
const whyFacets: [Triage['key'], string, Tone][] = [['waiting', 'Customer waiting', 'warning'], ['blocked', 'Blocked', 'warning'], ['failed', 'Not sent', 'danger'], ['ticket', 'Ticket open', 'info'], ['paused', 'Waiting on you', 'info']]
/** The rail beside the list, from the rows on screen: the one reason each needs you, and its open tickets; and their channel,
 *  which filters the list, counted before that filter (`everyChannel`), so choosing Email never reads as "no chats". */
export function inboxFacetGroups(rows: SupportConversation[] | undefined, channel: Channel | '', setChannel?: (channel: Channel | '') => void, everyChannel = rows): FacetGroup[] {
  const count = (test: (c: SupportConversation) => boolean, list = rows) => list ? list.filter(test).length : null
  return [
    { key: 'why', title: 'Primary reason', items: whyFacets.map(([key, text, tone]) => ({ key, label: text, tone, count: count(c => triageOf(c).key === key) })) },
    { key: 'channel', title: 'Channel', items: (['chat', 'email'] as const).map(value => ({ key: value, label: value === 'chat' ? 'Chat' : 'Email', count: count(c => c.channel === value, everyChannel),
      ...setChannel ? { selected: channel === value, onSelect: () => setChannel(channel === value ? '' : value) } : {} })) },
    { key: 'ticket', title: 'Open tickets', items: (['P1', 'P2', 'P3'] as const).map(severity => ({ key: severity, label: severity, tone: (severity === 'P1' ? 'danger' : severity === 'P2' ? 'warning' : 'neutral') as Tone,
      count: count(c => Boolean(c.ticket && !c.ticket.resolvedAt && c.ticket.severity === severity)) })) },
  ]
}

export function InboxTabs({ view, counts, onChange, disabled = false }: { view: InboxView; counts: InboxCounts | null; onChange?: (view: InboxView) => void; disabled?: boolean }) {
  return <div className="sinbox-tabs"><Tabs value={view} label="Support views" disabled={disabled} onValueChange={value => onChange?.(value as InboxView)}
    items={inboxViews.map(({ value, label, count }) => ({ value, label, count: !count ? undefined : counts ? counts[count] ?? 0 : null }))} /></div>
}
const channelOptions = [{ value: 'all', label: 'All channels' }, { value: 'chat', label: 'Chat' }, { value: 'email', label: 'Email' }]
/** Search, and the channel filter where the rail is hidden (below 1200 px), so a filter is always visible and can be cleared. */
export function InboxToolbar({ search = '', onSearch, channel = '', onChannel, onShortcuts, disabled = false }: { search?: string; onSearch?: (value: string) => void; channel?: Channel | ''; onChannel?: (channel: Channel | '') => void; onShortcuts?: () => void; disabled?: boolean }) {
  return <div className="data-toolbar sinbox-toolbar"><div className="cluster sinbox-toolbar__filters">
    <SearchField className="search-box--list" aria-label="Search conversations" placeholder="Search conversations" value={search} disabled={disabled} onChange={event => onSearch?.(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') event.currentTarget.blur() }} />
    <Select className="sinbox-channel-select" aria-label="Channel" value={channel || 'all'} options={channelOptions} disabled={disabled || !onChannel} onValueChange={value => onChannel?.(value === 'all' ? '' : value as Channel)} />
  </div><IconButton className="sinbox-shortcuts-button" label="Keyboard shortcuts" disabled={disabled} onClick={onShortcuts}><Keyboard size={16} /></IconButton></div>
}
/** The list beside its rail. */
export const InboxBody = ({ rows, everyChannel, channel, setChannel, children }: { rows: SupportConversation[] | undefined; everyChannel?: SupportConversation[]; channel: Channel | ''; setChannel?: (channel: Channel | '') => void; children: ReactNode }) =>
  <SplitPane className="sinbox-split" rail={<FacetRail label="These conversations" groups={inboxFacetGroups(rows, channel, setChannel, everyChannel)} />}>{children}</SplitPane>
export function SupportInboxSkeleton({ view, channel }: { view: InboxView; channel: Channel | '' }) {
  return <>
    <PageHeader title="Support" />
    <LoadingRegion label="Loading support conversations"><div className="sinbox-page">
      <InboxTabs view={view} counts={null} disabled />
      <InboxToolbar channel={channel} disabled />
      <InboxBody rows={undefined} channel={channel}><TableSkeleton className="sinbox-table" columns={inboxColumnDefs} rows={12} /></InboxBody>
    </div></LoadingRegion>
  </>
}

// A conversation before it loads: the header's title and facts line, the transcript and the customer panel.
export function ConversationBodySkeleton({ panel }: { panel: boolean }) {
  return <div className="sinbox-conversation" aria-hidden="true">
    <div className="sinbox-transcript"><ol className="sinbox-timeline">{[78, 54, 66].map((width, index) => <li key={index} className="sinbox-message">
      <div className="sinbox-message__meta"><Skeleton width={96} height={12} /></div>
      <div className="sinbox-message__body"><SkeletonText width={`${width}%`} lineHeight={22} /><SkeletonText width={`${width - 24}%`} lineHeight={22} /></div>
    </li>)}</ol></div>
    {panel && <aside className="sinbox-panel"><div className="sinbox-panel__body"><h3 className="ui-label ui-label--rule">Account</h3><Skeleton height={140} /><h3 className="ui-label ui-label--rule">Conversation</h3><Skeleton height={112} /></div></aside>}
  </div>
}
/** The header's actions: Customer (the panel, on a phone), Done (e: marks it done if it needs you, and opens the next) and
 *  the actions menu. On a phone they are a line of their own under the title and facts. */
export function ConversationActions({ panel, customer, done, menu }: { panel: boolean; customer?: () => void; done?: { onClick: () => void; title: string }; menu?: ReactNode }) {
  return <>{!panel && <Button disabled={!customer} onClick={customer}>Customer</Button>}
    <Button disabled={!done} title={done?.title} onClick={done?.onClick}>Done</Button>
    {menu ?? (panel ? <ActionsTrigger disabled /> : <IconButton label="Conversation actions" disabled><MoreHorizontal size={16} /></IconButton>)}</>
}
export function SupportConversationSkeleton({ panel }: { panel: boolean }) {
  return <div className="sinbox-conversation-page">
    <PageHeader backTo="/support" title={<span className="sinbox-title-skeleton"><Skeleton width={260} height={14} /></span>} subtitle={<p className="sinbox-subtitle"><Skeleton width={220} height={10} /></p>} actions={<ConversationActions panel={panel} />} />
    <LoadingRegion label="Loading the conversation"><ConversationBodySkeleton panel={panel} /></LoadingRegion>
  </div>
}
// The route-level placeholder while the support inbox's code loads.
export function SupportRouteSkeleton({ operator, panel }: { operator: 'operator' | 'operator:read' | null | undefined; panel: boolean }) {
  const { pathname, search } = useLocation()
  if (!operator) return null
  return pathname.startsWith('/support/') ? <SupportConversationSkeleton panel={panel} /> : <SupportInboxSkeleton view={viewOf(search)} channel={channelOf(search)} />
}
