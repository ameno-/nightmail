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
// Reading one address while privacy mode is on: hold ⇧ (Shift) and point at it, or hold ⇧ while its row is highlighted by
// the keys (components/PrivateAddress.tsx). Pointing alone, or J and K alone, never reveals one, so moving across a list
// on a shared screen shows nothing. The root carries data-peek
// while ⇧ is held, for fields that blur with CSS (app.css .private-field). ⇧ held to type a capital in a field doesn't count.
const peekListeners = new Set<() => void>()
let peeking = false
function setPeek(on: boolean) {
  if (on === peeking) return
  peeking = on
  if (on) document.documentElement.dataset.peek = ''
  else delete document.documentElement.dataset.peek
  for (const listener of peekListeners) listener()
}
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', event => { if (event.key === 'Shift') setPeek(!typing(event.target)); else if (!event.shiftKey) setPeek(false) }, true)
  window.addEventListener('keyup', event => { if (event.key === 'Shift') setPeek(false) }, true)
  // A pointer event says whether ⇧ is down, including one pressed while the window wasn't focused.
  window.addEventListener('pointermove', event => setPeek(event.shiftKey && !typing(document.activeElement)), { capture: true, passive: true })
  window.addEventListener('blur', () => setPeek(false))
}
const subscribePeek = (listener: () => void) => { peekListeners.add(listener); return () => { peekListeners.delete(listener) } }
/** Whether ⇧ is held for reading the address under the pointer; `read` narrows the snapshot (only a hovered address re-renders). */
export const usePeek = (read: (peeking: boolean) => boolean = on => on) => useSyncExternalStore(subscribePeek, () => read(peeking))
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
