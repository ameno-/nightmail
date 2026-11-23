import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { ArrowRight, Check } from 'lucide-react'
import { Disclosure } from '../../components/ui'
import { useTheme } from '../../lib/theme'
import { EndBand, endBand } from '../home/end-band'
import { toneVars } from '../home/tones'
import { calculatorPath, Checked, CheckedOn, Cite, Ours, Terms } from './content'
import { byContacts, fit, pointAt, Room, rooms, share, sizeOf, type Point } from './price-against'
import { CHECKED, claim, formatCount, money, nightmail, type Comparison } from './prices'

// The bars version of the price-against-a-price component in three visual directions, for one to be chosen
// (/compare/mailchimp?style=1, 2 or 3). The same working parts in each: a slider over the vendor's own published sizes,
// the two prices as bars on one scale with only Nightmail's in colour, the price the loudest thing, the assumption and
// its dated source in one line, the way into the calculator and the closed small print.
//   1. The machine: the homepage's factory goes on: the comparison on a machine's screen, its control on the cabinet
//      under it, on the factory's wall, and the wordmark across the page's end.
//   2. The poster: paper and ink, big figures, heavy bars, Nightmail's price riding the end of its bar.
//   3. The board: the hero's hanging boards: the two prices on split-flap tiles, the bars as rows of pigeonholes lit
//      from the left, the control and the button on a console under it.

export const STYLES = ['1', '2', '3'] as const
export type Style = (typeof STYLES)[number]

function useComparison(c: Comparison) {
  const room = useMemo(() => rooms(c), [c])
  const [size, setSize] = useState(() => fit(c, sizeOf(c, c.sizes[1] ?? c.use(c.steps[0]!))))
  return { room, size, setSize, p: pointAt(c, size) }
}
const unitOf = (c: Comparison) => byContacts(c) ? 'contacts' : 'emails a month'
const ours = (p: Point) => <Ours sent={p.usage.sent} received={p.usage.received}>{p.ours.text}</Ours>

/** The slider: a native range over the vendor's sizes (arrow keys, Home and End, a thumb to drag), a tick at each. */
function Fader({ c, size, onChange, id, className }: { c: Comparison; size: number; onChange: (size: number) => void; id: string; className: string }) {
  const at = c.steps.indexOf(size), last = c.steps.length - 1
  return <span className={`cs-fader ${className}`} style={{ '--at': at / last } as CSSProperties}>
    <input id={id} type="range" min={0} max={last} step={1} value={at} aria-valuetext={`${formatCount(size)} ${unitOf(c)}`}
      onChange={event => onChange(c.steps[Number(event.target.value)]!)} />
    <span className="cs-fader__ticks" aria-hidden="true">{c.steps.map((step, k) => <i key={step} style={{ '--k': k / last } as CSSProperties} data-on={k <= at || undefined} />)}</span>
  </span>
}

/** What both prices are for, said once under the picture, and where and when the competitor's was read. */
const Note = ({ c, className }: { c: Comparison; className: string }) =>
  <p className={className}>{c.assume} <Checked source={{ checked: CHECKED, url: c.offer.pricing }} /></p>

/** The way into the calculator at the chosen size. */
const Try = ({ p, className }: { p: Point; className: string }) =>
  <Link className={className} to={calculatorPath(p.usage)}><span className="cs-try">Try your numbers<ArrowRight size={18} strokeWidth={2} aria-hidden="true" /></span></Link>

/** What Nightmail has, in a row, and the closed small print. */
function Rest({ c, className }: { c: Comparison; className: string }) {
  return <div className={`cs-rest ${className}`}>
    <section className="cs-has" aria-labelledby="cs-has"><h2 id="cs-has">Nightmail has</h2>
      <ul>{c.ours.map(fact => <li key={fact.text}><Check size={16} strokeWidth={2.25} aria-hidden="true" />{fact.short ?? fact.text}</li>)}</ul>
    </section>
    <Disclosure className="price-small cs-small" headingAs="h2" title="Sources and small print">
      <p className="price-note">{c.usage} Monthly billing, list prices before tax, no promotions. <Checked source={{ checked: CHECKED, url: c.offer.pricing }} /></p>
      <p className="price-note">Nightmail charges {nightmail.perThousand} per 1,000 emails after {formatCount(nightmail.freeSent)} free a month.</p>
      <Terms floor={null} />
      <ul className="price-facts">{c.ours.map(fact => <li key={fact.text}>{fact.text}{fact.source && <Cite source={fact.source} />}</li>)}</ul>
      <CheckedOn facts={c.ours} />
    </Disclosure>
  </div>
}

/** The wordmark across the page's end, as the homepage ends (end-band.tsx), measured before the first paint. */
function EndOfPage() {
  const ref = useRef<HTMLDivElement>(null), [W, setW] = useState(0)
  useLayoutEffect(() => {
    const node = ref.current!, measure = () => setW(node.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const phone = W < 900, inset = { left: 0, right: 0, bottom: 0 }, band = W ? endBand(W, phone, inset) : null
  return <div className="cs-end" ref={ref} style={band ? { height: band.h } : undefined}>{band && <EndBand W={W} phone={phone} inset={inset} />}</div>
}

// ── 1. The machine ──
function Machine({ c }: { c: Comparison }) {
  const { room, size, setSize, p } = useComparison(c), id = useId(), vendor = c.offer.vendor
  return <section className="cs1-hall" aria-labelledby="cs-title">
    <div className="cs-wrap">
      <h1 id="cs-title" className="cs1-title">{claim(c)}</h1>
      <div className="cs1-machine">
        <div className="cs1-screen" style={{ '--share': share(p) } as CSSProperties} aria-live="polite">
          <p className="cs1-status"><span>Price a month</span><span>{byContacts(c) ? `${formatCount(size)} contacts · ${formatCount(p.usage.sent)} emails a month` : `${formatCount(size)} emails a month`}</span></p>
          <div className="cs1-chart">
            <p className="cs1-name">Nightmail</p>
            <p className="cs1-price cs1-ours"><Room widest={room.theirs}>{ours(p)}</Room></p>
            <span className="cs1-bar cs1-ours" aria-hidden="true"><i /></span>
            <p className="cs1-name">{vendor}</p>
            <p className="cs1-price"><Room widest={room.theirs}>{money(p.theirs.cents)}</Room></p>
            <span className="cs1-bar" aria-hidden="true"><i /></span>
            <p className="cs1-plan"><Room widest={room.plan}>{p.theirs.plan}</Room></p>
          </div>
        </div>
        <div className="cs1-base">
          <label className="cs1-stencil" htmlFor={id}>{byContacts(c) ? 'Contacts' : 'Emails'}</label>
          <Fader c={c} size={size} onChange={setSize} id={id} className="cs1-fader" />
          <span className="cs1-plate" aria-hidden="true"><Room widest={room.size}>{formatCount(size)}</Room></span>
          <i className="cs1-lamp" aria-hidden="true" />
        </div>
        <span className="cs1-feet" aria-hidden="true"><i /><i /></span>
      </div>
    </div>
    <div className="cs1-floor" aria-hidden="true" />
    <div className="cs-wrap cs1-after">
      <Note c={c} className="cs1-note" />
      <Try p={p} className="cs-key" />
      <Rest c={c} className="cs1-rest" />
    </div>
    <div className="cs1-floor" aria-hidden="true" />
  </section>
}

// ── 2. The poster ──
function Poster({ c }: { c: Comparison }) {
  const { room, size, setSize, p } = useComparison(c), id = useId(), vendor = c.offer.vendor
  return <div className="cs2">
    <section className="cs-wrap cs2-hero" aria-labelledby="cs-title">
      <h1 id="cs-title" className="cs2-title">{claim(c)}</h1>
      <div className="cs2-control">
        <label htmlFor={id}>{byContacts(c) ? 'Contacts on your list' : 'Emails you send a month'}</label>
        <p className="cs2-readout"><b><Room widest={room.size}>{formatCount(size)}</Room></b><span>{byContacts(c) ? <><Room widest={room.emails}>{formatCount(p.usage.sent)}</Room> emails a month</> : 'emails a month'}</span></p>
        <Fader c={c} size={size} onChange={setSize} id={id} className="cs2-fader" />
      </div>
      <div className="cs2-bars" style={{ '--share': share(p) } as CSSProperties} aria-live="polite">
        <p className="cs2-name">Nightmail <span>a month</span></p>
        <div className="cs2-track cs2-ours"><i aria-hidden="true" /><b><Room widest={room.theirs}>{ours(p)}</Room></b></div>
        <p className="cs2-name">{vendor} <span><Room widest={room.plan}>{p.theirs.plan}</Room></span></p>
        <div className="cs2-track"><i aria-hidden="true" /><b><Room widest={room.theirs}>{money(p.theirs.cents)}</Room></b></div>
      </div>
      <Note c={c} className="cs2-note" />
      <Try p={p} className="cs-key cs2-key" />
      <Rest c={c} className="cs2-rest" />
    </section>
    {/* The close: the homepage's own last line, on the factory's wall, and the way in. */}
    <section className="cs2-close" aria-label="Nightmail's price">
      <div className="cs1-floor" aria-hidden="true" />
      <div className="cs-wrap cs2-close-in">
        <p className="cs2-price"><span>{nightmail.perThousand} per 1,000 emails, sent or received.</span> <span>That’s the whole bill.</span></p>
        <Link className="cs-key" to="/"><span className="cs-try">Get started<ArrowRight size={18} strokeWidth={2} aria-hidden="true" /></span></Link>
      </div>
      <div className="cs1-floor" aria-hidden="true" />
    </section>
  </div>
}

// ── 3. The board ──
/** Split-flap tiles: a tile a character, padded to a fixed count so the board never changes size; a tile whose
 *  character changes flips over to it. */
function Flaps({ text, width, end, className }: { text: string; width: number; end?: boolean; className: string }) {
  const chars = (end ? text.padStart(width) : text.padEnd(width)).toUpperCase().split('')
  return <span className={`cs3-flaps ${className}`} aria-hidden="true">{chars.map((ch, i) =>
    <span key={`${i}:${ch}`} className="cs3-flap" style={{ '--i': i } as CSSProperties} data-blank={ch === ' ' || undefined}><span>{ch}</span></span>)}</span>
}
/** A bar as a row of pigeonholes on one scale: the competitor's price fills every one, Nightmail's its share, lit from
 *  the left in turn. */
const CELLS = 40
function Cells({ lit, mine }: { lit: number; mine?: boolean }) {
  return <span className="cs3-cells" data-mine={mine || undefined} aria-hidden="true">{Array.from({ length: CELLS }, (_, i) =>
    <i key={i} style={{ '--i': i } as CSSProperties} data-on={i < lit || undefined} />)}</span>
}
function Board({ c }: { c: Comparison }) {
  const { room, size, setSize, p } = useComparison(c), id = useId(), vendor = c.offer.vendor
  const lit = p.ours.uc === 0n ? 0 : Math.max(1, Math.round(CELLS * share(p))), width = room.theirs.length, nameWidth = Math.max(9, vendor.length)
  return <section className="cs3-hall" aria-labelledby="cs-title">
    <div className="cs-wrap">
      <h1 id="cs-title" className="cs3-title">{claim(c)}</h1>
      <div className="cs3-hang" aria-hidden="true"><i /><i /></div>
      <div className="cs3-board" aria-live="polite">
        <div className="cs3-face">
          <p className="cs3-head"><span>A month at</span><Flaps text={formatCount(size)} width={room.size.length} end className="cs3-small" /><span>{unitOf(c)}</span></p>
          <p className="sr-only">{formatCount(size)} {unitOf(c)}{byContacts(c) && `, ${formatCount(p.usage.sent)} emails a month`}: Nightmail {p.ours.text}, {vendor} {money(p.theirs.cents)} a month.</p>
          <div className="cs3-row cs3-mine"><Flaps text="Nightmail" width={nameWidth} className="cs3-name" /><Flaps text={p.ours.text} width={width} end className="cs3-price" /></div>
          <Cells lit={lit} mine />
          <div className="cs3-row"><Flaps text={vendor} width={nameWidth} className="cs3-name" /><Flaps text={money(p.theirs.cents)} width={width} end className="cs3-price" /></div>
          <Cells lit={CELLS} />
          <p className="cs3-foot"><span>{byContacts(c) ? `${formatCount(p.usage.sent)} emails a month` : 'One recipient each'}</span><span>{vendor} {p.theirs.plan}</span></p>
          <span className="sr-only"><Ours sent={p.usage.sent} received={p.usage.received}>{p.ours.text}</Ours></span>
        </div>
      </div>
      <div className="cs3-console">
        <label className="cs3-stencil" htmlFor={id}>{byContacts(c) ? 'Contacts' : 'Emails'}</label>
        <Fader c={c} size={size} onChange={setSize} id={id} className="cs3-fader" />
        <Try p={p} className="cs-key cs3-key" />
      </div>
      <Note c={c} className="cs3-note" />
      <Rest c={c} className="cs3-rest" />
    </div>
    <div className="cs1-floor" aria-hidden="true" />
  </section>
}

export function ComparisonStyle({ comparison: c, style }: { comparison: Comparison; style: Style }) {
  return <div className={`cs cs--${style}`}>
    {style === '1' ? <Machine c={c} /> : style === '2' ? <Poster c={c} /> : <Board c={c} />}
  </div>
}

/** Under the page's last line, the wordmark across its end, in the machine's tones. */
export function StyleEnd() {
  const dark = useTheme().theme === 'dark'
  return <div className="cs-endwrap" style={toneVars(dark) as CSSProperties}><EndOfPage /></div>
}
