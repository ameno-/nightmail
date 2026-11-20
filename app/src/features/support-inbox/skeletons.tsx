import type { ReactNode } from 'react'
import { Keyboard, MoreHorizontal } from 'lucide-react'
import { useLocation } from 'react-router'
import { Button, IconButton, LoadingRegion, PageHeader, SearchField, SectionHeader, Skeleton, SkeletonText, TableSkeleton, Tabs, type SkeletonColumn } from '../../components/ui'
import type { InboxView } from '../../data/support-inbox'
import { ActionsTrigger } from '../operator/skeletons'
import './support-inbox.css'

// The support inbox's column definitions (card slots included), shared by the route skeleton and the loaded list. A
// phone's card: the customer and last activity, the conversation, then its status, ticket and agent on one line.
export const inboxColumnDefs: SkeletonColumn[] = [
  { key: 'customer', label: 'Customer', width: '22%', card: 'title' },
  { key: 'subject', label: 'Conversation', card: 'line' },
  { key: 'status', label: 'Status', width: 152, card: 'line' },
  { key: 'ticket', label: 'Ticket', width: 120, card: 'inline' },
  { key: 'agent', label: 'Agent', width: 148, card: 'inline' },
  { key: 'activity', label: 'Last activity', width: 104, align: 'right', card: 'aside' },
  { key: 'actions', label: '', width: 48, align: 'right', card: 'end' },
]
export const inboxViews: { value: InboxView; label: string }[] = [{ value: 'needs_you', label: 'Needs you' }, { value: 'agent', label: 'Agent handling' }, { value: 'all', label: 'All' }]
export const viewOf = (search: string): InboxView => { const view = new URLSearchParams(search).get('view'); return view === 'agent' || view === 'all' ? view : 'needs_you' }

export function InboxTabs({ view, counts, onChange, disabled = false }: { view: InboxView; counts: { needsYou: number; agent: number } | null; onChange?: (view: InboxView) => void; disabled?: boolean }) {
  return <div className="sinbox-tabs"><Tabs value={view} label="Support views" disabled={disabled} onValueChange={value => onChange?.(value as InboxView)}
    items={inboxViews.map(item => ({ ...item, count: item.value === 'all' ? undefined : counts ? counts[item.value === 'needs_you' ? 'needsYou' : 'agent'] : null }))} /></div>
}
export function InboxToolbar({ search = '', onSearch, onShortcuts, disabled = false }: { search?: string; onSearch?: (value: string) => void; onShortcuts?: () => void; disabled?: boolean }) {
  return <div className="data-toolbar sinbox-toolbar"><div className="cluster">
    <SearchField className="search-box--list" aria-label="Search conversations" placeholder="Search conversations" value={search} disabled={disabled} onChange={event => onSearch?.(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') event.currentTarget.blur() }} />
  </div><IconButton className="sinbox-shortcuts-button" label="Keyboard shortcuts" disabled={disabled} onClick={onShortcuts}><Keyboard size={16} /></IconButton></div>
}
export function SupportInboxSkeleton({ view }: { view: InboxView }) {
  return <>
    <PageHeader title="Support" />
    <LoadingRegion label="Loading support conversations"><div className="sinbox-page">
      <InboxTabs view={view} counts={null} disabled />
      <InboxToolbar disabled />
      <TableSkeleton className="sinbox-table" columns={inboxColumnDefs} rows={8} />
    </div></LoadingRegion>
  </>
}

// A conversation before it loads: the header's title and facts line, the transcript and the customer panel.
export function ConversationBodySkeleton({ panel }: { panel: boolean }) {
  return <div className="sinbox-conversation" aria-hidden="true">
    <div className="sinbox-transcript"><ol className="sinbox-messages">{[78, 54, 66].map((width, index) => <li key={index} className="sinbox-message">
      <div className="sinbox-message__meta"><Skeleton width={96} height={12} /></div>
      <div className="sinbox-message__body"><SkeletonText width={`${width}%`} lineHeight={22} /><SkeletonText width={`${width - 24}%`} lineHeight={22} /></div>
    </li>)}</ol></div>
    {panel && <aside className="sinbox-panel"><section className="op-section"><SectionHeader title="Customer" /><Skeleton height={128} /></section><section className="op-section"><SectionHeader title="Workspaces" /><Skeleton height={64} /></section></aside>}
  </div>
}
/** The header's actions: Customer (the panel, on a phone) and the actions menu. */
export function ConversationActions({ panel, customer, menu }: { panel: boolean; customer?: () => void; menu?: ReactNode }) {
  return <>{!panel && <Button disabled={!customer} onClick={customer}>Customer</Button>}{menu ?? (panel ? <ActionsTrigger disabled /> : <IconButton label="Conversation actions" disabled><MoreHorizontal size={16} /></IconButton>)}</>
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
  return pathname.startsWith('/support/') ? <SupportConversationSkeleton panel={panel} /> : <SupportInboxSkeleton view={viewOf(search)} />
}
