import type { TimeRange } from '../../data/types'
import { logDays } from '../../data/log-facets'

// The dates Logs lists and counts. 30d, the default, is all of it: the email log keeps 30 days (received mail older than
// that stays in its inbox). The list and its counts share one start, which stays put while the page polls and pages (a
// cursor is bound to its dates); choosing a range, or opening the page, starts it again. Whole minutes, so the page and
// its prefetch (data/prefetch.ts) agree.
export const logRanges = [{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]
export const logRange = (value: string | null): TimeRange => value === '24h' || value === '7d' ? value : '30d'
export const rangeStart = (range: TimeRange, now = Date.now()) => new Date(Math.floor((now - logDays[range] * 86_400_000) / 60_000) * 60_000).toISOString()
