import { useId, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowRight, Check, Minus, Plus } from 'lucide-react'
import { Disclosure } from '../../components/ui'
import { calculatorPath, Checked, CheckedOn, Cite, Ours, Terms } from './content'
import { CHECKED, claim, count, formatCount, money, nightmail, nightmailBill, price, reachable, theirPrice, ucOf, type Comparison, type Usage } from './prices'

// A price against a price, driven by the reader's own number: the hero of every comparison page, for any competitor in
// prices.ts (comparison.steps, use and assume say what the control reaches and what both prices are for). Three looks
// of the same thing, for one to be chosen (/compare/mailchimp?calc=a, b or c, and the same on /compare/resend):
//   a. the card: one block, a slider over the vendor's own sizes, the two prices side by side;
//   b. the ranking: a typed number (or − and +), each provider a row, Nightmail's the row that stands out;
//   c. the bars: a slider, the two prices as bars on one scale, only Nightmail's coloured.
// Every size the control can reach is one the vendor's page prices and where Nightmail costs less (the pre-merge check
// proves both). Figures keep the room of the widest they can show (Room), so nothing moves when the number changes.

export const LOOKS = ['a', 'b', 'c'] as const
export type Look = (typeof LOOKS)[number]

export type Point = { size: number; usage: Usage; ours: ReturnType<typeof nightmailBill>; theirs: { cents: number; plan: string } }
export const pointAt = (c: Comparison, size: number): Point => {
  const usage = c.use(size)
  return { size, usage, ours: nightmailBill(usage.sent, usage.received), theirs: theirPrice(c.offer, usage)! }
}
export const byContacts = (c: Comparison) => c.offer.unit === 'contacts'
export const sizeOf = (c: Comparison, u: Usage) => byContacts(c) ? u.contacts : u.sent
/** The size a typed number is priced at: on a 'complete' ladder itself, within the steps; otherwise the vendor's
 *  smallest size that holds it (or its largest). */
export function fit(c: Comparison, n: number) {
  const first = c.steps[0]!, last = c.steps.at(-1)!
  if (c.offer.ladder === 'complete') return Math.min(last, Math.max(first, n))
  return c.steps.find(step => step >= n) ?? last
}
/** How much more the competitor costs. */
export const more = (p: Point) => price(ucOf(p.theirs.cents) - p.ours.uc)
export const share = (p: Point) => Number(p.ours.uc) / Number(ucOf(p.theirs.cents))

/** The widest text a figure can show, by the sizes the control reaches. */
const widest = (values: string[]) => values.reduce((a, b) => b.length > a.length || (b.length === a.length && b.replace(/\D/g, '').length > a.replace(/\D/g, '').length) ? b : a, '')
export function rooms(c: Comparison) {
  const points = reachable(c).map(size => pointAt(c, size))
  return {
    size: widest(points.map(p => formatCount(p.size))), emails: widest(points.map(p => formatCount(p.usage.sent))),
    ours: widest(points.map(p => p.ours.text)), theirs: widest(points.map(p => money(p.theirs.cents))),
    plan: widest(points.map(p => p.theirs.plan)), more: widest(points.map(more)),
  }
}
/** A figure in the room of the widest it can be. */
export function Room({ widest, children }: { widest: string; children: ReactNode }) {
  return <span className="pa-room"><span aria-hidden="true">{widest}</span><span>{children}</span></span>
}

function Slider({ c, size, onChange, label }: { c: Comparison; size: number; onChange: (size: number) => void; label: string }) {
  const at = c.steps.indexOf(size), last = c.steps.length - 1
  return <div className="pa-slider" style={{ '--at': at / last } as CSSProperties}>
    <input type="range" min={0} max={last} step={1} value={at} aria-label={label} aria-valuetext={`${formatCount(size)} ${byContacts(c) ? 'contacts' : 'emails a month'}`}
      onChange={event => onChange(c.steps[Number(event.target.value)]!)} />
    <span className="pa-slider__ticks" aria-hidden="true">{c.steps.map((step, k) => <i key={step} style={{ '--k': k / last } as CSSProperties} />)}</span>
    <span className="pa-slider__ends" aria-hidden="true"><span>{formatCount(c.steps[0]!)}</span><span>{formatCount(c.steps[last]!)}</span></span>
  </div>
}

/** What the reader chose, and for contacts the emails a month both prices are for. */
function Readout({ c, p, room }: { c: Comparison; p: Point; room: ReturnType<typeof rooms> }) {
  return <p className="pa-readout">
    <b><Room widest={room.size}>{formatCount(p.size)}</Room></b>{byContacts(c) ? ' contacts' : ' emails a month'}
    {byContacts(c) && <span><Room widest={room.emails}>{formatCount(p.usage.sent)}</Room> emails a month</span>}
  </p>
}

const ours = (p: Point) => <Ours sent={p.usage.sent} received={p.usage.received}>{p.ours.text}</Ours>

export function PriceAgainst({ comparison: c, look, action = true }: { comparison: Comparison; look: Look; action?: boolean }) {
  const room = useMemo(() => rooms(c), [c])
  const [size, setSize] = useState(() => fit(c, sizeOf(c, c.sizes[1] ?? c.use(c.steps[0]!))))
  const [draft, setDraft] = useState<string | null>(null)
  const p = pointAt(c, size), id = useId(), label = byContacts(c) ? 'Contacts on your list' : 'Emails you send a month'
  const vendor = c.offer.vendor
  const step = (by: 1 | -1) => by > 0 ? c.steps.find(s => s > size) : [...c.steps].reverse().find(s => s < size)
  const move = (by: 1 | -1) => { const next = step(by); if (next !== undefined) { setSize(next); setDraft(null) } }
  const key = (event: KeyboardEvent) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); move(event.key === 'ArrowUp' ? 1 : -1) } }

  const control = <div className="pa-control">
    <div className="pa-control__head"><label htmlFor={id}>{label}</label><Readout c={c} p={p} room={room} /></div>
    <Slider c={c} size={size} onChange={setSize} label={label} />
  </div>

  return <section className={`pa pa--${look}`} aria-label={`Nightmail and ${vendor} at your size`} data-offer={c.offer.id}>
    {look === 'a' && <div className="pa-card">
      {control}
      <div className="pa-a-pair" aria-live="polite">
        <p className="pa-a-ours"><span>Nightmail</span><b><Room widest={room.ours}>{ours(p)}</Room></b><small>a month</small></p>
        <p className="pa-a-theirs"><span>{vendor} <small><Room widest={room.plan}>{p.theirs.plan}</Room></small></span><b><Room widest={room.theirs}>{money(p.theirs.cents)}</Room></b><small>a month</small></p>
      </div>
    </div>}

    {look === 'b' && <div className="pa-rank">
      <div className="pa-b-ask">
        <label htmlFor={id}>{label}</label>
        <div className="pa-b-field">
          <button type="button" aria-label={byContacts(c) ? 'Fewer contacts' : 'Fewer emails'} disabled={step(-1) === undefined} onClick={() => move(-1)}><Minus size={18} aria-hidden="true" /></button>
          <input id={id} inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={11} value={draft ?? formatCount(size)}
            onChange={event => { setDraft(event.target.value); const n = count(event.target.value); if (n > 0) setSize(fit(c, n)) }}
            onBlur={() => setDraft(null)} onKeyDown={key} />
          <button type="button" aria-label={byContacts(c) ? 'More contacts' : 'More emails'} disabled={step(1) === undefined} onClick={() => move(1)}><Plus size={18} aria-hidden="true" /></button>
        </div>
        {/* (A typed number the vendor doesn't price is shown at the size it is priced at, and says so.) */}
        <p className="pa-b-sub">{byContacts(c) && draft !== null && count(draft) !== size && <>At {vendor}’s {formatCount(size)}: </>}{byContacts(c) ? `${formatCount(p.usage.sent)} emails a month` : `${formatCount(size)} emails a month (${formatCount(c.steps[0]!)} to ${formatCount(c.steps.at(-1)!)})`}</p>
      </div>
      <ol className="pa-b-rows" aria-live="polite">
        <li className="pa-b-ours"><span className="pa-b-name">Nightmail</span><b><Room widest={room.ours}>{ours(p)}</Room></b><span className="pa-b-more" /></li>
        <li><span className="pa-b-name">{vendor}<small><Room widest={room.plan}>{p.theirs.plan}</Room></small></span><b><Room widest={room.theirs}>{money(p.theirs.cents)}</Room></b>
          <span className="pa-b-more"><Room widest={`${room.more} more`}>{more(p)} more</Room></span></li>
      </ol>
    </div>}

    {look === 'c' && <div className="pa-bars-wrap">
      {control}
      <div className="pa-bars" aria-live="polite" style={{ '--share': share(p) } as CSSProperties}>
        <p className="pa-c-ours"><span className="pa-c-name">Nightmail</span><i aria-hidden="true"><i /></i><b><Room widest={room.theirs}>{ours(p)}</Room></b></p>
        <p className="pa-c-theirs"><span className="pa-c-name">{vendor}<small><Room widest={room.plan}>{p.theirs.plan}</Room></small></span><i aria-hidden="true"><i /></i><b><Room widest={room.theirs}>{money(p.theirs.cents)}</Room></b></p>
      </div>
    </div>}

    <p className="pa-note">{c.assume} <Checked source={{ checked: CHECKED, url: c.offer.pricing }} /></p>
    {action && <Link className="ui-button ui-button--primary ui-button--md pa-action" to={calculatorPath(p.usage)}>Try your numbers<ArrowRight size={16} aria-hidden="true" /></Link>}
  </section>
}

/** A comparison page built on it: the headline true at every reachable size, the component, what Nightmail has in a
 *  row, and the closed small print. */
export function ComparisonCalc({ comparison: c, look }: { comparison: Comparison; look: Look }) {
  return <div className="pa-page">
    <h1 className="pa-title">{claim(c)}</h1>
    <PriceAgainst comparison={c} look={look} />
    <section className="pa-has" aria-labelledby="pa-has"><h2 id="pa-has">Nightmail has</h2>
      <ul>{c.ours.map(fact => <li key={fact.text}><Check size={16} aria-hidden="true" />{fact.short ?? fact.text}</li>)}</ul>
    </section>
    <Disclosure className="price-small" headingAs="h2" title="Sources and small print">
      <p className="price-note">{c.usage} Monthly billing, list prices before tax, no promotions. <Checked source={{ checked: CHECKED, url: c.offer.pricing }} /></p>
      <p className="price-note">Nightmail charges {nightmail.perThousand} per 1,000 emails after {formatCount(nightmail.freeSent)} free a month.</p>
      <Terms floor={null} />
      <ul className="price-facts">{c.ours.map(fact => <li key={fact.text}>{fact.text}{fact.source && <Cite source={fact.source} />}</li>)}</ul>
      <CheckedOn facts={c.ours} />
    </Disclosure>
  </div>
}
