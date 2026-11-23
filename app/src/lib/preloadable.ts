import { createContext, createElement, useContext, useEffect, useReducer, type ComponentType, type ReactNode } from 'react'

// What a page shows while its chunk downloads: the route skeleton in the dashboard, a loader elsewhere.
export const ChunkFallback = createContext<ReactNode>(null)

// A deploy since this page loaded removes chunks the tab hasn't fetched yet. Background warm-ups (idle sweep, hover)
// swallow the error and mark the build stale; only a real navigation the user triggered reloads/navigates to the new
// build, never over unsaved edits guarded by useLeaveGuard, and at most once a minute so real errors reach the boundary.
const RELOADED = 'nightmail.chunk-reload'
let reloading = false
let buildStale = false
let activeChunkNavigations = 0
let dirtyGuards = 0

/** Marks that a page currently holds unsaved edits guarded by useLeaveGuard; suppresses automatic chunk reloads. */
export function registerDirtyGuard(): () => void {
  dirtyGuards += 1
  return () => { dirtyGuards = Math.max(0, dirtyGuards - 1) }
}

function reloadForNewBuild() {
  if (reloading) return true
  if (dirtyGuards > 0 || !navigator.onLine) return false
  try {
    if (Date.now() - Number(sessionStorage.getItem(RELOADED)) < 60_000) return false
    sessionStorage.setItem(RELOADED, String(Date.now()))
  } catch { return false }
  reloading = true
  window.dispatchEvent(new Event('nightmail:reloading'))
  window.location.reload()
  return true
}

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', event => {
    buildStale = true
    // Background warm-ups (idle sweep / hover) must never reload the page or discard typed text.
    if (activeChunkNavigations > 0 && dirtyGuards === 0) {
      if (reloadForNewBuild()) event.preventDefault()
    } else {
      event.preventDefault()
    }
  })
}

if (typeof document !== 'undefined') {
  // Bubble-phase listener runs AFTER useLeaveGuard's capture-phase listener: if a page has unsaved edits,
  // useLeaveGuard intercepts the click first (defaultPrevented = true) and asks before leaving.
  document.addEventListener('click', event => {
    if (!buildStale || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return
    const url = new URL(link.href, window.location.href)
    if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return
    event.preventDefault()
    reloading = true
    window.dispatchEvent(new Event('nightmail:reloading'))
    window.location.assign(url.href)
  })
}

// A route chunk whose pages never suspend. React holds a revealed Suspense fallback for at least 300 ms,
// so a page that suspended on a cold load (its chunk still downloading) showed its skeleton, and held back
// its first requests, until that window ended even when the chunk arrived sooner. A page here renders the
// nearest ChunkFallback until its chunk is in, then itself at once. A failed load during a real navigation
// reloads the page for a new build (above), else throws to the error boundary, as React.lazy would.
export function chunk<Module>(load: () => Promise<Module>) {
  let loaded: Module | undefined
  let failure: unknown
  let pending: Promise<Module> | undefined
  const listeners = new Set<() => void>()
  const settle = () => listeners.forEach(listener => listener())
  const preload = () => pending ??= load().then(
    module => { loaded = module; failure = undefined; settle(); return module },
    error => { pending = undefined; failure = error; buildStale = true; settle(); throw error },
  )
  const page = <Props extends object>(pick: (module: Module) => ComponentType<Props>) => function ChunkPage(props: Props) {
    const fallback = useContext(ChunkFallback)
    const [, rerender] = useReducer((n: number) => n + 1, 0)
    useEffect(() => {
      if (loaded) return
      activeChunkNavigations += 1
      let active = true
      const release = () => { if (active) { active = false; activeChunkNavigations = Math.max(0, activeChunkNavigations - 1) } }
      listeners.add(rerender)
      preload().then(release, release)
      if (loaded || failure !== undefined) { release(); rerender() }
      return () => { release(); listeners.delete(rerender) }
    }, [])
    if (loaded) return createElement(pick(loaded), props)
    if (failure !== undefined) { if (reloadForNewBuild()) return fallback; throw failure }
    return fallback
  }
  return { preload, page }
}
