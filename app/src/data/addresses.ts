import { useMemo } from 'react'
import { useInfiniteQuery, useQueries } from '@tanstack/react-query'
import { useApi } from './context'
import type { InboundAddress } from './types'

/**
 * Shared paginated + server-searchable receiving-address picker hook.
 * Loads 100 addresses per page (never looping 10 pages automatically), supports server-side search via ?q=,
 * and keeps previous results on screen while typing.
 */
export function useAddressOptions({ enabled = true, search = '', kind }: { enabled?: boolean; search?: string; kind?: 'address' | 'inbox' } = {}) {
  const api = useApi()
  const q = search.trim()
  const query = useInfiniteQuery({
    queryKey: ['nightmail', 'inbound-addresses', 'options', kind ?? 'all', q],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.inbound.addresses({ kind, search: q || undefined, cursor: pageParam }, signal),
    getNextPageParam: last => last.nextCursor ?? undefined,
    placeholderData: previous => previous,
    staleTime: 60_000,
    retry: false,
  })
  const items = useMemo(() => {
    const pages = query.data?.pages ?? []
    if (pages.length <= 1) return pages[0] ?? []
    const seen = new Set<string>(), out: InboundAddress[] = []
    for (const page of pages) for (const item of page) if (!seen.has(item.id)) { seen.add(item.id); out.push(item) }
    return out
  }, [query.data])
  return {
    items,
    hasMore: Boolean(query.hasNextPage),
    loadingMore: query.isFetchingNextPage,
    loadMore: () => { void query.fetchNextPage() },
    isPending: query.isPending,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  }
}

/**
 * Resolves saved or referenced address IDs that are not on the currently loaded page(s) via cached per-ID lookups
 * (GET /v1/inbound/addresses/:id), so saved values past #100 are never hidden, dropped on save, or shown as raw mbx_ IDs.
 */
export function useResolvedAddresses(ids: readonly (string | null | undefined)[], loaded: readonly InboundAddress[], enabled = true) {
  const api = useApi()
  const loadedIds = useMemo(() => new Set(loaded.map(item => item.id)), [loaded])
  // Only look up opaque address IDs (skip email aliases containing '@' and anything already loaded).
  const missing = useMemo(() => {
    const unique = new Set<string>()
    for (const id of ids) if (id && !id.includes('@') && !loadedIds.has(id)) unique.add(id)
    return [...unique].sort()
  }, [ids, loadedIds])
  const results = useQueries({
    queries: enabled ? missing.map(id => ({
      queryKey: ['nightmail', 'inbound-address', id] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => api.inbound.address(id, signal),
      staleTime: 60_000,
      retry: false,
    })) : [],
  })
  const items = useMemo(() => results.map(r => r.data).filter((item): item is InboundAddress => Boolean(item)), [results])
  const byId = useMemo(() => new Map<string, InboundAddress>([...loaded, ...items].map(item => [item.id, item])), [loaded, items])
  const pending = enabled && missing.length > 0 && results.some(r => r.isPending)
  return { items, byId, pending }
}

/** Merges resolved saved addresses ahead of loaded picker pages (deduplicated by ID), so saved off-page choices always show. */
export function mergeAddresses(resolved: readonly InboundAddress[], loaded: readonly InboundAddress[]): InboundAddress[] {
  if (!resolved.length) return [...loaded]
  const seen = new Set<string>(), out: InboundAddress[] = []
  for (const item of resolved) if (!seen.has(item.id)) { seen.add(item.id); out.push(item) }
  for (const item of loaded) if (!seen.has(item.id)) { seen.add(item.id); out.push(item) }
  return out
}
