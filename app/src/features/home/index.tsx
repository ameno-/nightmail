import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { productName } from '../../../../api/src/brand'
import { FactoryHome } from './factory-home'
import { SorterHome } from './sorter-home'

/** What the page's button does: signs a visitor in (Get started), or opens the dashboard for someone signed in. */
export type HomeStart = { signedIn: true } | { signedIn: false; onSignIn: () => void; onSignInIntent: (event: { button: number }) => void; busy: boolean }
export type HomeProps = { start: HomeStart; notice?: ReactNode }

// Which homepage a window gets, by its shape: an upright one (a phone, a tablet held upright, a tall narrow window) the
// factory as a phone sees it, in its tall frame; a desktop's (a pointer that hovers, and room for the wide frame with
// the button in it) the factory in its wide frame (factory-home.tsx); anything else (a phone on its side, a short or
// narrow wide window, a tablet on its side) the sorter (sorter-home.tsx), which is laid out for any shape. Decided
// before the first paint, and again as the window changes. `?home=sorter` shows the sorter anywhere.
const UPRIGHT = '(max-aspect-ratio: 4/5)', DESKTOP = '(min-width: 1024px) and (min-height: 600px) and (hover: hover)'
type Shown = 'phone' | 'desktop' | 'sorter'
const shown = (): Shown => new URLSearchParams(location.search).get('home') === 'sorter' ? 'sorter' : matchMedia(UPRIGHT).matches ? 'phone' : matchMedia(DESKTOP).matches ? 'desktop' : 'sorter'
const watch = (changed: () => void) => {
  const queries = [UPRIGHT, DESKTOP].map(query => matchMedia(query))
  for (const query of queries) query.addEventListener('change', changed)
  return () => { for (const query of queries) query.removeEventListener('change', changed) }
}

// The homepage, signed in or out.
export function HomePage(props: HomeProps) {
  const signedIn = props.start.signedIn
  const home = useSyncExternalStore(watch, shown)
  useEffect(() => { document.title = `${productName.toLowerCase()} · Email infrastructure` }, [])
  // A visitor's first screen after signing in: fetch its code while they read, so it is already cached on return.
  // (Signed in, Overview's code and data load only when the button is about to be pressed.)
  useEffect(() => {
    if (signedIn) return
    const load = () => void import('../onboarding').catch(() => {})
    if (typeof requestIdleCallback === 'function') { const idle = requestIdleCallback(load, { timeout: 3000 }); return () => cancelIdleCallback(idle) }
    const timer = setTimeout(load, 1500); return () => clearTimeout(timer)
  }, [signedIn])
  return home === 'sorter' ? <SorterHome {...props} /> : <FactoryHome key={home} format={home} {...props} />
}
