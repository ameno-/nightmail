import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useApiDef } from '../../data/context'
import { facetInstant, facetPollMs, foldableFacetView, logFacetAccessLost, logFacetRefreshRetry } from '../../data/log-facets'
import { queries } from '../../data/queries'
import type { LogCounts, LogFacetFilters, LogFacetRead, LogVisibility, TimeRange } from '../../data/types'

type Published = Extract<LogFacetRead, { counts: LogCounts }>
const published = (result?: LogFacetRead) => result && ('state' in result ? result.last ?? undefined : result.counts != null ? result : undefined)
const newer = (current?: Published, next?: Published) => {
  if (!next || !current) return next ?? current
  if (!current.asOf) return next
  return next.asOf && facetInstant(next.asOf) > facetInstant(current.asOf) ? next : current
}

// The counts the rail last showed for each set of filters, by scope (account, workspace and role: a new one never sees
// another's). Coming back to Logs (Back from an email) shows them at once, beside the cached rows, while the next counts
// load, instead of dashes first; the next counts replace them as they arrive.
const shownCuts = new Map<string, Published>()
const remember = (key: string, cut: Published | undefined) => {
  shownCuts.delete(key)
  if (!cut) return
  shownCuts.set(key, cut)
  if (shownCuts.size > 16) shownCuts.delete(shownCuts.keys().next().value!)
}

/** Register before the commit's next paint. Its rAF queues a task for AFTER that render step.
 * Rows (and then the historical digits) get their own frame without waiting two extra rAFs. */
function usePainted(view: string, ready: boolean) {
  const [painted, setPainted] = useState<string>()
  useLayoutEffect(() => {
    if (!ready || painted === view) return
    let after: number | undefined
    const frame = requestAnimationFrame(() => { after = window.setTimeout(() => setPainted(view), 0) })
    return () => { cancelAnimationFrame(frame); window.clearTimeout(after) }
  }, [ready, view, painted])
  return painted === view
}

export function useLogFacets({ filters, range, visibility, scope, railed, blank, rowsReady, rowError }: {
  filters: LogFacetFilters; range: TimeRange; visibility: LogVisibility; scope: string | null
  railed: boolean; blank: boolean; rowsReady: boolean; rowError: unknown
}) {
  const cache = useQueryClient()
  const rolling = foldableFacetView(filters)
  const semantic = JSON.stringify([range, filters])
  // No reuse across a filter round trip, a newly visible rail, or a new account/workspace/role.
  const view = useMemo(() => crypto.randomUUID(), [scope, semantic, railed, rolling])
  const [revoked, setRevoked] = useState<string | null>(null)
  const blocked = scope !== null && revoked === scope
  const canRead = railed && !blank && scope !== null && !blocked && !logFacetAccessLost(rowError)
  const last = useApiDef(queries.logFacets({ ...filters, mode: 'last', range, visibility }, view), { enabled: canRead && rolling })
  const historical = last.isSuccess ? published(last.data) : undefined
  const rowsPainted = usePainted(view, canRead && rowsReady)
  const digitsPainted = usePainted(view, canRead && rowsPainted && !!historical)
  const fresh = useApiDef(queries.logFacets({ ...filters, mode: 'refresh', range, visibility }, view), {
    enabled: canRead && rowsPainted && !logFacetAccessLost(last.error) &&
      (!rolling || (last.isSuccess || last.isError) && (!historical || digitsPainted)),
    interval: data => facetPollMs(data, view),
    retryInterval: (error, failures) => rolling ? logFacetRefreshRetry(error, failures) : false,
  })
  const denied = logFacetAccessLost(last.error) || logFacetAccessLost(fresh.error) || logFacetAccessLost(rowError)
  useEffect(() => {
    if (!denied || !scope || blocked) return
    setRevoked(scope)
    void cache.invalidateQueries({ queryKey: ['identity'], exact: true })
  }, [denied, scope, blocked, cache])
  useEffect(() => {
    if (!scope) return
    const leaving = () => setRevoked(scope)
    window.addEventListener('nightmail:unauthorized', leaving)
    window.addEventListener('nightmail:account-signed-out', leaving)
    window.addEventListener('nightmail:active-session-ended', leaving)
    return () => {
      window.removeEventListener('nightmail:unauthorized', leaving)
      window.removeEventListener('nightmail:account-signed-out', leaving)
      window.removeEventListener('nightmail:active-session-ended', leaving)
    }
  }, [scope])

  const memory = scope === null ? null : scope + '\n' + semantic
  const [accepted, setAccepted] = useState<{ view: string; cut: Published; shown?: boolean } | undefined>(() => { const cut = memory ? shownCuts.get(memory) : undefined; return cut ? { view, cut, shown: true } : undefined })
  // Counts shown before, for these filters: they need not wait for the rows' own frame.
  const again = accepted?.view === view && accepted.shown === true
  const latest = newer(newer(accepted?.view === view ? accepted.cut : undefined, historical), fresh.isSuccess ? published(fresh.data) : undefined)
  const authorizationLost = denied || blocked
  // A busy server may not have been able to reauthorize a stored band. In that case keep
  // the stable count slots as dashes until a newer, scoped numerical result actually arrives.
  const reply = fresh.dataUpdatedAt >= last.dataUpdatedAt && fresh.data ? fresh.data : last.data
  const pending = reply && 'state' in reply ? reply : undefined
  const cut = !authorizationLost && canRead && (rowsPainted || again) ? (pending ? pending.last ?? undefined : latest) : undefined
  useEffect(() => {
    if (pending && !pending.last && accepted?.view === view) { setAccepted(undefined); if (memory) remember(memory, undefined) }
    else if (cut && (accepted?.view !== view || accepted.cut !== cut)) { setAccepted({ view, cut }); if (memory) remember(memory, cut) }
  }, [view, cut, accepted, pending, memory])
  return { cut, authorizationLost, view }
}
