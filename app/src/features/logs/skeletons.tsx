import type { ReactNode } from 'react'
import { Download, Search } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { useRegion, useWorkspaceAccess } from '../../data/context'
import { BackLink, Button, FactsRow, Icon, Input, LoadingRegion, PageHeader, Select, Skeleton, SkeletonText, TableSkeleton, Tabs, type Fact } from '../../components/ui'
import { rememberedPageSize } from '../../lib/pagination'
import { logsViewColumnDefs } from './rows'
import { label } from '../../lib/format'
import { useDetailLayout } from './detail-layout'
import { LogsBody, logStatuses, receivedStatuses } from './facets'
import { logRange, logRanges } from './range'
import './logs.css'
// The sent email's skeleton draws the preview's toolbar and frame, whose styles live with EmailInsight (a lazy chunk):
// they load with the skeleton, so its placeholders hold their size before that chunk arrives.
import '../../components/email-insight.css'
// Exactly the loaded page: the header with the direction tabs, the toolbar and the table with its remembered page size.
export function LogsRouteSkeleton() {
  const { regionId } = useRegion()
  const { canAdminister, multiTenant } = useWorkspaceAccess()
  const [params] = useSearchParams()
  const campaign = Boolean(params.get('campaign')), view = params.get('view'), direction = campaign ? 'sent' : view === 'sent' || view === 'received' ? view : 'all'
  // The filters' labels from the URL, as Logs shows them, so the toolbar keeps its widths when it loads.
  const status = params.get('status'), stream = params.get('stream')
  const statusLabel = status && status !== 'all' ? label(status) : 'All statuses', streamLabel = direction !== 'received' && status !== 'received' && status !== 'spam' && (stream === 'transactional' || stream === 'marketing') ? label(stream) : 'All streams'
  // The filters beside the list, as Logs lists them for this direction, without counts yet.
  const statuses = logStatuses(direction, { campaign, canAdminister }), streams = direction !== 'received' && !receivedStatuses.includes(status ?? '')
  return <div className="logs-page"><div className="logs-bar"><div className="logs-bar__head"><h1 className="logs-bar__title">Logs</h1>{!multiTenant && !canAdminister && <span className="logs-bar__region">{regionId}</span>}<div className="cluster logs-controls"><Tabs label="Direction" value={direction} onValueChange={() => {}} disabled items={[{ value: 'all', label: 'All' }, { value: 'sent', label: 'Sent' }, { value: 'received', label: 'Received' }]} /><Tabs label="Time range" value={logRange(params.get('range'))} onValueChange={() => {}} disabled items={logRanges} /></div></div>
    <div className="logs-bar__tools">{campaign && <Skeleton width={160} height="var(--control-height-sm)" />}<div className="search-box logs-search"><Icon icon={Search} size="sm" /><Input type="search" aria-label="Search logs" placeholder="Search logs" disabled /><kbd className="ui-kbd" aria-hidden="true">/</kbd></div><Select className="logs-filter" value="all" onValueChange={() => {}} disabled options={[{ value: 'all', label: statusLabel }]} /><Select className="logs-filter" value="all" onValueChange={() => {}} disabled options={[{ value: 'all', label: streamLabel }]} /><Button className="logs-export" disabled><Icon icon={Download} /><span>Export</span></Button></div></div>
    <LogsBody counts={undefined} filters={{ statuses, streams }}><TableSkeleton className="logs-table" columns={logsViewColumnDefs(direction)} rows={rememberedPageSize('logs') || 16} pagination /></LogsBody></div>
}
// Sent and received mail open in one layout (email-detail.tsx, received-detail.tsx); only what the data holds differs.
export type EmailKind = 'sent' | 'received'
/** An email's 44px header bar on a desktop: back, the kind of mail in mono, the subject on one line, and at its end
 *  the status and the copyable ID. */
export function EmailBar({ kind, title, end }: { kind: EmailKind; title: ReactNode; end?: ReactNode }) {
  return <header className="email-bar"><BackLink to="/logs" /><span className="email-bar__tag">{kind === 'sent' ? 'Sent email' : 'Received email'}</span><h1 className="email-bar__title" title={typeof title === 'string' ? title : undefined}>{title}</h1>{end && <div className="email-bar__end">{end}</div>}</header>
}
// An email's facts on a desktop, in two groups: who it's from and to, over the preview; then over the details column
// (logs.css) a sent email's stream, when it was sent and the region, or when a received one arrived and the region. Its
// ID is in the bar.
export const emailFactGroups = (kind: EmailKind, multiTenant: boolean) => [['From', 'To'], [...kind === 'sent' ? ['Stream', 'Sent'] : ['Received'], ...multiTenant ? [] : ['Region']]]
/** The facts strip under the bar: a FactsRow per group, the second starting on the details column's edge. */
export function EmailFactsStrip({ kind, multiTenant, fact, label }: { kind: EmailKind; multiTenant: boolean; fact: (name: string) => Omit<Fact, 'label'>; label?: string }) {
  return <div className="email-facts" role="group" aria-label={label}>{emailFactGroups(kind, multiTenant).map(names => <FactsRow key={names[0]} items={names.map(name => ({ label: name, ...fact(name) }))} />)}</div>
}
const factWidths: Record<string, number> = { From: 160, To: 160, Stream: 80, Sent: 120, Received: 120, Region: 72 }
// An email in the window's layout (detail-layout.ts): the header, a sent email's delivery, the preview's toolbar and its
// empty stage, and from 1200 px the details column (a sent email's delivery and checks, a received one's checks and
// details). The score's place has a placeholder only in that column: elsewhere it appears where nothing else depends on it.
export function EmailDetailSkeleton({ kind }: { kind: EmailKind }) {
  const { mode } = useDetailLayout()
  const { multiTenant } = useWorkspaceAccess()
  // A phone or tablet: the subject, the status line, the preview's one row of controls and its frame.
  if (mode === 'stack') return <div className="email-detail" data-mode={mode}><PageHeader title={<SkeletonText width={240} lineHeight={24} />} backTo="/logs" subtitle={<div className="email-status"><SkeletonText width={180} /></div>} />
    <LoadingRegion label="Loading email"><div className="email-detail__body"><section className="email-detail__preview"><div className="ev" data-compact><div className="ev-toolbar"><Skeleton width={112} height={28} /></div>
      <div className="ev-stage"><div className="ev-canvas"><div className="ev-placeholder" /></div></div></div></section></div></LoadingRegion></div>
  const delivery = <div className="delivery" data-vertical={mode !== 'panel' || undefined}>{mode === 'panel' ? <SkeletonText width={300} lineHeight={28} /> : <div className="delivery__skeleton">{[96, 80, 112].map(width => <SkeletonText key={width} width={width} lineHeight={28} />)}</div>}</div>
  const lines = (widths: number[]) => <div className="delivery__skeleton">{widths.map(width => <SkeletonText key={width} width={width} lineHeight={28} />)}</div>
  return <div className="email-detail" data-mode={mode}><EmailBar kind={kind} title={<SkeletonText width={320} lineHeight={24} />} end={<><SkeletonText width={72} /><SkeletonText width={180} /></>} />
    <EmailFactsStrip kind={kind} multiTenant={multiTenant} fact={name => ({ value: <SkeletonText width={factWidths[name]} /> })} />
    <LoadingRegion label="Loading email">
      {mode === 'panel' && kind === 'sent' && delivery}
      <div className="email-detail__body">
        <section className="email-detail__preview"><div className="ev" data-fill><div className="ev-toolbar"><Skeleton width={360} height={28} /></div>
          <div className="ev-stage"><div className="ev-captions" /><div className="ev-canvas"><div className="ev-placeholder" /></div></div></div></section>
        {mode === 'column' && (kind === 'sent' ? <aside className="email-detail__side"><section className="email-detail__delivery"><h2 className="ss__title">Delivery</h2>{delivery}</section>
          <section className="ss"><h2 className="ss__title">Checks</h2><div className="ss__fixes">{['86%', '70%'].map(width => <SkeletonText key={width} width={width} lineHeight={28} />)}</div></section></aside>
          : <aside className="email-detail__side"><section className="email-detail__section"><h2 className="ss__title">Checks</h2>{lines([88, 72, 96])}</section>
            <section className="email-detail__section"><h2 className="ss__title">Details</h2>{lines([200, 160])}</section></aside>)}
      </div>
    </LoadingRegion></div>
}
