import { useEffect, useState, type ReactNode } from 'react'
import { FacetRail, SplitPane, statusTone, type FacetGroup, type Tone } from '../../components/ui'
import type { LogCounts, LogDirection, LogEntry } from '../../data/types'
import { label, number } from '../../lib/format'

// Logs' filters beside the list (Signal Log), from 1440 px; narrower, the toolbar's status and stream pickers filter
// instead, so each filter is on screen once. Each value counts what choosing it would list: the log's dates under the
// other filters (GET /v1/logs/facets), not the page on screen. Until the exact response arrives, the statuses keep
// their dashes. A direction lists a fixed set of rows, so the route
// skeleton, a loading page and a loaded one hold the same space, and counts arriving move nothing.
// A status's colour is its badge's in the table (rows.tsx): received mail is green, spam red, sent mail its StatusBadge tone.
export const logTone = (row: Pick<LogEntry, 'status'>): Tone => row.status === 'received' ? 'success' : row.status === 'spam' ? 'danger' : statusTone(row.status)

// Sent statuses, most looked-for first; received and spam filter received mail, under Received (spam is visible to owners and admins).
export const sentStatuses = ['delivered', 'bounced', 'complained', 'delayed', 'suppressed', 'rejected', 'rendering_failed', 'scheduled', 'queued', 'attempting', 'accepted', 'sent', 'canceled', 'acceptance_unknown', 'simulated']
export const receivedStatuses = ['received', 'spam']
/** The statuses a list can filter by, in the order the pickers show them. */
export function logStatuses(direction: LogDirection, { campaign, canAdminister }: { campaign: boolean; canAdminister: boolean }) {
  const allowed = new Set([...direction === 'received' ? [] : sentStatuses, ...campaign || direction !== 'received' ? [] : canAdminister ? receivedStatuses : ['received']])
  return [...receivedStatuses, ...sentStatuses].filter(status => allowed.has(status))
}
/** Whether a status can be combined with the chosen stream: received mail has none. */
export const withStream = (status: string, stream: string) => stream === 'all' || !receivedStatuses.includes(status)
// Always a row of their own: the outcomes people come for. Every other status is in one Other row's menu.
const PINNED = ['delivered', 'received', 'bounced', 'complained', 'scheduled', 'spam']
const countWidth = 80

export type LogFilters = { statuses: string[]; status: string; stream: string; streams: boolean; setStatus: (value: string) => void; setStream: (value: string) => void }
type RailFilters = Pick<LogFilters, 'statuses' | 'streams'> & Partial<LogFilters>
export function logFacetGroups(counts: LogCounts | undefined, filters: RailFilters, otherMenu?: {
  choices?: string[]; remember: (choices?: string[]) => void
}): FacetGroup[] {
  const count = (status: string) => counts ? counts.status[status] ?? 0 : null
  const choose = (status: string) => filters.setStatus?.(filters.status === status ? 'all' : status)
  // Received mail has no stream: while one is chosen, Received and Spam keep their rows (nothing moves) but neither count
  // nor choose, since choosing one would drop the stream and list mail the count left out.
  const streamless = (status: string) => !withStream(status, filters.stream ?? 'all')
  const pinned = PINNED.filter(status => filters.statuses.includes(status)), others = filters.statuses.filter(status => !PINNED.includes(status))
  const chosen = filters.status && others.includes(filters.status) ? filters.status : null
  const listed = otherMenu?.choices?.filter(status => others.includes(status)) ??
    others.filter(status => !counts || status === chosen || (count(status) ?? 0) > 0)
  // Stable labels preserve focus. Hold only the open menu's membership, so its counts can still update or clear.
  const menu = filters.setStatus && others.length ? listed.map(status => {
    const value = counts ? number(count(status) ?? 0) : '–'
    return { label: label(status), hint: <span style={{ display: 'block', minInlineSize: countWidth, textAlign: 'right' }}><span key={value}>{value}</span></span>, onSelect: () => choose(status) }
  }) : undefined
  const groups: FacetGroup[] = [{ key: 'status', title: 'Status', items: [
    ...pinned.map(status => streamless(status) ? { key: status, label: label(status), tone: logTone({ status }), count: null, title: 'Received mail has no stream' }
      : { key: status, label: label(status), tone: logTone({ status }), count: count(status), ...filters.setStatus && { selected: filters.status === status, onSelect: () => choose(status) } }),
    ...others.length ? [{ key: 'other', label: chosen ? label(chosen) : 'Other', tone: chosen ? logTone({ status: chosen }) : 'neutral' as Tone, dot: Boolean(chosen),
      count: counts ? chosen ? count(chosen) : others.reduce((sum, status) => sum + (count(status) ?? 0), 0) : null, selected: Boolean(chosen), menuLabel: chosen ? `Other statuses: ${label(chosen)}` : 'Other statuses', menu,
      onMenuOpenChange: otherMenu && ((open: boolean) => otherMenu.remember(open ? listed : undefined)) }] : [],
  ] }]
  // Streams are sent mail's: received mail has none, so the group leaves with it.
  if (filters.streams) groups.push({ key: 'stream', title: 'Stream', items: (['transactional', 'marketing'] as const).map(stream => ({ key: stream, label: label(stream), dot: false, count: counts ? counts.stream[stream] : null,
    ...filters.setStream && { selected: filters.stream === stream, onSelect: () => filters.setStream!(filters.stream === stream ? 'all' : stream) } })) })
  return groups
}

/** The list's body with its filters beside it. `blank`: a log with no mail at all keeps the rail's place, empty. */
export function LogsBody({ counts, asOf, from, viewKey, filters, blank, children }: { counts: LogCounts | undefined; asOf?: string | null; from?: string; viewKey?: string; filters: RailFilters; blank?: boolean; children: ReactNode }) {
  const [menu, setMenu] = useState<{ key: string; choices: string[] }>()
  const key = JSON.stringify([viewKey, blank, filters.statuses, filters.status, filters.stream])
  // A direction can remove Other without a close event. Don't carry its choices when the trigger comes back.
  useEffect(() => { setMenu(previous => previous?.key === key ? previous : undefined) }, [key])
  const choices = menu?.key === key ? menu.choices : undefined
  const remember = (next?: string[]) => setMenu(next ? { key, choices: next } : undefined)
  const detail = from ? `Exact counts from ${from}${asOf ? `, as of ${asOf}` : ''}.` : undefined
  return <SplitPane className="logs-split" rail={blank ? null : <FacetRail key={viewKey} label="Filters" countSlot={{ width: countWidth, detail }} groups={logFacetGroups(counts, filters, { choices, remember })} />}>{children}</SplitPane>
}
