import { lazy, use, useEffect, useLayoutEffect, type ReactNode } from 'react'
import { Link, NavLink, useParams, useSearchParams } from 'react-router'
import { ThemeToggle } from '../../components/ThemeToggle'
import { NightmailWordmark } from '../../components/NightmailLogo'
import { EmptyState } from '../../components/ui'
import { productName } from '../../../../api/src/brand'
import { Calculator } from './content'
import { PRICE_PAGES } from './pages'
import { comparisons } from './prices'
import './pricing.css'

// A comparison's page, its styles and its pictures are a module of their own (board-page.tsx), loaded only here: the
// calculator's first paint waits for none of it.
const boardPage = () => import('./board-page')
const ComparisonBoard = lazy(() => boardPage().then(m => ({ default: m.ComparisonBoard })))
const BoardEnd = lazy(() => boardPage().then(m => ({ default: m.BoardEnd })))

// Public pages, no sign-in: the price calculator (/pricing) and one comparison per competitor (/compare/:vendor). Not
// linked from the site until the legal review (pages.ts, PRICE_PAGES_LIVE).

// Prose here uses proportional figures, and the local fallback faces are sized for the tabular ones (tokens.css): text
// painted before the web fonts arrive rewraps when they do. So the pages wait for them, as long as 3 seconds.
const fontsReady = Promise.race([
  Promise.all(['400 16px Inter', '700 16px "OpenTUI Mono"', '400 16px "OpenTUI Mono"'].map(font => document.fonts.load(font, 'a1'))),
  new Promise(resolve => setTimeout(resolve, 3000)),
]).catch(() => {})

function PriceFrame({ title, children, variant, end }: { title: string; children: ReactNode; variant?: string; end?: ReactNode }) {
  use(fontsReady)
  useEffect(() => { document.title = `${title} · ${productName.toLowerCase()}` }, [title])
  // A page opens at its top.
  useLayoutEffect(() => { window.scrollTo(0, 0) }, [title])
  return <div className={`price-page${variant ? ` ${variant}` : ''}`}>
    <header className="price-header">
      <Link className="wordmark" to="/" aria-label={`${productName.toLowerCase()} home`}><NightmailWordmark /></Link>
      <nav className="price-switcher" aria-label="Price pages">
        {PRICE_PAGES.map(page => <NavLink key={page.path} to={page.path} end>{page.path === '/pricing' ? 'Calculator' : page.title.replace(`${productName} `, '')}</NavLink>)}
      </nav>
      <ThemeToggle />
    </header>
    <main className="price-main">{children}</main>
    <footer className="price-footer">
      <p>Product names belong to their owners and only identify their products. {productName} isn’t affiliated with them.</p>
    </footer>
    {end}
  </div>
}

export function PricingPage() {
  return <PriceFrame title={PRICE_PAGES[0].title}><Calculator /></PriceFrame>
}

export function ComparePage() {
  const { vendor } = useParams()
  const comparison = vendor === 'mailchimp' || vendor === 'resend' ? comparisons[vendor] : null
  const page = PRICE_PAGES.find(p => p.path === `/compare/${vendor}`)
  // What the board hangs in waits for a choice (board.tsx, BACKDROPS): ?bg=1 to 4.
  const backdrop = useSearchParams()[0].get('bg')
  if (!comparison) return <PriceFrame title="Page not found"><EmptyState headingAs="h1" title="Page not found" action={<Link to="/pricing">Price calculator</Link>} /></PriceFrame>
  return <PriceFrame title={page?.title ?? comparison.offer.vendor} variant="price-page--board" end={<BoardEnd />}>
    <ComparisonBoard key={vendor} comparison={comparison} backdrop={backdrop} />
  </PriceFrame>
}
