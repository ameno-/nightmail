import type { TimeRange } from '../../data/types'
import { logDays } from '../../data/log-facets'

// The dates Logs lists and counts. 30d, the default, is all of it: the email log keeps 30 days (received mail older than
// that stays in its inbox). The list and its counts share one start, which stays put while the page polls and pages (a
// cursor is bound to its dates). Whole minutes, so the page and its prefetch (data/prefetch.ts) agree.
export const logRanges = [{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]
export const logRange = (value: string | null): TimeRange => value === '24h' || value === '7d' ? value : '30d'
export const rangeStart = (range: TimeRange, now = Date.now()) => new Date(Math.floor((now - logDays[range] * 86_400_000) / 60_000) * 60_000).toISOString()

// The start each range last used, kept while its rows stay in the query cache (gcTime, main.tsx) after Logs was last on
// screen. Going back to Logs from an email, or back to a range, asks for the same dates, so the cached list (and the
// page of it the URL names) shows at once and refreshes in place; a new start each time was a new query, and the list
// drew empty placeholders first, then its rows (25 Nov). Older than that, a range starts again from now.
const KEEP_MS = 30 * 60_000
const kept = new Map<TimeRange, { from: string; used: number }>()
/** The start for `range`: the one it last used if that was recent, else a new one. */
export function keptRangeStart(range: TimeRange, now = Date.now()) {
  const last = kept.get(range)
  const from = last && now - last.used < KEEP_MS ? last.from : rangeStart(range, now)
  kept.set(range, { from, used: now })
  return from
}
/** Logs is leaving or polling with `range`: its start counts as used now. */
export const touchRangeStart = (range: TimeRange, from: string, now = Date.now()) => { if (kept.get(range)?.from === from) kept.set(range, { from, used: now }) }
