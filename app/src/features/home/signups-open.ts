import { useSyncExternalStore } from 'react'

// Whether a new person can sign up now (api/src/public-stats.ts, GET /v1/public/signups, cached for a minute): when no
// place is open, a visitor's way in says Join the waitlist. Asked once a page load, by the first visitor's button that
// shows; until it answers, and if it fails, sign-ups count as open, as the page was painted.
let full = false, asked = false
const listeners = new Set<() => void>()
function subscribe(changed: () => void) {
  listeners.add(changed)
  if (!asked) {
    asked = true
    void fetch('/v1/public/signups', { headers: { Accept: 'application/json' } }).then(response => response.ok ? response.json() : null).then((body: { open?: unknown } | null) => {
      if (body?.open !== false) return
      full = true
      for (const listener of listeners) listener()
    }, () => {})
  }
  return () => { listeners.delete(changed) }
}
const none = () => () => {}
/** True once the API says no place is open. `visitor` false (someone signed in) never asks. */
export const useSignupsFull = (visitor = true) => useSyncExternalStore(visitor ? subscribe : none, () => visitor && full, () => false)
