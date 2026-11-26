import { lazy, use, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { fontsReady, PricePage as Calculator, useShellTakeover } from '..'
import { comparisons } from '../compare'
import { PRICE_PAGES } from '../pages'
import { hubDoc } from './hub'

// (Named as ../index.tsx's chunk is, pricing-…, so the price pages' cache rule still finds it: price-pages.ts, priceFirstFiles.)
// The app's price pages with the comparisons' new look (VERDICT_PAGES, page/switch.ts: app/price-pages.ts's verdictApp
// gives App.tsx this module for features/pricing in that build): a comparison, and /compare, drawn from their data
// (view.tsx) when the app reaches them from another of its pages, as their own HTML draws them. Everything else is the price pages' own (../index.tsx: the calculator, a comparison not found).
const view = () => import('./view')
const ComparisonView = lazy(() => view().then(m => ({ default: m.ComparisonView })))
const HubView = lazy(() => view().then(m => ({ default: m.HubView })))
const DocView = lazy(() => view().then(m => ({ default: m.DocView })))

/** As ../index.tsx's PriceFrame: the fonts first (text drawn before them rewraps), the tab's title, and the page's place:
 *  it takes over from the page's painted HTML (useShellTakeover: the reader's scroll, focus and a press made while the
 *  app loaded carry over), or opens at its top. */
function Frame({ title, children }: { title: string; children: ReactNode }) {
  use(fontsReady)
  useEffect(() => { document.title = title }, [title])
  const painted = useShellTakeover(), opened = useRef(false)
  useLayoutEffect(() => { if (opened.current || !painted) window.scrollTo(0, 0); opened.current = true }, [title, painted])
  return children
}

export function PricePage() {
  const { pathname } = useLocation()
  const at = pathname.replace(/\/+$/, '')
  if (at === '/compare' || at === '/compare/with-set') return <Frame title={hubDoc().searchTitle}><HubView set={at === '/compare/with-set'} /></Frame>
  const vendor = at.startsWith('/compare/') ? at.slice('/compare/'.length) : null
  const comparison = vendor !== null && Object.hasOwn(comparisons, vendor) ? comparisons[vendor]! : null
  if (comparison) return <Frame title={PRICE_PAGES.find(page => page.comparison === comparison)!.searchTitle}><ComparisonView comparison={comparison} /></Frame>
  // A vendor's pricing or alternatives page (docs/), or (another address under them) not found, as ../index.tsx says it.
  const doc = PRICE_PAGES.find(page => page.path === at)?.doc
  if (doc) return <Frame title={doc.searchTitle}><DocView doc={doc} /></Frame>
  return <Calculator />
}
