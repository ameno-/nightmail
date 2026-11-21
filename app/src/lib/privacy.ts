import { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'

// Privacy mode: whether the dashboard masks email addresses (components/PrivateAddress.tsx). It is off by default, so
// addresses render in full, and turning it on (the sidebar switch, ⇧P) is remembered per browser. The root element carries
// data-privacy="on" while addresses are masked. Anything that leaves the browser (a UI note's capture) calls forceMask(),
// which masks whatever this browser's setting, until it is released.
// It was on by default under nightmail.privacy, which stored only "off": a browser that had chosen it on can't be told
// from one that never chose, so that key is dropped and every browser starts off once.
const storageKey = 'nightmail.privacy.v2', legacyKey = 'nightmail.privacy'
const listeners = new Set<() => void>()
const saved = () => { try { return localStorage.getItem(storageKey) === 'on' } catch { return false } }
let preference = saved(), forced = 0

const masking = () => preference || forced > 0
function publish() {
  if (masking()) document.documentElement.dataset.privacy = 'on'
  else delete document.documentElement.dataset.privacy
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
if (typeof window !== 'undefined') {
  try { localStorage.removeItem(legacyKey) } catch { /* Nothing to drop. */ }
  publish()
  window.addEventListener('storage', event => { if (event.key === storageKey || event.key === null) { preference = saved(); publish() } })
}

export function setPrivacy(on: boolean) {
  preference = on
  try { if (on) localStorage.setItem(storageKey, 'on'); else localStorage.removeItem(storageKey) } catch { /* Kept for this page only. */ }
  publish()
}
export const togglePrivacy = () => setPrivacy(!preference)
/** This browser's setting, for the switch. */
export const usePrivacy = () => useSyncExternalStore(subscribe, () => preference)
/** Whether addresses are masked now: the setting, or a capture holding forceMask(). */
export const useMasking = () => useSyncExternalStore(subscribe, masking)
/**
 * Masks every address until the returned release is called, whatever the setting. The page is re-rendered masked
 * before this returns, so a capture can read the DOM straight away. Call it from an event handler, not during render.
 */
export function forceMask(): () => void {
  forced++
  flushSync(publish)
  let released = false
  return () => { if (released) return; released = true; forced--; publish() }
}
