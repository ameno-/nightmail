import { lazy, Suspense, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { Disclosure } from '../../components/ui'
import { calculatorPath, Checked, CheckedOn, Cite, Ours, Terms } from './content'
import { COMPETITOR_BRAND } from './live'
import { CHECKED, comparisons, formatCount, mailchimp, MAILCHIMP_USE, money, nightmail, nightmailBill, quote, ucOf, type Usage } from './prices'

// Nightmail vs Mailchimp (/compare/mailchimp): the comparison's sizes at once as a column chart, the two prices before a
// sentence is read; then what Nightmail has, a few words each, and one closed disclosure with the usage assumed,
// Nightmail's pricing terms and the full sourced sentences. Every Nightmail figure is marked with the usage it prices.
//
// What to change to try another chart:
// - the sizes shown and the use behind them: comparisons.mailchimp.sizes and MAILCHIMP_USE (prices.ts). A size must be
//   a contact tier Mailchimp's page lists (the offer has every one up to 100,000); the pre-merge check fails otherwise.
// - the headline: headline() below. It states the gap only as far as it holds at every size shown.
// - the columns' colours, the plot's height and a column's width: --cmp-theirs, --cmp-ours, --cmp-plot and --cmp-column
//   (pricing.css, .cmp).
// - Mailchimp's logo and yellow: COMPETITOR_BRAND (live.ts).

const c = comparisons.mailchimp
type Row = { usage: Usage; plan: string; cents: number; ours: ReturnType<typeof nightmailBill> }
const ROWS: Row[] = c.sizes.flatMap(usage => { const q = quote(mailchimp, usage); return q.kind === 'price' ? [{ usage, plan: q.plan.name, cents: q.cents, ours: nightmailBill(usage.sent, usage.received) }] : [] })
const MAX = Math.max(...ROWS.map(row => row.cents))
/** A column's share of the tallest; a price above zero is never drawn as nothing (the stylesheet's 2 px least). */
const share = (uc: bigint) => Number(uc) / Number(ucOf(MAX))

const FRACTIONS = [[10, 'a tenth'], [5, 'a fifth'], [4, 'a quarter'], [3, 'a third'], [2, 'half']] as const
function headline() {
  const fraction = FRACTIONS.find(([times]) => ROWS.every(row => row.ours.uc * BigInt(times) < ucOf(row.cents)))
  return fraction ? `Nightmail is under ${fraction[1]} of Mailchimp’s price` : 'Nightmail vs Mailchimp'
}

// The two logos over the title are a module of their own, loaded only while the flag is on (brand/marks.tsx). Their
// row keeps its height while they load, so nothing moves.
const Marks = COMPETITOR_BRAND ? lazy(() => import('./brand/marks')) : null

export function MailchimpComparison() {
  return <div className="cmp" data-brand={Marks ? true : undefined}>
    {Marks && <Suspense fallback={<p className="cmp-marks" />}><Marks /></Suspense>}
    <header className="price-intro"><h1>{headline()}</h1></header>
    <div className="cmp-legend" aria-hidden="true"><span><i />Mailchimp</span><span><i className="cmp-legend__ours" />Nightmail</span></div>
    <ol className="cmp-chart">
      {ROWS.map(row => <li key={row.usage.contacts} data-offer={mailchimp.id}>
        <div className="cmp-plot">
          <div className="cmp-col" style={{ '--share': share(ucOf(row.cents)) } as CSSProperties}>
            <b><span className="sr-only">Mailchimp </span>{money(row.cents)}</b><small>{row.plan}</small><i aria-hidden="true" />
          </div>
          <div className="cmp-col cmp-col--ours" style={{ '--share': share(row.ours.uc) } as CSSProperties}>
            <b><span className="sr-only">Nightmail </span><Ours sent={row.usage.sent} received={row.usage.received}>{row.ours.text}</Ours></b><i aria-hidden="true" />
          </div>
        </div>
        {/* (On a phone each line breaks after its number, so the captions keep one shape.) */}
        <p className="cmp-size"><strong>{formatCount(row.usage.contacts)} <br />contacts</strong><span>{formatCount(row.usage.sent)} emails <br />a month</span></p>
      </li>)}
    </ol>
    <p className="price-note">{MAILCHIMP_USE.seats} teammates. Monthly list prices before tax. <Checked source={{ checked: CHECKED, url: mailchimp.pricing }} /></p>
    <div className="price-actions">
      <Link className="ui-button ui-button--primary ui-button--md" to={calculatorPath(c.sizes[1]!)}>Try your numbers<ArrowRight size={16} aria-hidden="true" /></Link>
    </div>
    <section className="cmp-has" aria-labelledby="cmp-has">
      <h2 id="cmp-has">Nightmail has</h2>
      <ul>{c.ours.map(fact => <li key={fact.text}>{fact.short ?? fact.text}</li>)}</ul>
    </section>
    <Disclosure className="price-small" headingAs="h2" title="Sources and small print">
      <p className="price-note">{c.usage} Monthly billing, list prices before tax, no promotions: Mailchimp’s cheapest plan that holds the list. <Checked source={{ checked: CHECKED, url: mailchimp.pricing }} /></p>
      <p className="price-note">Nightmail charges {nightmail.perThousand} per 1,000 emails after {formatCount(nightmail.freeSent)} free a month.</p>
      <Terms floor={null} />
      <ul className="price-facts">{c.ours.map(fact => <li key={fact.text}>{fact.text}{fact.source && <Cite source={fact.source} />}</li>)}</ul>
      <CheckedOn facts={c.ours} />
    </Disclosure>
  </div>
}
