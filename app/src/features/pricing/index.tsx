import { lazy, use, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useSearchParams } from 'react-router'
import { ThemeToggle } from '../../components/ThemeToggle'
import { NightmailWordmark } from '../../components/NightmailLogo'
import { EmptyState } from '../../components/ui'
import { useShellTakeover as usePaintedTakeover } from '../../lib/shell-takeover'
import { productName } from '../../../../api/src/brand'
import { PRICE_PAGES } from './pages'
import { comparisons } from './compare'
import { SceneFrame } from './frame'
import './pricing.css'

// The price pages' scene, its styles and its pictures are a module of their own (board-page.tsx), loaded only here.
const boardPage = () => import('./board-page')
const PriceScene = lazy(() => boardPage().then(m => ({ default: m.PriceScene })))
const BoardEnd = lazy(() => boardPage().then(m => ({ default: m.BoardEnd })))
// A vendor's pricing page (/pricing/<vendor>: docs/) is drawn from its data as page/ draws every such page (page/view.tsx).
const pageView = () => import('./page/view')
const DocView = lazy(() => pageView().then(m => ({ default: m.DocView })))

// Public pages, no sign-in: the price calculator (/pricing) and one comparison per competitor (/compare/:vendor), linked
// from the homepage's footer and from each other (live.ts).

// Prose here uses proportional figures, and the local fallback faces are sized for the tabular ones (tokens.css): text
// painted before the web fonts arrive rewraps when they do. So the pages wait for them, as long as 3 seconds.
export const fontsReady = Promise.race([
  Promise.all(['400 16px Inter', '700 16px "OpenTUI Mono"', '400 16px "OpenTUI Mono"'].map(font => document.fonts.load(font, 'a1'))),
  new Promise(resolve => setTimeout(resolve, 3000)),
]).catch(() => {})

const pageLinks = (label: (page: (typeof PRICE_PAGES)[number]) => string) => PRICE_PAGES.filter(page => !page.doc).map(page => <NavLink key={page.path} to={page.path} end>{label(page)}</NavLink>)

/** The app's page under #root: a scene or plain frame (.price-page), or a page drawn from its data (page/page.tsx, .pp),
 *  which takes over from the one each price page's own file paints before this code (app/price-pages.ts, #price-shell). */
const APP_PAGE = '#root .price-page, #root .pp'
export const useShellTakeover = () => usePaintedTakeover('price-shell', APP_PAGE)
/** A price page's frame: a scene (frame.tsx), or for a comparison that doesn't exist, a bar along the top (the
 *  wordmark, the price pages and the theme) over one plain column. title: the tab's whole title. */
function PriceFrame({ title, children, end, scene }: { title: string; children: ReactNode; end?: ReactNode; scene?: boolean }) {
  use(fontsReady)
  useEffect(() => { document.title = title }, [title])
  // A page opens at its top, unless it takes over from the painted one, which the reader may have scrolled.
  const painted = useShellTakeover(), opened = useRef(false)
  useLayoutEffect(() => { if (opened.current || !painted) window.scrollTo(0, 0); opened.current = true }, [title, painted])
  if (scene) return <SceneFrame end={end}>{children}</SceneFrame>
  return <div className="price-page">
    <header className="price-header">
      <Link className="wordmark" to="/" aria-label={`${productName.toLowerCase()} home`}><NightmailWordmark /></Link>
      <nav className="price-switcher" aria-label="Price pages">{pageLinks(page => page.path === '/pricing' ? 'Calculator' : page.title.replace(`${productName} `, ''))}</nav>
      <ThemeToggle />
    </header>
    <main className="price-main" id="price-main" tabIndex={-1}>{children}</main>
    <footer className="price-footer">
      <p>Product names belong to their owners and only identify their products. {productName} isn’t affiliated with them.</p>
    </footer>
  </div>
}

/** A page drawn from its data (page/), once the fonts it is set in are in, under its own title. */
function DocFrame({ title, children }: { title: string; children: ReactNode }) {
  use(fontsReady)
  useEffect(() => { document.title = title }, [title])
  useLayoutEffect(() => { window.scrollTo(0, 0) }, [title])
  return children
}

/** The three price pages are one page: the hall stays as the reader moves between them (App.tsx gives both addresses
 *  this component, so it isn't drawn again) and only its board changes (scene.tsx). An unknown comparison is not found. */
export function PricePage() {
  const { pathname } = useLocation()
  const vendor = pathname.startsWith('/compare/') ? pathname.slice('/compare/'.length).replace(/\/+$/, '') : null
  const comparison = vendor !== null && Object.hasOwn(comparisons, vendor) ? comparisons[vendor]! : null
  const page = PRICE_PAGES.find(p => p.path === (vendor === null ? '/pricing' : `/compare/${vendor}`))
  // The board's frame in the homepage's steel, while its concrete waits for a yes (board.tsx): ?frame=steel.
  const [search] = useSearchParams()
  // (/compare is a page only with the comparisons drawn from their data: page/pricing.tsx answers it there.)
  const doc = /^\/(?:pricing|alternatives)\//.test(pathname) ? PRICE_PAGES.find(p => p.path === pathname.replace(/\/+$/, ''))?.doc : undefined
  if (doc) return <DocFrame title={doc.searchTitle}><DocView doc={doc} /></DocFrame>
  if ((vendor !== null && !comparison) || /^\/(?:pricing|alternatives)\//.test(pathname) || pathname.replace(/\/+$/, '') === '/compare') return <PriceFrame title={`Page not found · ${productName.toLowerCase()}`}><EmptyState headingAs="h1" title="Page not found" action={<Link to="/pricing">Price calculator</Link>} /></PriceFrame>
  // The tab's title is the one the page's HTML carries (price-pages.ts), so search engines read one title either way.
  return <PriceFrame title={page!.searchTitle} end={<BoardEnd comparison={comparison} />} scene>
    <PriceScene comparison={comparison} frame={search.get('frame')} />
  </PriceFrame>
}
