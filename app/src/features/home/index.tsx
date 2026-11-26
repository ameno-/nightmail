import { useEffect, type ReactNode } from 'react'
import { productName } from '../../../../api/src/brand'
import { TvHome } from './tv/tv'

/** What the page's button does: signs a visitor in (Get started), or opens the dashboard for someone signed in. */
export type HomeStart = { signedIn: true } | { signedIn: false; onSignIn: () => void; onSignInIntent: (event: { button: number }) => void; busy: boolean }
export type HomeProps = { start: HomeStart; notice?: ReactNode }

// The homepage, signed in or out: one screen, a television playing what email costs (tv/tv.tsx).
export function HomePage(props: HomeProps) {
  const signedIn = props.start.signedIn
  useEffect(() => { document.title = `${productName.toLowerCase()} · Email for $0.20 per 1,000` }, [])
  // A visitor's first screen after signing in: fetch its code while they read, so it is already cached on return.
  // (Signed in, Overview's code and data load only when the button is about to be pressed.) When the browser is idle,
  // so it does not take the picture's bandwidth.
  useEffect(() => {
    if (signedIn) return
    const load = () => void import('../onboarding').catch(() => {})
    if (typeof requestIdleCallback === 'function') { const idle = requestIdleCallback(load, { timeout: 4000 }); return () => cancelIdleCallback(idle) }
    const timer = setTimeout(load, 2500)
    return () => clearTimeout(timer)
  }, [signedIn])
  return <TvHome {...props} />
}
