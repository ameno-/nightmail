import { useEffect, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from 'react-router'
import type { Identity } from '../data/types'
import { analytics } from '../lib/analytics'
import { routeTemplateOf } from '../lib/routes'

// Starts the page's analytics (lib/analytics.ts) once the API says whether they are on: /v1/me signed in, /health on a
// signed-out page (the homepage and sign-in). A page view names its route template, never its path.
declare const __NIGHTMAIL_BUILD__: string
const build = typeof __NIGHTMAIL_BUILD__ === 'string' ? __NIGHTMAIL_BUILD__ : null
let viewed: string | undefined
export function Analytics({ identity, signedOut }: { identity: Identity | null; signedOut: boolean }) {
  const { pathname } = useLocation()
  const health = useQuery({ queryKey: ['analytics-health'], enabled: signedOut && !identity, staleTime: Infinity, gcTime: Infinity, retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch('/health', { signal, headers: { Accept: 'application/json' } })
      return response.ok && ((await response.json()) as { analytics?: boolean }).analytics === true
    } })
  useEffect(() => {
    if (identity) analytics().configure({ enabled: identity.analytics === true, ws: identity.workspaceId, uid: identity.id, app: build })
    else if (signedOut && health.data !== undefined) analytics().configure({ enabled: health.data, ws: null, uid: null, app: build })
  }, [identity?.analytics, identity?.workspaceId, identity?.id, signedOut, health.data])
  useEffect(() => {
    if (pathname === viewed) return
    viewed = pathname
    analytics().route(routeTemplateOf(pathname))
  }, [pathname])
  return null
}

/** A dialog or sheet while it is open: its name (data-analytics style) or its title, if the title is plain text. */
export function useDialogAnalytics(open: boolean, title: ReactNode, name?: string) {
  const label = typeof title === 'string' ? title : null
  useEffect(() => {
    if (!open) return
    const opened = Date.now()
    analytics().dialog(true, label, name)
    return () => analytics().dialog(false, label, name, Date.now() - opened)
  }, [open])
}
/** A field showing a validation error: its label and a static field ID, never what was typed. */
export function useFieldErrorAnalytics(error: unknown, label: ReactNode, field?: string) {
  const failing = Boolean(error)
  useEffect(() => { if (failing) analytics().fieldError(label, field) }, [failing])
}
