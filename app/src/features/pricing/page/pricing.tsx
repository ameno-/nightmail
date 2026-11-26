import { lazy, use, useEffect, useLayoutEffect, type ReactNode } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { PricePage as Calculator } from '..'
import { comparisons } from '../compare'
import { PRICE_PAGES } from '../pages'
import { hubDoc } from './hub'

// (Named as ../index.tsx's chunk is, pricing-…, so the price pages' cache rule still finds it: price-pages.ts, priceFirstFiles.)
// The app's price pages with the comparisons' new look (VERDICT_PAGES, page/switch.ts: app/price-pages.ts's verdictApp
// gives App.tsx this module for features/pricing in that build): a comparison, and /compare, drawn from their data
// (view.tsx) when the app reaches them from another of its pages, as their own HTML draws them; ?card, the page's
// link-preview picture. Everything else is the price pages' own (../index.tsx: the calculator, a comparison not found).
const view = () => import('./view')
const ComparisonView = lazy(() => view().then(m => ({ default: m.ComparisonView })))
const HubView = lazy(() => view().then(m => ({ default: m.HubView })))

// (As ../index.tsx: text drawn before the web fonts arrive rewraps when they do, so the page waits for them, at most 3 s.)
const fontsReady = typeof document === 'undefined' ? Promise.resolve() : Promise.race([
  Promise.all(['400 16px Inter', '700 16px "OpenTUI Mono"', '400 16px "OpenTUI Mono"'].map(font => document.fonts.load(font, 'a1'))),
  new Promise(resolve => setTimeout(resolve, 3000)),
]).catch(() => {})
function Frame({ title, children }: { title: string; children: ReactNode }) {
  use(fontsReady)
  useEffect(() => { document.title = title }, [title])
  useLayoutEffect(() => { window.scrollTo(0, 0) }, [title])
  return children
}

export function PricePage() {
  const { pathname } = useLocation()
  const [search] = useSearchParams()
  const at = pathname.replace(/\/+$/, ''), card = search.has('card')
  if (at === '/compare' || at === '/compare/with-set') return <Frame title={hubDoc().searchTitle}><HubView set={at === '/compare/with-set'} card={card} /></Frame>
  const vendor = at.startsWith('/compare/') ? at.slice('/compare/'.length) : null
  const comparison = vendor !== null && Object.hasOwn(comparisons, vendor) ? comparisons[vendor]! : null
  if (comparison) return <Frame title={PRICE_PAGES.find(page => page.comparison === comparison)!.searchTitle}><ComparisonView comparison={comparison} card={card} /></Frame>
  return <Calculator />
}
