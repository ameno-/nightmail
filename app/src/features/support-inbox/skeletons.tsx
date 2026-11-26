import type { ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useLocation } from 'react-router'
import { Button, IconButton, LoadingRegion, PageHeader, SearchField, Select, Skeleton, SkeletonText, TableSkeleton, Tabs, type SkeletonColumn, type Tone } from '../../components/ui'
import { channelLabels, type Channel, type InboxCounts, type InboxView, type SupportConversation } from '../../data/support-inbox'
import { ActionsTrigger } from '../operator/skeletons'
import './support-inbox.css'

// The support inbox's column definitions (card slots included), shared by the route skeleton and the loaded list. A
// phone's card: the customer and last activity, the conversation (its subject, then the last message itself), then its
// status.
export const inboxColumnDefs: SkeletonColumn[] = [
  { key: 'customer', label: 'Customer', width: 'var(--sinbox-customer, 22%)', card: 'title' },
  { key: 'subject', label: 'Conversation', card: 'line' },
  { key: 'preview', label: 'Last message', card: 'line', table: false },
  { key: 'status', label: 'Status', width: 'var(--sinbox-status, 168px)', card: 'line' },
  { key: 'activity', label: 'Last', width: 64, align: 'right', card: 'aside' },
  { key: 'actions', label: '', width: 40, align: 'right', card: 'end' },
]
export const inboxViews: { value: InboxView; label: string; count?: keyof InboxCounts }[] = [{ value: 'needs_you', label: 'Needs you', count: 'needsYou' }, { value: 'all', label: 'All' }]
export const viewOf = (search: string): InboxView => { const view = new URLSearchParams(search).get('view'); return view && view !== 'needs_you' ? 'all' : 'needs_you' }
export const channelOf = (search: string): Channel | '' => { const channel = new URLSearchParams(search).get('channel'); return channel && Object.hasOwn(channelLabels, channel) ? channel as Channel : '' }

// Where a conversation stands, in six labels: three distinct failure states (Not sent, No reply sent, Blocked),
// Needs you (anything else awaiting staff), Waiting (open, awaiting the customer or agent), and Done.
export type Triage = { key: 'failed' | 'no_reply' | 'blocked' | 'needs_you' | 'waiting' | 'done'; text: string; tone: Tone }
export function triageOf(c: SupportConversation): Triage {
  const reasons = c.needsYou?.reasons
  if (!reasons) {
    if (c.done || c.status === 'closed' || (c.channel === 'agent_feedback' && Boolean(c.ticket?.resolvedAt))) return { key: 'done', text: 'Done', tone: 'neutral' }
    if (c.channel === 'agent_feedback') return { key: 'needs_you', text: 'Needs you', tone: 'info' }
    return { key: 'waiting', text: 'Waiting', tone: 'neutral' }
  }
  if (reasons.includes('failed')) return { key: 'failed', text: 'Not sent', tone: 'danger' }
  if (reasons.includes('no_reply')) return { key: 'no_reply', text: 'No reply sent', tone: 'danger' }
  if (reasons.includes('blocked')) return { key: 'blocked', text: 'Blocked', tone: 'warning' }
  return { key: 'needs_you', text: 'Needs you', tone: c.needsYou!.urgent ? 'warning' : 'info' }
}
export function InboxTabs({ view, counts, onChange, disabled = false }: { view: InboxView; counts: InboxCounts | null; onChange?: (view: InboxView) => void; disabled?: boolean }) {
  return <div className="sinbox-tabs"><Tabs value={view} label="Support views" disabled={disabled} onValueChange={value => onChange?.(value as InboxView)}
    items={inboxViews.map(({ value, label, count }) => ({ value, label, count: !count ? undefined : counts ? counts[count] ?? 0 : null }))} /></div>
}
const channelOptions = [{ value: 'all', label: 'All channels' }, ...Object.entries(channelLabels).map(([value, label]) => ({ value, label }))]
/** Search and channel filter. */
export function InboxToolbar({ search = '', onSearch, channel = '', onChannel, disabled = false }: { search?: string; onSearch?: (value: string) => void; channel?: Channel | ''; onChannel?: (channel: Channel | '') => void; disabled?: boolean }) {
  return <div className="data-toolbar sinbox-toolbar"><div className="cluster sinbox-toolbar__filters">
    <SearchField className="search-box--list" aria-label="Search conversations" placeholder="Search conversations" value={search} disabled={disabled} onChange={event => onSearch?.(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') event.currentTarget.blur() }} />
    <Select className="sinbox-channel-select" aria-label="Channel" value={channel || 'all'} options={channelOptions} disabled={disabled || !onChannel} onValueChange={value => onChannel?.(value === 'all' ? '' : value as Channel)} />
  </div></div>
}
export function SupportInboxSkeleton({ view, channel }: { view: InboxView; channel: Channel | '' }) {
  return <>
    <PageHeader title="Support" />
    <LoadingRegion label="Loading support conversations"><div className="sinbox-page">
      <InboxTabs view={view} counts={null} disabled />
      <InboxToolbar channel={channel} disabled />
      <TableSkeleton className="sinbox-table" columns={inboxColumnDefs} rows={12} />
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
    {panel && <aside className="sinbox-panel"><div className="sinbox-panel__body"><h3 className="ui-label ui-label--rule">Customer</h3><Skeleton height={140} /></div></aside>}
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
