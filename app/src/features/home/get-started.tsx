import type { CSSProperties, Ref } from 'react'
import { ArrowRight, LoaderCircle } from 'lucide-react'
import { countdown, useSecondsLeft } from '../../lib/countdown'

/** Get started, a visitor's way in: it signs in (start.tsx, StartButton). Here on its own, without the session or the
 *  dashboard's prefetching, so a page painted before any of the app's code can show it as it will be (pricing/prerender.tsx).
 *  full: no place is open (signups-open.ts), so signing in joins the waitlist, and the button says so. Both labels are
 *  always laid out, one over the other, and only the one shown is visible: the button keeps the longer one's width
 *  from the first paint, so the swap after load moves nothing. waitUntil: a start refused at the cap (data/context.tsx
 *  holdSignIn) holds the button, disabled, counting the wait down in a third label laid out the same way. */
export function GetStartedButton({ className, style, ref, busy = false, full = false, waitUntil = null, onSignIn, onSignInIntent }: { className: string; style?: CSSProperties; ref?: Ref<HTMLButtonElement>; busy?: boolean; full?: boolean; waitUntil?: number | null; onSignIn?: () => void; onSignInIntent?: (event: { button: number }) => void }) {
  const left = useSecondsLeft(waitUntil)
  const icon = busy ? <LoaderCircle className="ui-spinner" size={16} aria-hidden="true" /> : <ArrowRight className="srt-cta-arrow" size={16} strokeWidth={2} aria-hidden="true" />
  return <button type="button" className={className} ref={ref} style={style} disabled={busy || left > 0} aria-busy={busy || undefined} data-busy={busy || undefined} data-cta="sign-in" data-full={full || undefined} onClick={onSignIn} onPointerDown={onSignInIntent}>
    <span className="srt-cta-labels">
      <span className="srt-cta-label" data-off={full || left ? '' : undefined}>Get started{icon}</span>
      <span className="srt-cta-label srt-cta-wait" data-off={full && !left ? undefined : ''}>Join the waitlist{icon}</span>
      <span className="srt-cta-label srt-cta-wait srt-cta-retry" data-off={left ? undefined : ''}>Try again in {countdown(left)}</span>
    </span>
  </button>
}
/** What a full Nightmail means for a visitor, under the way in. Always laid out, and visible only when `full`, so it
 *  appearing after load moves nothing. */
export function WaitlistLine({ className, full = false }: { className: string; full?: boolean }) {
  return <p className={`srt-wait-line ${className}`} data-off={full ? undefined : ''}>Full for now. Join the waitlist and we’ll email you.</p>
}
