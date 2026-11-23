import { use, useEffect, useLayoutEffect, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useParams, useSearchParams } from 'react-router'
import { ThemeToggle } from '../../components/ThemeToggle'
import { NightmailWordmark } from '../../components/NightmailLogo'
import { EmptyState } from '../../components/ui'
import { productName } from '../../../../api/src/brand'
import { Calculator, Compare } from './content'
import { PRICE_PAGES } from './pages'
import { comparisons } from './prices'
import { MailchimpTake } from './takes'
import './pricing.css'

// Public pages, no sign-in: the price calculator (/pricing) and one comparison per competitor (/compare/:vendor). Not
// linked from the site until the legal review (pages.ts, PRICE_PAGES_LIVE).

// Prose here uses proportional figures, and the local fallback faces are sized for the tabular ones (tokens.css): text
// painted before the web fonts arrive rewraps when they do. So the pages wait for them, as long as 3 seconds.
const fontsReady = Promise.race([
  Promise.all(['400 16px Inter', '700 16px "OpenTUI Mono"', '400 16px "OpenTUI Mono"'].map(font => document.fonts.load(font, 'a1'))),
  new Promise(resolve => setTimeout(resolve, 3000)),
]).catch(() => {})

function PriceFrame({ title, children }: { title: string; children: ReactNode }) {
  use(fontsReady)
  const { hash } = useLocation()
  useEffect(() => { document.title = `${title} · ${productName.toLowerCase()}` }, [title])
  // A page opens at its top, or at the section its link names.
  useLayoutEffect(() => {
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null
    if (target) target.scrollIntoView({ block: 'start' })
    else window.scrollTo(0, 0)
  }, [title, hash])
  return <div className="price-page">
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
  </div>
}

export function PricingPage() {
  return <PriceFrame title={PRICE_PAGES[0].title}><Calculator /></PriceFrame>
}

export function ComparePage() {
  const { vendor } = useParams()
  const comparison = vendor === 'mailchimp' || vendor === 'resend' ? comparisons[vendor] : null
  const page = PRICE_PAGES.find(p => p.path === `/compare/${vendor}`)
  // Two takes on the Mailchimp page wait for a choice (takes.tsx); without ?take the page is the one it has been.
  const take = useSearchParams()[0].get('take')
  return <PriceFrame title={page?.title ?? 'Page not found'}>
    {vendor === 'mailchimp' && (take === 'a' || take === 'b') ? <MailchimpTake key={take} take={take} /> : comparison ? <Compare key={vendor} comparison={comparison} /> : <EmptyState headingAs="h1" title="Page not found" action={<Link to="/pricing">Price calculator</Link>} />}
  </PriceFrame>
}
