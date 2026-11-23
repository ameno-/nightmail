import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowRight, Check } from 'lucide-react'
import { Disclosure } from '../../components/ui'
import { NightmailWordmark } from '../../components/NightmailLogo'
import { useTheme } from '../../lib/theme'
import { EndBand, endBand } from '../home/end-band'
import { toneVars } from '../home/tones'
import { calculatorPath, Checked, CheckedOn, Cite, Ours, Terms } from './content'
import { CHECKED, claim, formatCount, money, nightmail, nightmailBill, theirPrice, ucOf, type Comparison, type Usage } from './prices'

// A comparison page (/compare/mailchimp, /compare/resend): the two prices on a board hung in the homepage's factory, as
// its hero's boards hang. The reader's own size is set on a fader on the console under it, over the vendor's own
// published sizes (comparison.steps: each one priced by the vendor and cheaper on Nightmail, as the pre-merge check
// proves). On the board: the prices on split-flap tiles (lit for Nightmail, unlit for the competitor; a tile flips when
// its character changes) and each price as a bar of forty pigeonholes on one scale, the competitor's every one,
// Nightmail's its share, lit in the homepage's periwinkle, the only colour. Under the console, what both prices are for
// and where the competitor's was read; then what Nightmail has, the small print, and the wordmark across the page's end.
// Every figure keeps the room of the widest it can show (Room), so nothing moves as the fader does.
// The board hangs on a dark wall under one pendant lamp, which comes down on its cord from the top of the window (the
// page has no bar: PriceFrame's scene). Nightmail is named by its wordmark wherever it is a display word: the headline,
// the board's lit row and "Nightmail has"; each one's accessible name is "Nightmail".
// (Its styles are board.css, loaded with this page only: board-page.tsx. This file imports none, so the pre-merge check
// can render it.)

type Point = { size: number; usage: Usage; ours: ReturnType<typeof nightmailBill>; theirs: { cents: number; plan: string } }
const pointAt = (c: Comparison, size: number): Point => {
  const usage = c.use(size)
  return { size, usage, ours: nightmailBill(usage.sent, usage.received), theirs: theirPrice(c.offer, usage)! }
}
const byContacts = (c: Comparison) => c.offer.unit === 'contacts'
const unitOf = (c: Comparison) => byContacts(c) ? 'contacts' : 'emails a month'
/** The size the page opens at: the comparison's middle size, or the vendor's nearest that holds it. */
const opening = (c: Comparison) => { const u = c.sizes[1] ?? c.use(c.steps[0]!), n = byContacts(c) ? u.contacts : u.sent; return c.steps.find(step => step >= n) ?? c.steps.at(-1)! }
const share = (p: Point) => Number(p.ours.uc) / Number(ucOf(p.theirs.cents))
/** The widest text a figure can show, by the sizes the fader reaches. */
const widest = (values: string[]) => values.reduce((a, b) => b.length > a.length || (b.length === a.length && b.replace(/\D/g, '').length > a.replace(/\D/g, '').length) ? b : a, '')
function rooms(c: Comparison) {
  const points = c.steps.map(size => pointAt(c, size))
  return { size: widest(points.map(p => formatCount(p.size))), price: widest(points.flatMap(p => [p.ours.text, money(p.theirs.cents)])) }
}
/** A figure in the room of the widest it can be. */
function Room({ widest, children }: { widest: string; children: ReactNode }) {
  return <span className="cb-room"><span aria-hidden="true">{widest}</span><span>{children}</span></span>
}

/** Split-flap tiles: a tile a character, padded to a fixed count so the board never changes size; a tile whose
 *  character changes flips over to it. */
function Flaps({ text, width, end, className }: { text: string; width: number; end?: boolean; className: string }) {
  const chars = (end ? text.padStart(width) : text.padEnd(width)).toUpperCase().split('')
  return <span className={`cb-flaps ${className}`} aria-hidden="true">{chars.map((ch, i) =>
    <span key={`${i}:${ch}`} className="cb-flap" style={{ '--i': i } as CSSProperties} data-blank={ch === ' ' || undefined}><span>{ch}</span></span>)}</span>
}
/** Nightmail's wordmark, read as the word. */
const Mark = ({ className }: { className: string }) => <NightmailWordmark className={`cb-mark ${className}`} title="Nightmail" />
/** The headline, with the wordmark in the place of the word. */
const Claim = ({ text }: { text: string }) => <>{text.split('Nightmail').map((part, i) => <span key={i}>{i > 0 && <Mark className="cb-mark-title" />}{part}</span>)}</>

/** A price as a row of pigeonholes on one scale: the competitor's fills every one, Nightmail's its share, lit from the
 *  left in turn. */
const CELLS = 40
function Cells({ lit, mine }: { lit: number; mine?: boolean }) {
  return <span className="cb-cells" data-mine={mine || undefined} aria-hidden="true">{Array.from({ length: CELLS }, (_, i) =>
    <i key={i} style={{ '--i': i } as CSSProperties} data-on={i < lit || undefined} />)}</span>
}
/** The fader: a native range over the vendor's sizes (arrow keys, Home and End, a cap to drag), a tick at each. */
function Fader({ c, size, onChange, id }: { c: Comparison; size: number; onChange: (size: number) => void; id: string }) {
  const at = c.steps.indexOf(size), last = c.steps.length - 1
  return <span className="cb-fader" style={{ '--at': at / last } as CSSProperties}>
    <input id={id} type="range" min={0} max={last} step={1} value={at} aria-valuetext={`${formatCount(size)} ${unitOf(c)}`}
      onChange={event => onChange(c.steps[Number(event.target.value)]!)} />
    <span className="cb-ticks" aria-hidden="true">{c.steps.map((step, k) => <i key={step} style={{ '--k': k / last } as CSSProperties} />)}</span>
  </span>
}

export function ComparisonBoard({ comparison: c }: { comparison: Comparison }) {
  const room = useMemo(() => rooms(c), [c])
  const [size, setSize] = useState(() => opening(c))
  const p = pointAt(c, size), id = useId(), vendor = c.offer.vendor
  const lit = p.ours.uc === 0n ? 0 : Math.max(1, Math.round(CELLS * share(p)))
  return <section className="cb-hall" aria-labelledby="cb-title">
    <div className="cb-stage">
      <div className="cb-backdrop" aria-hidden="true"><i className="cb-lamp" /></div>
      <div className="cb-wrap">
        <h1 id="cb-title" className="cb-title"><Claim text={claim(c)} /></h1>
        <div className="cb-hang" aria-hidden="true"><i /><i /></div>
        <div className="cb-board" aria-live="polite">
          <div className="cb-face">
            <p className="cb-head" aria-hidden="true"><span>A month at</span><Flaps text={formatCount(size)} width={room.size.length} end className="cb-small" /><span>{unitOf(c)}</span></p>
            <p className="sr-only">{formatCount(size)} {unitOf(c)}{byContacts(c) && `, ${formatCount(p.usage.sent)} emails a month`}: Nightmail <Ours sent={p.usage.sent} received={p.usage.received}>{p.ours.text}</Ours>, {vendor} {money(p.theirs.cents)} a month.</p>
            <div className="cb-row cb-mine" aria-hidden="true"><Mark className="cb-mark-board" /><Flaps text={p.ours.text} width={room.price.length} end className="cb-price" /></div>
            <Cells lit={lit} mine />
            <div className="cb-row"><Flaps text={vendor} width={vendor.length} className="cb-name" /><Flaps text={money(p.theirs.cents)} width={room.price.length} end className="cb-price" /></div>
            <Cells lit={CELLS} />
            <p className="cb-foot"><span>{byContacts(c) ? `${formatCount(p.usage.sent)} emails a month` : 'One recipient each'}</span><span>{vendor} {p.theirs.plan}</span></p>
          </div>
        </div>
        <div className="cb-console">
          <label className="cb-stencil" htmlFor={id}>{byContacts(c) ? 'Contacts' : 'Emails'}</label>
          <Fader c={c} size={size} onChange={setSize} id={id} />
          <Link className="cb-key" to={calculatorPath(p.usage)}><span className="cb-try">Try your numbers<ArrowRight size={18} strokeWidth={2} aria-hidden="true" /></span></Link>
        </div>
      </div>
    </div>
    <div className="cb-slab" aria-hidden="true" />
    <div className="cb-wrap cb-below">
      <p className="cb-note">{c.assume} <Checked source={{ checked: CHECKED, url: c.offer.pricing }} /></p>
      <section className="cb-has" aria-labelledby="cb-has"><h2 id="cb-has"><Mark className="cb-mark-has" /> has</h2>
        <ul>{c.ours.map(fact => <li key={fact.text}><Check size={16} strokeWidth={2.25} aria-hidden="true" />{fact.short ?? fact.text}</li>)}</ul>
      </section>
      <Disclosure className="price-small cb-print" headingAs="h2" title="Sources and small print">
        <p className="price-note">{c.usage} Monthly billing, list prices before tax, no promotions. <Checked source={{ checked: CHECKED, url: c.offer.pricing }} /></p>
        <p className="price-note">Nightmail charges {nightmail.perThousand} per 1,000 emails after {formatCount(nightmail.freeSent)} free a month.</p>
        <Terms floor={null} />
        <ul className="price-facts">{c.ours.map(fact => <li key={fact.text}>{fact.text}{fact.source && <Cite source={fact.source} />}</li>)}</ul>
        <CheckedOn facts={c.ours} />
      </Disclosure>
    </div>
    <div className="cb-slab" aria-hidden="true" />
  </section>
}

/** The wordmark across the page's end, as the homepage ends (end-band.tsx), in the machine's tones, measured before
 *  the first paint. */
export function BoardEnd() {
  const dark = useTheme().theme === 'dark'
  const ref = useRef<HTMLDivElement>(null), [W, setW] = useState(0)
  useLayoutEffect(() => {
    const node = ref.current!, measure = () => setW(node.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const phone = W < 900, inset = { left: 0, right: 0, bottom: 0 }, band = W ? endBand(W, phone, inset) : null
  return <div className="cb-end" ref={ref} style={{ ...toneVars(dark), height: band?.h } as CSSProperties}>{band && <EndBand W={W} phone={phone} inset={inset} />}</div>
}
