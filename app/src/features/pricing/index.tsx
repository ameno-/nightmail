import { use, useEffect, useLayoutEffect, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useSearchParams } from 'react-router'
import { ThemeToggle } from '../../components/ThemeToggle'
import { NightmailWordmark } from '../../components/NightmailLogo'
import { EmptyState } from '../../components/ui'
import { productName } from '../../../../api/src/brand'
import { PRICE_PAGES } from './pages'
import { comparisons } from './prices'
import './pricing.css'

import { chunk } from '../../lib/preloadable'

// The price pages' scene, its styles and its pictures are a module of their own (board-page.tsx), loaded only here.
const boardChunk = chunk(() => import('./board-page'))
const boardPage = boardChunk.preload
const PriceScene = boardChunk.page(m => m.PriceScene)
const BoardEnd = boardChunk.page(m => m.BoardEnd)

// Public pages, no sign-in: the price calculator (/pricing) and one comparison per competitor (/compare/:vendor), linked
// from the homepage's footer and from each other (live.ts).

// Prose here uses proportional figures, and the local fallback faces are sized for the tabular ones (tokens.css): text
// painted before the web fonts arrive rewraps when they do. So the pages wait for them, as long as 3 seconds.
const fontsReady = Promise.race([
  Promise.all(['400 16px Inter', '700 16px "OpenTUI Mono"', '400 16px "OpenTUI Mono"'].map(font => document.fonts.load(font, 'a1'))),
  new Promise(resolve => setTimeout(resolve, 3000)),
]).catch(() => {})

const pageLinks = (label: (page: (typeof PRICE_PAGES)[number]) => string) => PRICE_PAGES.map(page => <NavLink key={page.path} to={page.path} end>{label(page)}</NavLink>)

/** A price page's frame. The calculator has a bar along the top: the wordmark, the price pages and the theme. A
 *  comparison is a `scene` that runs to the window's top edge, the same in either theme: the wordmark is a quiet link
 *  in its corner, with a link past it to the comparison for a keyboard, and its `end` is its own footer (board.tsx,
 *  BoardEnd), the homepage's. */
function PriceFrame({ title, children, variant, end, scene }: { title: string; children: ReactNode; variant?: string; end?: ReactNode; scene?: boolean }) {
  use(fontsReady)
  useEffect(() => { document.title = `${title} · ${productName.toLowerCase()}` }, [title])
  // A page opens at its top.
  useLayoutEffect(() => { window.scrollTo(0, 0) }, [title])
  const home = <Link className="wordmark" to="/" aria-label={`${productName.toLowerCase()} home`}><NightmailWordmark /></Link>
  return <div className={`price-page${variant ? ` ${variant}` : ''}`}>
    {scene ? <>
      <a className="skip-link" href="#price-main">Skip to the comparison</a>
      <header className="price-corner">{home}</header>
    </> : <header className="price-header">
      {home}
      <nav className="price-switcher" aria-label="Price pages">{pageLinks(page => page.path === '/pricing' ? 'Calculator' : page.title.replace(`${productName} `, ''))}</nav>
      <ThemeToggle />
    </header>}
    <main className="price-main" id="price-main" tabIndex={-1}>{children}</main>
    {scene ? end : <footer className="price-footer">
      <p>Product names belong to their owners and only identify their products. {productName} isn’t affiliated with them.</p>
    </footer>}
  </div>
}

/** The three price pages are one page: the hall stays as the reader moves between them (App.tsx gives both addresses
 *  this component, so it isn't drawn again) and only its board changes (scene.tsx). An unknown comparison is not found. */
export function PricePage() {
  const { pathname } = useLocation()
  const vendor = pathname.startsWith('/compare/') ? pathname.slice('/compare/'.length).replace(/\/+$/, '') : null
  const comparison = vendor === 'mailchimp' || vendor === 'resend' ? comparisons[vendor] : null
  const page = PRICE_PAGES.find(p => p.path === (vendor === null ? '/pricing' : `/compare/${vendor}`))
  // The board's frame in the homepage's steel, while its concrete waits for a yes (board.tsx): ?frame=steel.
  const [search] = useSearchParams()
  if (vendor !== null && !comparison) return <PriceFrame title="Page not found"><EmptyState headingAs="h1" title="Page not found" action={<Link to="/pricing">Price calculator</Link>} /></PriceFrame>
  return <PriceFrame title={page?.title ?? 'Price calculator'} variant="price-page--board" end={<BoardEnd comparison={comparison} />} scene>
    <PriceScene comparison={comparison} frame={search.get('frame')} />
  </PriceFrame>
}
