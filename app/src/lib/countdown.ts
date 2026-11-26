import { useEffect, useReducer } from 'react'
import { AUTH_STATE_SECONDS } from '../../../api/src/auth-state'

// Waits are kept on performance.now()'s clock, which never goes backwards and ignores changes to the system clock, so
// moving the clock can't stretch one; and what is left of one is clamped to the API's own maximum on every read.
const MAX_MS = AUTH_STATE_SECONDS * 1000

/** A wait as m:ss, for a button that counts it down (shown with tabular figures, so its width holds). */
export const countdown = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
/** How long a 429 asks to wait, in seconds: Retry-After, else the error's details (the API puts both), else the API's
 *  maximum; never more than that maximum. */
export function waitSeconds(error: { retryAfter?: number; details?: Record<string, unknown>[] }) {
  const asked = error.retryAfter ?? error.details?.[0]?.retryAfterSeconds
  return typeof asked === 'number' && asked > 0 ? Math.min(asked, AUTH_STATE_SECONDS) : AUTH_STATE_SECONDS
}
/** When a wait of `seconds` that starts now ends, on performance.now()'s clock. */
export const waitDeadline = (seconds: number) => performance.now() + Math.min(Math.max(0, seconds), AUTH_STATE_SECONDS) * 1000
/** What is left of a wait, in ms: never below 0, never above the API's maximum. */
export const waitLeft = (deadline: number | null | undefined) => deadline == null ? 0 : Math.min(MAX_MS, Math.max(0, deadline - performance.now()))
/** Whole seconds left of a wait, re-rendering four times a second while there are any. */
export function useSecondsLeft(deadline: number | null | undefined) {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  const left = Math.ceil(waitLeft(deadline) / 1000)
  useEffect(() => {
    if (!left) return
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [deadline, left > 0])
  return left
}
/** A wait kept for the tab, so a reload doesn't ask again: stored as the system clock's time it ends, or removed. */
export function keepWait(key: string, deadline: number | null) {
  const left = waitLeft(deadline)
  try { if (left) sessionStorage.setItem(key, String(Date.now() + left)); else sessionStorage.removeItem(key) }
  catch { /* Held for this page only. */ }
}
/** A kept wait, back on performance.now()'s clock, only while what is left is a real time no longer than the API's
 *  maximum. Anything else (a value from elsewhere, or a system clock moved since) is dropped: the button is pressable,
 *  and the next press asks the API, whose answer is the only authority. */
export function keptWait(key: string) {
  try {
    const stored = sessionStorage.getItem(key)
    if (stored === null) return null
    const left = Number(stored) - Date.now()
    if (left > 0 && left <= MAX_MS) return performance.now() + left
    sessionStorage.removeItem(key)
  } catch { /* Nothing kept. */ }
  return null
}
