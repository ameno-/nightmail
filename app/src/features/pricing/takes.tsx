import { useId, useState, type CSSProperties } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { Disclosure } from '../../components/ui'
import { calculatorPath, Checked, CheckedOn, Cite, Ours, Terms } from './content'
import { CHECKED, comparisons, count, formatCount, mailchimp, MAILCHIMP_USE, mailchimpStops, money, nightmail, nightmailBill, quote, ucOf, yearlyFloor, type Usage } from './prices'
import { usd } from '../../../../api/src/billing/rates'

// Two takes on the Mailchimp comparison, for one to be chosen: /compare/mailchimp?take=a (a control for the list size,
// then the two prices) and ?take=b (three sizes at once, as a chart). Without the parameter the page is the table
// (content.tsx). Both show the two prices first, as a picture, keep the differences to a few words each, and put the
// arithmetic, Nightmail's terms and the full sentences behind "Sources and small print". Every Nightmail figure is
// marked with the usage it prices, and every size is one Mailchimp's page has a tier for (prices.ts, mailchimpStops).

const c = comparisons.mailchimp
type Row = { usage: Usage; plan: string; cents: number; ours: ReturnType<typeof nightmailBill> }
const rowOf = (usage: Usage): Row[] => { const q = quote(mailchimp, usage); return q.kind === 'price' ? [{ usage, plan: q.plan.name, cents: q.cents, ours: nightmailBill(usage.sent, usage.received) }] : [] }
const STOPS = mailchimpStops.flatMap(rowOf), SIZES = c.sizes.flatMap(rowOf)
/** A bar's share of the scale; a price above zero is never drawn as nothing. */
const share = (uc: bigint, max: number) => uc > 0n ? Math.max(Number(uc) / Number(ucOf(max)), .004) : 0
/** What Nightmail costs less: "$251", or "$26.30" when it isn't whole dollars. */
const less = (row: Row) => usd(ucOf(row.cents) - row.ours.uc).replace(/\.00$/, '')

export function MailchimpTake({ take }: { take: 'a' | 'b' }) {
  return <div className="take">
    {take === 'a' ? <BySize /> : <ThreeSizes />}
    <section className="take-diff" aria-label="What’s different">
      <div>
        <h2>Mailchimp has</h2>
        <ul className="take-list">{c.theirs.map(fact => <li key={fact.text}>{fact.short ?? fact.text}<Cite source={fact.source} /></li>)}</ul>
      </div>
      <div>
        <h2>Nightmail has</h2>
        <ul className="take-list">{c.ours.map(fact => <li key={fact.text}>{fact.short ?? fact.text}</li>)}</ul>
      </div>
    </section>
    <Disclosure className="take-small" headingAs="h2" title="Sources and small print">
      <p className="price-note">{c.usage} Monthly billing, list prices before tax, no promotions: Mailchimp’s cheapest plan that holds the list. <Checked source={{ checked: CHECKED, url: mailchimp.pricing }} /></p>
      <p className="price-note">Nightmail charges {nightmail.perThousand} per 1,000 emails after {formatCount(nightmail.freeSent)} free a month.</p>
      <Terms floor={null} />
      <ul className="price-facts">{c.ours.map(fact => <li key={fact.text}>{fact.text}{fact.source && <Cite source={fact.source} />}</li>)}</ul>
      <CheckedOn facts={[...c.theirs, ...c.ours]} />
    </Disclosure>
  </div>
}

function Actions({ usage }: { usage: Usage }) {
  return <div className="price-actions">
    <Link className="ui-button ui-button--primary ui-button--md" to={calculatorPath(usage)}>Try your numbers<ArrowRight size={16} aria-hidden="true" /></Link>
    <Link className="price-link" to="/pricing#not-cheaper">Where Nightmail isn’t cheaper</Link>
  </div>
}
function Assumed() {
  return <p className="price-note">{MAILCHIMP_USE.seats} teammates. Monthly list prices before tax. <Checked source={{ checked: CHECKED, url: mailchimp.pricing }} /></p>
}

// Take A: one control, the list size, over the two prices and a bar for each. Mailchimp's bar is the whole width at every
// size and Nightmail's is its share of it, so the picture answers "against what I pay now" wherever the control stands.
const START = Math.max(0, STOPS.findIndex(row => row.usage.contacts === c.sizes[1]!.contacts))
function BySize() {
  const id = useId()
  const [params, setParams] = useSearchParams()
  const [index, setIndex] = useState(() => { const at = STOPS.findIndex(row => row.usage.contacts === count(params.get('contacts'))); return at < 0 ? START : at })
  const row = STOPS[index]!, floor = yearlyFloor(row.ours.uc)
  function move(next: number) {
    setIndex(next)
    setParams(previous => { const query = new URLSearchParams(previous); query.set('contacts', String(STOPS[next]!.usage.contacts)); return query }, { replace: true, preventScrollReset: true })
  }
  return <>
    <header className="price-intro"><h1>Nightmail vs Mailchimp</h1></header>
    <div className="ta-size">
      <output htmlFor={id}>{formatCount(row.usage.contacts)} contacts</output>
      <span>{formatCount(row.usage.sent)} emails a month, {MAILCHIMP_USE.sendsPerContact} to each contact</span>
    </div>
    <input id={id} className="ta-range" type="range" min={0} max={STOPS.length - 1} step={1} value={index} aria-label="Contacts"
      aria-valuetext={`${formatCount(row.usage.contacts)} contacts: Mailchimp ${money(row.cents)}, Nightmail ${row.ours.text} a month`}
      onChange={event => move(Number(event.target.value))} />
    <div className="ta-ends" aria-hidden="true"><span>{formatCount(STOPS[0]!.usage.contacts)}</span><span>{formatCount(STOPS.at(-1)!.usage.contacts)}</span></div>
    <div className="ta-prices" data-offer={mailchimp.id}>
      <div className="ta-price">
        <span className="ta-price__name">Mailchimp<span>{row.plan}</span></span>
        <strong>{money(row.cents)}</strong>
        <i className="ta-bar" aria-hidden="true" />
      </div>
      <div className="ta-price">
        <span className="ta-price__name">Nightmail{floor && <span>at least {floor} a year</span>}</span>
        <strong><Ours sent={row.usage.sent} received={row.usage.received}>{row.ours.text}</Ours></strong>
        <i className="ta-bar ta-bar--ours" style={{ '--share': share(row.ours.uc, row.cents) } as CSSProperties} aria-hidden="true" />
      </div>
    </div>
    <p className="ta-gap">{less(row)} less a month</p>
    <Assumed />
    <Actions usage={row.usage} />
  </>
}

// Take B: no control. The comparison's three sizes side by side, two columns each on one scale, and a headline that
// states the gap only as far as it holds at every size shown.
const FRACTIONS = [[10, 'a tenth'], [5, 'a fifth'], [4, 'a quarter'], [3, 'a third'], [2, 'half']] as const
const fraction = FRACTIONS.find(([times]) => SIZES.every(row => row.ours.uc * BigInt(times) < ucOf(row.cents)))
function ThreeSizes() {
  const max = Math.max(...SIZES.map(row => row.cents))
  return <>
    <header className="price-intro"><h1>{fraction ? `Nightmail is under ${fraction[1]} of Mailchimp’s price` : 'Nightmail vs Mailchimp'}</h1></header>
    <div className="tb-legend" aria-hidden="true"><span><i />Mailchimp</span><span><i className="tb-key--ours" />Nightmail</span></div>
    <ol className="tb-groups">
      {SIZES.map(row => <li key={row.usage.contacts} data-offer={mailchimp.id}>
        <div className="tb-plot">
          <div className="tb-col" style={{ '--share': share(ucOf(row.cents), max) } as CSSProperties}>
            <b><span className="sr-only">Mailchimp </span>{money(row.cents)}</b><small>{row.plan}</small><i aria-hidden="true" />
          </div>
          <div className="tb-col tb-col--ours" style={{ '--share': share(row.ours.uc, max) } as CSSProperties}>
            <b><span className="sr-only">Nightmail </span><Ours sent={row.usage.sent} received={row.usage.received}>{row.ours.text}</Ours></b><i aria-hidden="true" />
          </div>
        </div>
        {/* (On a phone each line breaks after its number, so the three captions keep one shape.) */}
        <p className="tb-size"><strong>{formatCount(row.usage.contacts)} <br />contacts</strong><span>{formatCount(row.usage.sent)} emails <br />a month</span></p>
      </li>)}
    </ol>
    <Assumed />
    <Actions usage={SIZES[1]!.usage} />
  </>
}
