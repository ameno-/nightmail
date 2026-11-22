import { useEffect, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useApiDef, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { Identity } from '../../data/types'

// A newsletter is a list with a sender; its issues are the campaigns sent to that list (docs: /v1/newsletters).
export type NamedNewsletter = { id: string; name: string }
export const newsletterPath = (id: string) => `/newsletters/${encodeURIComponent(id)}`
export const readersPath = (id: string) => `/audience/lists/${encodeURIComponent(id)}`
export const newIssuePath = (id: string) => `/campaigns/new?newsletter=${encodeURIComponent(id)}`
/** A newsletter's issues: the campaigns to its list, newest first. The page and its warm-up ask for exactly this. */
export const ISSUES_PAGE_SIZE = 12
export const issuesRequest = (listId: string, page = 1) => ({ listId, archived: false, page, pageSize: ISSUES_PAGE_SIZE })

// /v1/me names the workspace's newsletters (at most four), so the sidebar has them at first paint. Owners and admins
// only: a member's dashboard is as it was.
const none: NamedNewsletter[] = []
export function useNewsletters(): NamedNewsletter[] {
  const { canAdminister } = useWorkspaceAccess()
  const list = useSession()?.identity?.newsletters
  return canAdminister && list ? list : none
}
/**
 * The sidebar's rule. Up to three newsletters are each an item under their own name, where Campaigns sits (just above
 * it); more than three are one item, Newsletters, that lists them. Campaigns stays, and holds the campaigns that are
 * no newsletter's issue.
 */
export const SIDEBAR_NEWSLETTERS = 3
export const newsletterLinks = (list: NamedNewsletter[]): (readonly [path: string, title: string])[] =>
  list.length > SIDEBAR_NEWSLETTERS ? [['/newsletters', 'Newsletters']] : list.map(item => [newsletterPath(item.id), item.name] as const)

/** The newsletter a list is, if it is one. /v1/me names four at most: past that, the full list answers. */
export function useNewsletterOf(listId: string | null | undefined): NamedNewsletter | null {
  const known = useNewsletters()
  const found = listId ? known.find(item => item.id === listId) : undefined
  const all = useApiDef(queries.newsletters(), { enabled: Boolean(listId) && !found && known.length >= 4 })
  return found ?? all.data?.find(item => item.id === listId) ?? null
}

/** After a newsletter is created here, the sidebar has it at once (the session's copy of /v1/me). */
export function useRememberNewsletter() {
  const cache = useQueryClient()
  return (created: NamedNewsletter) => { cache.setQueryData<Identity>(['identity'], identity => identity && { ...identity, newsletters: [...(identity.newsletters ?? []).filter(item => item.id !== created.id), created].slice(0, 4) }) }
}

// The newsletter whose issue is open in the composer or its review: the sidebar marks it, not Campaigns.
let shown: string | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const show = (id: string | null) => { if (shown !== id) { shown = id; listeners.forEach(listener => listener()) } }
export function useShowNewsletter(id: string | null) {
  useEffect(() => { if (!id) return; show(id); return () => { if (shown === id) show(null) } }, [id])
}
export const useShownNewsletter = () => useSyncExternalStore(subscribe, () => shown)

// What the issues table looked like last time (rows, and whether it had opens and clicks), so its skeleton matches.
type Shape = { rows: number; engagement: boolean }
const shapeKey = (id: string) => `nightmail.newsletter.issues:${id}`
export function issuesShape(id: string): Shape {
  try { const saved = JSON.parse(localStorage.getItem(shapeKey(id)) ?? 'null') as Shape | null; if (saved && Number.isInteger(saved.rows)) return { rows: Math.min(ISSUES_PAGE_SIZE, Math.max(1, saved.rows)), engagement: Boolean(saved.engagement) } } catch { /* The default then. */ }
  return { rows: 6, engagement: true }
}
export function rememberIssuesShape(id: string, shape: Shape) { try { localStorage.setItem(shapeKey(id), JSON.stringify(shape)) } catch { /* The default next time. */ } }
