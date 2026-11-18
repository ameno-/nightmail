import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { productName } from '../../../../api/src/brand'
import { FactoryHome } from './factory-home'
import { SorterHome } from './sorter-home'

/** What the page's button does: signs a visitor in (Get started), or opens the dashboard for someone signed in. */
export type HomeStart = { signedIn: true } | { signedIn: false; onSignIn: () => void; onSignInIntent: (event: { button: number }) => void; busy: boolean }
export type HomeProps = { start: HomeStart; notice?: ReactNode }

// Which homepage a window gets: a desktop's (a pointer that hovers, and room for the frame with the button in it) the
// factory (factory-home.tsx); a phone's or a tablet's, and a window under 1024 × 600, the sorter (sorter-home.tsx).
// Decided before the first paint, and again as the window changes. `?home=sorter` shows the sorter on a desktop too.
const DESKTOP = '(min-width: 1024px) and (min-height: 600px) and (hover: hover)'
const desktop = () => matchMedia(DESKTOP).matches && new URLSearchParams(location.search).get('home') !== 'sorter'
const watch = (changed: () => void) => { const query = matchMedia(DESKTOP); query.addEventListener('change', changed); return () => query.removeEventListener('change', changed) }

// The homepage, signed in or out.
export function HomePage(props: HomeProps) {
  const signedIn = props.start.signedIn
  const factory = useSyncExternalStore(watch, desktop)
  useEffect(() => { document.title = `${productName.toLowerCase()} · Email infrastructure` }, [])
  // A visitor's first screen after signing in: fetch its code while they read, so it is already cached on return.
  // (Signed in, Overview's code and data load only when the button is about to be pressed.)
  useEffect(() => {
    if (signedIn) return
    const load = () => void import('../onboarding').catch(() => {})
    if (typeof requestIdleCallback === 'function') { const idle = requestIdleCallback(load, { timeout: 3000 }); return () => cancelIdleCallback(idle) }
    const timer = setTimeout(load, 1500); return () => clearTimeout(timer)
  }, [signedIn])
  return factory ? <FactoryHome {...props} /> : <SorterHome {...props} />
}
