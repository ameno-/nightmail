import { useEffect, useReducer } from 'react'

/** A wait as m:ss, for a button that counts it down (shown with tabular figures, so its width holds). */
export const countdown = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
/** How long a 429 asks to wait, in seconds: Retry-After, else the error's details (the API puts both), else ten minutes. */
export const waitSeconds = (error: { retryAfter?: number; details?: Record<string, unknown>[] }) =>
  error.retryAfter ?? (typeof error.details?.[0]?.retryAfterSeconds === 'number' ? error.details[0].retryAfterSeconds : 600)
/** Whole seconds until `until` (epoch ms), re-rendering four times a second while there are any; 0 without one. */
export function useSecondsLeft(until: number | null | undefined) {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  const left = until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0
  useEffect(() => {
    if (!left) return
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [until, left > 0])
  return left
}
