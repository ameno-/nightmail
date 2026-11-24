import type { CSSProperties, Ref } from 'react'
import { ArrowRight, LoaderCircle } from 'lucide-react'

/** Get started, a visitor's way in: it signs in (start.tsx, StartButton). Here on its own, without the session or the
 *  dashboard's prefetching, so a page painted before any of the app's code can show it as it will be (pricing/prerender.tsx). */
export function GetStartedButton({ className, style, ref, busy = false, onSignIn, onSignInIntent }: { className: string; style?: CSSProperties; ref?: Ref<HTMLButtonElement>; busy?: boolean; onSignIn?: () => void; onSignInIntent?: (event: { button: number }) => void }) {
  return <button type="button" className={className} ref={ref} style={style} disabled={busy} aria-busy={busy || undefined} data-busy={busy || undefined} onClick={onSignIn} onPointerDown={onSignInIntent}>
    <span className="srt-cta-label">Get started{busy ? <LoaderCircle className="ui-spinner" size={16} aria-hidden="true" /> : <ArrowRight className="srt-cta-arrow" size={16} strokeWidth={2} aria-hidden="true" />}</span>
  </button>
}
