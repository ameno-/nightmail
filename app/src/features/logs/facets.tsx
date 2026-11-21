import type { ReactNode } from 'react'
import { FacetRail, Histogram, SplitPane, type FacetGroup, type HistogramBin, type Tone } from '../../components/ui'
import type { LogEntry } from '../../data/types'
import { date, label } from '../../lib/format'

// Logs' facet rail and volume strip (Signal Log), from the rows on screen: what this page holds by status, direction,
// stream and domain, and when it was sent or received. Both have fixed slots, so the route skeleton, a loading page and
// any loaded page hold the same space. A status, direction or stream filters the list as the toolbar's controls do.
const failed = new Set(['bounced', 'complained', 'rejected', 'rendering_failed', 'suppressed', 'spam'])
const slowed = new Set(['delayed', 'deferred', 'acceptance_unknown', 'scheduled', 'queued', 'attempting'])
export const logTone = (row: Pick<LogEntry, 'status'>): Tone => failed.has(row.status) ? 'danger' : slowed.has(row.status) ? 'warning' : row.status === 'delivered' || row.status === 'received' ? 'success' : 'neutral'
const STATUSES = ['delivered', 'received', 'bounced', 'complained', 'scheduled'] as const
const DOMAIN_SLOTS = 3
const domainOf = (address?: string) => address && address.includes('@') ? address.slice(address.lastIndexOf('@') + 1).toLowerCase() : null

export type FacetFilters = { status: string; direction: string; stream: string; can: (key: 'status' | 'direction' | 'stream', value: string) => boolean; set: (key: 'status' | 'direction' | 'stream', value: string) => void }
export function logFacetGroups(items: LogEntry[] | undefined, filters?: FacetFilters): FacetGroup[] {
  const count = (test: (row: LogEntry) => boolean) => items ? items.filter(test).length : null
  const pick = (key: 'status' | 'direction' | 'stream', value: string, current?: string) => filters && filters.can(key, value) ? { selected: current === value, onSelect: () => filters.set(key, current === value ? 'all' : value) } : {}
  const known = new Set<string>(STATUSES)
  const domains = new Map<string, number>()
  for (const row of items ?? []) { const domain = domainOf(row.direction === 'sent' ? row.to[0] : row.from.address); if (domain) domains.set(domain, (domains.get(domain) ?? 0) + 1) }
  const top = [...domains].sort((a, b) => b[1] - a[1]).slice(0, DOMAIN_SLOTS)
  return [
    { key: 'status', title: 'Status', items: [
      ...STATUSES.map(status => ({ key: status, label: label(status), tone: logTone({ status }), count: count(row => row.status === status), ...pick('status', status, filters?.status) })),
      { key: 'other', label: 'Other', tone: 'neutral' as Tone, count: count(row => !known.has(row.status)) },
    ] },
    { key: 'direction', title: 'Direction', items: (['sent', 'received'] as const).map(direction => ({ key: direction, label: direction === 'sent' ? 'Sent' : 'Received', count: count(row => row.direction === direction), ...pick('direction', direction, filters?.direction) })) },
    { key: 'stream', title: 'Stream', items: (['transactional', 'marketing'] as const).map(stream => ({ key: stream, label: label(stream), count: count(row => row.stream === stream), ...pick('stream', stream, filters?.stream) })) },
    { key: 'domain', title: 'Domain', items: Array.from({ length: DOMAIN_SLOTS }, (_, i) => top[i] ? { key: top[i][0], label: top[i][0], count: top[i][1] } : { key: `slot-${i}`, slot: true }) },
  ]
}

const BINS = 48
const stamp = (at: string) => date(at, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
export function logBins(items: LogEntry[] | undefined): { bins: HistogramBin[]; start?: string; end?: string } {
  const bins: HistogramBin[] = Array.from({ length: BINS }, () => ({ ok: 0, warning: 0, danger: 0 }))
  if (!items?.length) return { bins }
  const times = items.map(row => Date.parse(row.at)), first = Math.min(...times), last = Math.max(...times), span = Math.max(1, last - first)
  items.forEach((row, i) => { const bin = bins[Math.min(BINS - 1, Math.floor((times[i] - first) / span * BINS))], tone = logTone(row); if (tone === 'danger') bin.danger!++; else if (tone === 'warning') bin.warning!++; else bin.ok++ })
  return { bins, start: `${stamp(new Date(first).toISOString())} UTC`, end: `${stamp(new Date(last).toISOString())} UTC` }
}

/** The list's body: the facets beside it, the volume strip over it. */
export function LogsBody({ items, filters, children }: { items: LogEntry[] | undefined; filters?: FacetFilters; children: ReactNode }) {
  const { bins, start, end } = logBins(items)
  return <SplitPane className="logs-split" rail={<FacetRail label="This page" groups={logFacetGroups(items, filters)} />}>
    <Histogram className="logs-histogram" bins={bins} start={start} end={end} label="Volume on this page" />
    {children}
  </SplitPane>
}