import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { Disclosure } from '../../components/ui'
import { billMath, CHECKED, comparisons, count, dayOf, formatCount, money, nightmail, nightmailBill, OFFERS, quote, ses, sesBill, sesPerThousand, yearlyFloor, type Comparison, type Offer, type Quote, type Source, type Usage } from './prices'

// The price pages' content (index.tsx frames it). Every Nightmail figure is computed from the billing code's rates and
// carries the usage it prices (data-nightmail-sent and -received), which api/scripts/check-premerge.ts reads back.

const FIELDS = [
  { key: 'sent', label: 'Emails sent a month' },
  { key: 'received', label: 'Emails received a month' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'teammates', label: 'Teammates' },
] as const
type Field = (typeof FIELDS)[number]['key']
type Values = Record<Field, string>
const sizeOf = (u: Usage): Record<Field, number> => ({ sent: u.sent, received: u.received, contacts: u.contacts, teammates: u.seats })
/** Small, medium and large: the sizes of the Mailchimp comparison, so the calculator opens on figures that were checked. */
export const PRESETS = (['Small', 'Medium', 'Large'] as const).map((name, i) => ({ name, size: sizeOf(comparisons.mailchimp.sizes[i]!) }))
const DEFAULT = PRESETS[1]!.size
/** A calculator address for a usage: /pricing?sent=…&received=…&contacts=…&teammates=… */
export const calculatorPath = (u: Usage) => `/pricing?${new URLSearchParams(Object.entries(sizeOf(u)).map(([k, v]) => [k, String(v)]))}`

const host = (url: string) => new URL(url).hostname.replace(/^www\./, '')
/** Where and when a figure was read: the date, and a link to the vendor's page. */
export function Checked({ source: { checked, url } }: { source: Pick<Source, 'checked' | 'url'> }) {
  return <span className="price-checked">Checked {dayOf(checked)} on <a href={url} target="_blank" rel="noopener noreferrer">{host(url)}<ArrowUpRight size={12} aria-hidden="true" /></a></span>
}
/** A claim's source, after it: a link to the page it was read on (the list's note says when). */
export function Cite({ source: { checked, url } }: { source: Source }) {
  const label = `${host(url)}, checked ${dayOf(checked)}`
  return <a className="price-cite" href={url} target="_blank" rel="noopener noreferrer" title={label} aria-label={`Source: ${label}`}><ArrowUpRight size={14} aria-hidden="true" /></a>
}
/** The days a list of claims was read on, and where, said once under it. */
export function CheckedOn({ facts }: { facts: { source?: Source }[] }) {
  const sources = facts.flatMap(fact => fact.source ? [fact.source] : [])
  const days = [...new Set(sources.map(source => dayOf(source.checked)))], hosts = [...new Set(sources.map(source => host(source.url)))]
  return days.length ? <p className="price-note">Checked {days.join(', ')} on {hosts.length === 1 ? hosts[0] : 'each vendor’s own page'}.</p> : null
}
/** A Nightmail figure, marked with the usage it prices. */
export function Ours({ sent, received, children }: { sent: number; received: number; children: string }) {
  return <span data-nightmail-sent={sent} data-nightmail-received={received}>{children}</span>
}

export function Calculator() {
  const [params, setParams] = useSearchParams()
  const [values, setValues] = useState<Values>(() => Object.fromEntries(FIELDS.map(({ key }) => [key, formatCount(params.has(key) ? count(params.get(key)) : DEFAULT[key])])) as Values)
  const usage: Usage = { sent: count(values.sent), received: count(values.received), contacts: count(values.contacts), seats: count(values.teammates) }
  const size = sizeOf(usage)
  const preset = PRESETS.find(p => FIELDS.every(({ key }) => p.size[key] === size[key]))
  function change(next: Values) {
    setValues(next)
    setParams(Object.fromEntries(FIELDS.map(({ key }) => [key, String(count(next[key]))])), { replace: true, preventScrollReset: true })
  }
  const bill = nightmailBill(usage.sent, usage.received), floor = yearlyFloor(bill.uc)
  // Only vendors with a price that was read for this size (a size a vendor's page doesn't price is not compared), and
  // a vendor that prices by contacts only when there are contacts.
  const offers = OFFERS.flatMap(offer => { const q = quote(offer, usage); return q.kind === 'price' && (offer.unit !== 'contacts' || usage.contacts > 0) ? [{ offer, q }] : [] })
  return <>
    <header className="price-intro">
      <h1>Price calculator</h1>
      <p>Nightmail charges {nightmail.perThousand} per 1,000 emails sent or received, after {formatCount(nightmail.freeSent)} of each free every month. Contacts, teammates and features cost nothing.</p>
    </header>
    <div className="price-calculator">
      <form className="price-inputs" onSubmit={event => event.preventDefault()} aria-label="Your usage">
        <div className="price-presets" role="group" aria-label="Sizes">
          {PRESETS.map(p => <button key={p.name} type="button" className="ui-button ui-button--secondary ui-button--md" aria-pressed={preset === p} onClick={() => change(Object.fromEntries(FIELDS.map(({ key }) => [key, formatCount(p.size[key])])) as Values)}>{p.name}</button>)}
        </div>
        {FIELDS.map(({ key, label }) => <label key={key} className="price-field">
          <span>{label}</span>
          <input className="ui-input" name={key} inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={14} value={values[key]}
            onChange={event => change({ ...values, [key]: event.target.value })}
            onBlur={() => { const tidy = formatCount(count(values[key])); if (tidy !== values[key]) setValues({ ...values, [key]: tidy }) }} />
        </label>)}
      </form>
      <section className="price-ours" aria-label="Nightmail">
        <div className="price-ours__head">
          <h2>Nightmail</h2>
          <p className="price-total" aria-live="polite"><Ours sent={usage.sent} received={usage.received}>{bill.text}</Ours> a month</p>
        </div>
        <dl className="price-math">
          <div><dt>Sent</dt><dd>{billMath(bill.sent)}</dd><dd><Ours sent={usage.sent} received={0}>{bill.sent.text}</Ours></dd></div>
          <div><dt>Received</dt><dd>{billMath(bill.received)}</dd><dd><Ours sent={0} received={usage.received}>{bill.received.text}</Ours></dd></div>
          <div><dt>Contacts and teammates</dt><dd>No charge</dd><dd><Ours sent={0} received={0}>{nightmailBill(0, 0).text}</Ours></dd></div>
        </dl>
        <Disclosure className="price-small" headingAs="h3" title="Small print"><Terms floor={floor} /></Disclosure>
      </section>
    </div>
    <section className="price-section" aria-labelledby="price-others">
      <h2 id="price-others">Others at this size</h2>
      <ul className="price-rows">
        {offers.map(({ offer, q }) => <OfferRow key={offer.id} offer={offer} q={q} />)}
        <li className="price-row" data-offer="ses">
          <span className="price-row__name">{ses.name}<span className="price-row__plan">{ses.plan}</span></span>
          <span className="price-row__price">{sesBill(usage)}</span>
          <span className="price-row__meta">({formatCount(usage.sent)} + {formatCount(usage.received)}) × {sesPerThousand(ses.ucPerEmail)} per 1,000, plus attachment and large-message charges. <Checked source={ses.sentSource} /></span>
        </li>
      </ul>
      <p className="price-note">Monthly billing, list prices before tax, no promotions. Each vendor’s cheapest plan that holds your numbers.</p>
    </section>
  </>
}

function OfferRow({ offer, q: { plan, tier, cents, payg } }: { offer: Offer; q: Extract<Quote, { kind: 'price' }> }) {
  const seats = plan.seats ? `, ${plan.seats.count === null ? 'unlimited seats' : `${plan.seats.count} ${plan.seats.count === 1 ? 'seat' : 'seats'}`}` : ''
  const detail = offer.unit === 'contacts'
    ? `Up to ${formatCount(tier.size)} contacts, ${tier.sends === undefined ? 'any number of sends' : `${formatCount(tier.sends)} sends`}${plan.note ? ` (${plan.note})` : ''}${seats}.`
    : `Up to ${formatCount(tier.size)} emails a month, sent and received${plan.note ? `, ${plan.note}` : ''}.`
  return <li className="price-row" data-offer={offer.id}>
    <span className="price-row__name">{offer.name}<span className="price-row__plan">{plan.name}</span></span>
    <span className="price-row__price">{money(cents)}</span>
    <span className="price-row__meta">{detail}{payg && ` Or ${money(payg.cents)} with pay-as-you-go: ${payg.plan.name} at ${money(payg.tier.cents)} plus ${formatCount(payg.buckets)} × ${money(payg.tier.overage!)} per 1,000.`} <Checked source={{ checked: tier.source.checked, url: offer.pricing }} /></span>
  </li>
}

/** Nightmail's pricing terms, in each page's small print: what a buyer is told before paying. */
export function Terms({ floor }: { floor: string | null }) {
  return <ul className="price-terms">
    <li>Paid from prepaid credit. Top-ups start at {nightmail.minTopUp} and expire {nightmail.expiresAfterMonths} months after purchase.{floor && ` At this size that’s at least ${floor} a year.`}</li>
    <li>Received mail kept past {nightmail.storageAfterDays} days: {nightmail.storagePerGb} per GB a month after {nightmail.freeStorageGb} GB free.</li>
  </ul>
}

export function Compare({ comparison: c }: { comparison: Comparison }) {
  const { offer } = c, contacts = offer.unit === 'contacts'
  return <>
    <header className="price-intro">
      <h1>Nightmail vs {offer.vendor}</h1>
      <p>{c.lead}</p>
    </header>
    <table className="price-table">
      <thead><tr><th scope="col">Size</th><th scope="col">{offer.vendor}</th><th scope="col">Nightmail</th></tr></thead>
      {/* (Only sizes the vendor's page prices.) */}
      <tbody>{c.sizes.map(size => {
        const q = quote(offer, size), bill = nightmailBill(size.sent, size.received)
        return q.kind === 'price' && <tr key={size.sent} data-offer={offer.id}>
          <th scope="row">{contacts ? <>{formatCount(size.contacts)} contacts<span className="price-table__sub">{formatCount(size.sent)} emails a month</span></> : <>{formatCount(size.sent)} emails a month</>}</th>
          <td data-label={offer.vendor}><strong>{money(q.cents)}</strong><span className="price-table__sub">{q.plan.name}</span></td>
          <td data-label="Nightmail"><strong><Ours sent={size.sent} received={size.received}>{bill.text}</Ours></strong><span className="price-table__sub">{billMath(bill.sent)}</span></td>
        </tr>
      })}</tbody>
    </table>
    <p className="price-note">{c.usage} Monthly billing, list prices before tax. <Checked source={{ checked: CHECKED, url: offer.pricing }} /></p>
    <section className="price-section" aria-labelledby="price-ours">
      <h2 id="price-ours">On Nightmail</h2>
      <ul className="price-facts">{c.ours.map(fact => <li key={fact.text}>{fact.text}{fact.source && <Cite source={fact.source} />}</li>)}</ul>
      <CheckedOn facts={c.ours} />
    </section>
    <section className="price-section">
      <div className="price-actions">
        <Link className="ui-button ui-button--primary ui-button--md" to={calculatorPath(c.sizes[1]!)}>Try your numbers<ArrowRight size={16} aria-hidden="true" /></Link>
      </div>
    </section>
    <Disclosure className="price-small" headingAs="h2" title="Small print"><Terms floor={null} /></Disclosure>
  </>
}
