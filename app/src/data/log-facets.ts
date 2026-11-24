import { ApiError, type LogFacetInput, type LogFacetRead, type TimeRange } from './types.js'

export const logDays: Record<TimeRange, number> = { '24h': 1, '7d': 7, '30d': 30 }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const invalid = () => new ApiError('The Logs facet response was not complete.', 'INVALID_RESPONSE')

/** Date.parse alone cannot order cuts in the same millisecond. UTC and offset forms compare on the same clock. */
export function facetInstant(value: unknown) {
  if (typeof value !== 'string') return NaN
  const form = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.(\d{1,6}))?(?:Z|[+-]\d\d:\d\d)$/.exec(value)
  return form ? Date.parse(value) * 1000 + Number((form[1] ?? '').padEnd(6, '0').slice(3)) : NaN
}

/** Only the supported rolling views have a historical certificate and a stamped background replacement. */
export function foldableFacetView(input: Pick<LogFacetInput, 'search' | 'campaignId' | 'to' | 'from'>) {
  const lower = facetInstant(input.from), age = Date.now() * 1000 - lower
  return !input.search && !input.campaignId && !input.to && Number.isFinite(lower) &&
    lower % 60_000_000 === 0 && age >= 0 && age <= 31 * 86_400_000_000
}

export function decodeLogFacets(data: unknown, input: LogFacetInput): LogFacetRead {
  if (!record(data)) throw invalid()
  if (data.state === 'pending') {
    const delay = data.retryAfterSeconds
    if (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 1 || delay > 300 ||
        Object.keys(data).some(key => !['state', 'last', 'retryAfterSeconds'].includes(key))) throw invalid()
    if (data.last === null) return { state: 'pending', last: null, retryAfterSeconds: delay }
    if (!record(data.last) || data.last.state !== undefined || input.search || input.campaignId || input.to ||
        (input.mode === 'refresh' && !foldableFacetView(input))) throw invalid()
    // Pending is not a fresh result. Apply the ordinary role, exact-count and *historical*
    // lower-bound checks to its optional prior publication, never the visible list's new anchor.
    const last = decodeLogFacets(data.last, { ...input, mode: 'last' })
    if ('state' in last || !last.counts || !last.asOf) throw invalid()
    return { state: 'pending', last: { ...last, asOf: last.asOf }, retryAfterSeconds: delay }
  }
  // Check the authorization band before counts. Even a malformed response from a demoted role revokes the old view.
  const { visibility } = input
  if (data.visibility !== visibility) throw new ApiError('Logs access changed.', 'LOG_FACET_VISIBILITY_CHANGED')
  if (data.state !== undefined) throw invalid()
  if (input.mode === 'last' && data.counts === null && data.asOf === null && data.from === null) return { counts: null, asOf: null, from: null, visibility }
  const { counts } = data
  if (!record(counts) || !record(counts.status) || !Object.values(counts.status).every(count) ||
      !record(counts.kind) || !count(counts.kind.transactional) || !count(counts.kind.marketing) ||
      !record(counts.capped) || counts.capped.sent !== false || counts.capped.received !== false ||
      (visibility === 'member' && Object.hasOwn(counts.status, 'spam'))) throw invalid()
  const { from } = data
  // Searches, campaigns and other unfurlable bounds use the live exact branch of refresh, with no source cut timestamp.
  const asOf = data.asOf
  const lower = facetInstant(from), cut = facetInstant(asOf)
  if (typeof from !== 'string' || !Number.isFinite(lower)) throw invalid()
  const rollingRefresh = foldableFacetView(input)
  if ((input.mode === 'last' || rollingRefresh || asOf !== undefined) && (!Number.isFinite(cut) || cut < lower)) throw invalid()
  if (input.mode === 'last') {
    // The cut pair uses the rolling window at the source statement's UTC minute, not our visible row range.
    if (lower !== Math.floor(cut / 60_000_000) * 60_000_000 - logDays[input.range] * 86_400_000_000) throw invalid()
  } else if (lower !== facetInstant(input.from)) throw invalid()
  return { counts: { status: counts.status as Record<string, number>, stream: { transactional: counts.kind.transactional, marketing: counts.kind.marketing } },
    asOf: typeof asOf === 'string' ? asOf : null, from, visibility }
}

// Consecutive pending replies for one request, counted on the reply itself. The stamped attempt also makes each reply
// differ from the last (the query cache would keep an equal earlier object), so the quiet retry grows from the server's
// delay to five minutes while the service stays busy, instead of returning every few seconds from every open tab.
const pendingStreaks = new Map<string, number>()
export function countPending(result: LogFacetRead, request: string): LogFacetRead {
  if (!('state' in result)) { pendingStreaks.delete(request); return result }
  const attempt = (pendingStreaks.get(request) ?? 0) + 1
  pendingStreaks.delete(request)
  pendingStreaks.set(request, attempt)
  if (pendingStreaks.size > 32) pendingStreaks.delete(pendingStreaks.keys().next().value!)
  return { ...result, attempt }
}

export const facetPollMs = (data: LogFacetRead | undefined, view: string) => data && 'state' in data
  ? Math.min(300_000, data.retryAfterSeconds * 1000 * 2 ** Math.min(6, Math.max(0, (data.attempt ?? 1) - 1))) + parseInt(view.slice(0, 4), 16) % 2500
  : 30_000

export function logFacetAccessLost(error: unknown) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403 || error.code === 'LOG_FACET_VISIBILITY_CHANGED')
}

export function logFacetRefreshRetry(error: unknown, failures: number) {
  if (!(error instanceof ApiError) || logFacetAccessLost(error)) return false
  const status = error.status ?? 0
  if (status !== 429 && (status < 500 || status > 599) && !(status === 0 && error.code === 'NETWORK_UNAVAILABLE')) return false
  const earliest = (error.retryAfter ?? 0) * 1000
  // Never shorten a server's delay; do not arm a timeout the browser cannot represent.
  if (earliest > 2_147_483_647) return false
  const backoff = Math.min(300_000, 30_000 * 2 ** Math.min(4, Math.max(0, failures - 1)))
  return Math.max(status === 429 ? 60_000 : 0, earliest, backoff)
}
