import { useSyncExternalStore } from 'react'

// Whether this browser hid Overview's detail column (beside the main column only, wider than 960px; in one column it
// always shows). The root element carries data-overview-panel="hidden" while it is hidden, and overview.css lays out
// the page and its route skeleton from that. public/theme.js sets it before the first paint, so nothing moves on load.
const KEY = 'nightmail.overview-panel'
const listeners = new Set<() => void>()
const saved = () => { try { return localStorage.getItem(KEY) === 'hidden' } catch { return false } }
const apply = (hidden: boolean) => { if (hidden) document.documentElement.dataset.overviewPanel = 'hidden'; else delete document.documentElement.dataset.overviewPanel }
const isHidden = () => document.documentElement.dataset.overviewPanel === 'hidden'
const emit = () => { for (const listener of listeners) listener() }
if (typeof window !== 'undefined') {
  apply(saved())
  window.addEventListener('storage', event => { if (event.key === KEY || event.key === null) { apply(saved()); emit() } })
}

export function setPanelHidden(hidden: boolean) {
  if (hidden === isHidden()) return
  apply(hidden)
  try { if (hidden) localStorage.setItem(KEY, 'hidden'); else localStorage.removeItem(KEY) } catch { /* Kept for this page only. */ }
  emit()
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const usePanelHidden = () => useSyncExternalStore(subscribe, isHidden, () => false)
