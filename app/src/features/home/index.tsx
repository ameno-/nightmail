import { useEffect, type ReactNode } from 'react'
import { productName } from '../../../../api/src/brand'
import { SorterHome } from './sorter-home'

export type HomeProps = { onSignIn: () => void; onSignInIntent: (event: { button: number }) => void; busy: boolean; notice?: ReactNode }

// The signed-out homepage: the sorter (sorter-home.tsx).
export function HomePage(props: HomeProps) {
  useEffect(() => { document.title = `${productName.toLowerCase()} · Email infrastructure` }, [])
  // The first screen after signing in: fetch its code while the visitor reads, so it is already cached on return.
  useEffect(() => {
    const load = () => void import('../onboarding').catch(() => {})
    if (typeof requestIdleCallback === 'function') { const idle = requestIdleCallback(load, { timeout: 3000 }); return () => cancelIdleCallback(idle) }
    const timer = setTimeout(load, 1500); return () => clearTimeout(timer)
  }, [])
  return <SorterHome {...props} />
}
