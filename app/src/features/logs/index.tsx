import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { Download, Search, X } from 'lucide-react'
import { useApiDef, useApiQuery, useLogsVisibility, useRegion, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { usePrefetchQueries } from '../../data/prefetch'
import type { LogDirection, LogEntry, TimeRange } from '../../data/types'
import { Button, DataTable, EmptyState, ErrorState, Icon, Input, PaginationSkeleton, Pagination, Select, Tabs } from '../../components/ui'
import { date, label, time } from '../../lib/format'
import { downloadCsv } from '../../lib/download'
import { isReceivedId, logsViewColumns, logCsvRows, logHref, logRowLabel, useLogRowIntent } from './rows'
import { useAdaptivePageSize, useSearchDraft } from '../../lib/pagination'
import { EmailDetailPage } from './email-detail'
import { ReceivedEmailDetailPage } from './received-detail'
import { useScheduledActions } from './scheduled'
import { useMediaQuery } from '../../lib/media'
import { LogsBody, logStatuses, pickerStatuses, receivedStatuses, withStream, type LogFilters } from './facets'
import { keptRangeStart, logRange, logRanges, touchRangeStart } from './range'
import { useLogFacets } from './facet-query'

const directions = [{ value: 'all', label: 'All' }, { value: 'sent', label: 'Sent' }, { value: 'received', label: 'Received' }]
const option = (value: string) => ({ value, label: value === 'all' ? 'All statuses' : label(value) })
const streams = [{ value: 'all', label: 'All streams' }, { value: 'transactional', label: 'Transactional' }, { value: 'marketing', label: 'Marketing' }]
export const logDirection = (view: string | null, campaignId?: string): LogDirection => campaignId ? 'sent' : view === 'sent' || view === 'received' ? view : 'all'
// A range's start (range.ts), kept while the page shows that range and for a while after it leaves it.
function useRangeStart(range: TimeRange) {
  const [start, setStart] = useState(() => ({ range, from: keptRangeStart(range) }))
  const shown = start.range === range ? start : { range, from: keptRangeStart(range) }
  if (shown !== start) setStart(shown)
  useEffect(() => () => touchRangeStart(shown.range, shown.from), [shown.range, shown.from])
  return shown.from
}
// A substring search needs 3 characters (the API refuses fewer): until then the list isn't searched.
const searchTerm = (value: string) => value.trim().length >= 3 ? value.trim() : ''

// Logs: sent and received mail in one list, newest first (GET /v1/logs). Received mail follows the API's rules: owners
// and admins see every received message, including unrouted mail; members see mail on receiving addresses.
export function LogsPage() {
  const { regionId } = useRegion()
  const [params] = useSearchParams()
  const campaignId = params.get('campaign') || undefined
  return <Logs key={`${regionId}:${campaignId ?? ''}`} regionId={regionId} campaignId={campaignId} />
}
// The console's one control strip opens with the title, the direction and the range; the search, filters and export
// follow in the same 40px bar (Logs below). The sidebar's region selector already names the region; repeat it only when
// it is hidden or a campaign filter shows another region. Hosted logs span every region and name none.
function LogsHeader({ regionId, direction, onDirection, locked, range, onRange }: { regionId: string; direction: LogDirection; onDirection: (value: LogDirection) => void; locked?: boolean; range: TimeRange; onRange: (value: TimeRange) => void }) {
  const selected = useRegion().regionId
  const { canAdminister, multiTenant } = useWorkspaceAccess()
  return <div className="logs-bar__head"><h1 className="logs-bar__title">Logs</h1>{!multiTenant && (!canAdminister || regionId !== selected) && <span className="logs-bar__region">{regionId}</span>}
    <div className="cluster logs-controls">
      <Tabs label="Direction" value={direction} onValueChange={value => onDirection(value as LogDirection)} disabled={locked} items={directions} />
      <Tabs label="Time range" value={range} onValueChange={value => onRange(value as TimeRange)} items={logRanges} />
    </div>
  </div>
}
// Everything that decides the rows is in the URL (view, q, status, stream, page), so Back from an email, a reload or a
// shared link shows the same page of the same list. Filters replace the entry instead of adding one per keystroke.
function Logs({ regionId, campaignId }: { regionId: string; campaignId?: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const rowIntent = useLogRowIntent()
  const scheduled = useScheduledActions()
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const visibility = useLogsVisibility()
  // A campaign sends from one region, so its filter replaces the region selector; it lists sent mail only.
  const campaign = useApiQuery(['campaign', campaignId ?? null], (api, signal) => campaignId ? api.campaigns.get(campaignId, signal) : Promise.resolve(null))
  const direction = logDirection(searchParams.get('view'), campaignId)
  const search = searchParams.get('q') ?? '', searched = searchTerm(search)
  const range = logRange(searchParams.get('range')), from = useRangeStart(range)
  const statuses = logStatuses(direction, { campaign: Boolean(campaignId), canAdminister }), allowed = new Set(statuses)
  const requested = searchParams.get('status') ?? 'all'
  const status = allowed.has(requested) ? requested : 'all'
  const receivedOnly = direction === 'received' || receivedStatuses.includes(status)
  const requestedStream = searchParams.get('stream')
  const stream = !receivedOnly && (requestedStream === 'transactional' || requestedStream === 'marketing') ? requestedStream : 'all'
  const page = Math.max(1, Math.floor(Number(searchParams.get('page'))) || 1)
  const update = (changes: Record<string, string | null>, keepPage = false) => setSearchParams(previous => {
    const next = new URLSearchParams(previous)
    for (const [key, value] of Object.entries(changes)) if (value === null || value === '' || value === 'all') next.delete(key); else next.set(key, value)
    if (!keepPage) next.delete('page')
    return next
  }, { replace: true })
  const clearCampaign = () => update({ campaign: null })
  const [draft, type] = useSearchDraft(search, value => update({ q: value }))
  const filtersForRows = useMemo(() => ({ ...(campaignId ? { campaignId } : { regionId }), direction, search: searched,
    status: status === 'all' ? undefined : status, stream: stream === 'all' ? undefined : stream, from }),
  [campaignId, regionId, direction, searched, status, stream, from])
  const rowsForSize = useCallback((pageSize: number) => queries.logs({ ...filtersForRows, page, pageSize }, visibility), [filtersForRows, page, visibility])
  const prefetch = usePrefetchQueries()
  const firstFit = useCallback((size: number) => { if (visibility !== null) void prefetch([rowsForSize(size)]) }, [visibility, prefetch, rowsForSize])
  const { pageSize, tableRef, measured } = useAdaptivePageSize(5, 100, 'logs', firstFit)
  // A new page size (the window resized) starts from the first page; the size settling on mount keeps the URL's page.
  const fitted = useRef<number | null>(null)
  useEffect(() => { if (!measured) return; if (fitted.current !== null && fitted.current !== pageSize) update({ page: null }); fitted.current = pageSize }, [pageSize, measured]) // eslint-disable-line react-hooks/exhaustive-deps
  // Status and stream follow the direction: a status the new direction doesn't list leaves, and streams are sent mail only.
  const setDirection = (value: LogDirection) => update({ view: value, status: logStatuses(value, { campaign: false, canAdminister }).includes(status) ? status : null, stream: value === 'received' ? null : stream })
  const query = useApiDef(rowsForSize(pageSize),
    { interval: 30_000, enabled: measured && visibility !== null, keepPrevious: previous => previous[2] === visibility })
  // A page the session has no cursor for (a reload, or the window's page size changed) comes back as page 1: say so in the URL too.
  const served = query.data && !query.isPlaceholderData ? query.data.page : undefined
  useEffect(() => { if (served !== undefined && served !== page) update({ page: served === 1 ? null : String(served) }, true) }, [served, page]) // eslint-disable-line react-hooks/exhaustive-deps
  // The previous filter's rows stay on screen while the next loads, keyed apart from the result that replaces them: a
  // row in both lists (received mail under All and Received) is swapped in place, not moved down the table.
  const filtered = Boolean(searched || campaignId || status !== 'all' || stream !== 'all' || range !== '30d')
  // A campaign's own empty state needs its summary: wait for it, or offer to retry it, before calling the list unmatched.
  const campaignOnly = Boolean(campaignId) && !searched && status === 'all' && stream === 'all' && range === '30d'
  // The filters beside the list set the same URL filters as the toolbar's pickers, which they replace from 1440 px.
  const setStatus = (value: string) => update({ status: value, ...receivedStatuses.includes(value) ? { stream: null } : {} })
  // No mail at all yet: the first-run message alone, without a rail of zeros (its place stays, so nothing moves).
  const blank = Boolean(query.data && !query.isPlaceholderData && !query.data.items.length && !filtered && page === 1)
  const railed = useMediaQuery('(min-width: 1440px)')
  const rowsReady = measured && Boolean(query.data) && !query.isPlaceholderData && !query.isError && !(campaignOnly && campaign.isPending)
  const { cut, authorizationLost, view } = useLogFacets({
    filters: filtersForRows,
    range, scope: visibility, visibility: canAdminister ? 'admin' : 'member', railed, blank, rowsReady, rowError: query.error,
  })
  // A facet response can learn about a demotion before /v1/me does. Hide privileged rows and controls immediately.
  const visibleStatuses = authorizationLost ? statuses.filter(value => value !== 'spam') : statuses
  const visibleStatus = visibleStatuses.includes(status) ? status : 'all'
  const filters: LogFilters = { statuses: visibleStatuses, status: visibleStatus, stream, streams: !receivedOnly, setStatus, setStream: value => update({ stream: value }) }
  // An export is the rows on screen for the filters shown: while the next filter's rows load, the previous rows stay up
  // but can't be exported, and neither can rows while the search box holds text the list hasn't searched for yet.
  const exportable = !authorizationLost && Boolean(query.data?.items.length) && !query.isPlaceholderData && draft.trim() === searched
  return <div className="logs-page"><div className="logs-bar"><LogsHeader regionId={campaign.data?.regionId ?? regionId} direction={direction} onDirection={setDirection} locked={Boolean(campaignId)} range={range} onRange={value => update({ range: value === '30d' ? null : value })} />
    <div className="logs-bar__tools">{campaignId && <Button variant="secondary" size="sm" aria-label={`Remove campaign filter: ${campaign.data?.name ?? campaignId}`} onClick={clearCampaign} title={campaign.data?.name}><span className="logs-campaign-chip">Campaign: {campaign.data?.name ?? campaignId}</span><Icon icon={X} size="sm" /></Button>}<div className="search-box logs-search"><Icon icon={Search} size="sm" /><Input type="search" aria-label="Search logs" placeholder="Search logs" maxLength={200} value={draft} onChange={event => type(event.target.value)} /><kbd className="ui-kbd" aria-hidden="true">/</kbd></div>
      <Select className="logs-filter" aria-label="Email status" value={visibleStatus} onValueChange={setStatus} options={['all', ...pickerStatuses(visibleStatuses, visibleStatus)].map(value => ({ ...option(value), disabled: !withStream(value, stream) }))} />
      <Select className="logs-filter" aria-label="Email stream filter" value={stream} disabled={receivedOnly} onValueChange={value => update({ stream: value })} options={streams} />
      <Button className="logs-export" aria-label="Export this page as CSV" title="Download the rows on this page as a CSV file" disabled={!exportable} onClick={() => downloadCsv(campaignId ? `nightmail-${campaignId}-logs-page.csv` : 'nightmail-logs-page.csv', logCsvRows(query.data?.items ?? [], !multiTenant))}><Icon icon={Download} /><span>Export</span></Button></div>
    </div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <LogsBody counts={cut?.counts} asOf={cut?.asOf} from={cut?.from} viewKey={authorizationLost ? `denied:${view}` : view} filters={filters} blank={blank}>
      <DataTable<LogEntry> className="logs-table" tableRef={tableRef} loading={authorizationLost || query.isPending || (campaignOnly && campaign.isPending)} skeletonRows={pageSize} minRows={pageSize} rows={authorizationLost ? [] : query.data?.items ?? []} rowKey={row => `${query.isPlaceholderData ? 'previous:' : ''}${row.direction}:${row.id}`} rowHref={logHref} rowLabel={logRowLabel} onRowIntent={rowIntent} columns={scheduled.columns(logsViewColumns(direction))}
        empty={campaignOnly && campaign.isError && !campaign.data ? <ErrorState error={campaign.error} onRetry={() => campaign.refetch()} />
          // A campaign that hasn't sent says when it will, in its heading.
          : campaignId && campaignOnly && campaign.data && !campaign.data.counts?.total ? <EmptyState title={campaign.data.scheduledAt && Date.parse(campaign.data.scheduledAt) > Date.now() ? `Scheduled for ${date(campaign.data.scheduledAt)} at ${time(campaign.data.scheduledAt)} UTC` : 'Nothing sent from this campaign yet'} action={<Link className="ui-button ui-button--secondary ui-button--md" to={`/campaigns/${encodeURIComponent(campaignId)}/review`}>Back to campaign</Link>} />
          : filtered ? <EmptyState title="No matching mail" action={<Button onClick={() => update({ q: null, status: null, stream: null, campaign: null, range: null, ...direction !== 'all' && !campaignId ? { view: null } : {} })}>Clear filters</Button>} />
          : <EmptyState title={direction === 'received' ? 'No mail received yet' : direction === 'sent' ? 'No mail sent yet' : 'No mail yet'} action={direction === 'received' ? <Link className="ui-button ui-button--primary ui-button--md" to="/receiving">Set up receiving</Link> : <Link className="ui-button ui-button--primary ui-button--md" to="/docs#quickstart">Send your first email</Link>} />} />
      {scheduled.dialogs}
      {query.data && !authorizationLost ? <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} nextCursor={query.data.nextCursor} count={query.data.items.length} onPageChange={next => update({ page: next === 1 ? null : String(next) }, true)} /> : <PaginationSkeleton />}
    </LogsBody>}
  </div>
}

// One detail route for both directions, in one layout (email-detail.tsx, received-detail.tsx): received message IDs start with msg_.
export function LogDetailPage() {
  const { id = '' } = useParams()
  return isReceivedId(id) ? <ReceivedEmailDetailPage /> : <EmailDetailPage />
}
