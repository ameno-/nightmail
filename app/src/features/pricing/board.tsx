import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { Disclosure } from '../../components/ui'
import { NightmailWordmark } from '../../components/NightmailLogo'
import { SignInConsent } from '../../components/LegalLinks'
import { useTheme } from '../../lib/theme'
import { EndBand, endBand } from '../home/end-band'
import { toneVars } from '../home/tones'
import { calculatorPath, Checked, CheckedOn, Cite, Ours, Terms } from './content'
import { Flaps } from './flaps'
import { Features } from './features'
import { CHECKED, claim, formatCount, money, nightmail, nightmailBill, theirPrice, ucOf, type Comparison, type Usage } from './prices'

// A comparison page (/compare/mailchimp, /compare/resend): the two prices on a board hung in the homepage's factory, as
// its hero's boards hang. The reader's own size is set on a fader on the console under it, over the vendor's own
// published sizes (comparison.steps: each one priced by the vendor and cheaper on Nightmail, as the pre-merge check
// proves). On the board: the prices on split-flap tiles (lit for Nightmail, unlit for the competitor; a tile flips when
// its character changes) and each price as a bar of forty pigeonholes on one scale, the competitor's every one,
// Nightmail's its share, lit in the homepage's periwinkle, the only colour. Along the board's foot, its small print: what
// both prices are for, the plan, and the day and page the competitor's was read on. The console under it has the
// fader and the page's two ways on, Get started (the key) and Try your numbers. Then what else Nightmail does
// (features.tsx, a wall of the homepage machine's concrete), the close with Get started again, the small print, and
// the wordmark across the page's end.
// Every figure keeps the room of the widest it can show (Room), so nothing moves as the fader does.
// The board hangs on a dark wall under one pendant lamp, which comes down on its cord from the top of the window (the
// page has no bar: PriceFrame's scene). Nightmail is named by its wordmark wherever it is a display word: the headline
// and the board's lit row; each one's accessible name is "Nightmail".
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

/** The way in (board-page.tsx gives it: the homepage's Get started, or Open dashboard for someone signed in), drawn in
 *  a class of the page's. Without it (the pre-merge check's render) the page has no button. */
export type Start = { signedIn: boolean; button: (className: string) => ReactNode }

/** frame: 'steel' puts the board's frame and console back in the homepage's steel (?frame=steel), while the concrete
 *  they are in now waits for a yes. */
export function ComparisonBoard({ comparison: c, start, frame }: { comparison: Comparison; start?: Start; frame?: string | null }) {
  const room = useMemo(() => rooms(c), [c])
  const [size, setSize] = useState(() => opening(c))
  const p = pointAt(c, size), id = useId(), vendor = c.offer.vendor
  const lit = p.ours.uc === 0n ? 0 : Math.max(1, Math.round(CELLS * share(p)))
  const theirs = byContacts(c) ? [`${formatCount(p.usage.sent)} emails a month`, `${p.usage.sent / p.usage.contacts} to each contact`] : ['One recipient each', 'Nothing received']
  return <><section className="cb-hall" aria-labelledby="cb-title" data-frame={frame === 'steel' ? 'steel' : undefined}>
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
            {/* The board's small print: what both prices are for, the plan, and where and when it was read. */}
            <div className="cb-foot"><p>{theirs.map(line => <span key={line}>{line}</span>)}</p><p><span>{vendor} {p.theirs.plan}, list price</span><Checked source={{ checked: CHECKED, url: c.offer.pricing }} /></p></div>
          </div>
        </div>
        {/* The console: the fader, then the page's two ways on: the calculator, quietly, and Get started, the key. What
            signing in agrees to stands under the key. */}
        <div className="cb-console">
          <label className="cb-stencil" htmlFor={id}>{byContacts(c) ? 'Contacts' : 'Emails'}</label>
          <Fader c={c} size={size} onChange={setSize} id={id} />
          <Link className="cb-try" to={calculatorPath(p.usage)}>Try your numbers<ArrowRight size={17} strokeWidth={2} aria-hidden="true" /></Link>
          {start?.button('cb-key cb-key-start')}
        </div>
        {start && !start.signedIn && <SignInConsent className="cb-consent cb-consent-hero" />}
      </div>
    </div>
    <Features comparison={c} />
    {/* The close: the bill, and the way in again. */}
    <section className="cb-close" aria-labelledby="cb-close">
      <h2 id="cb-close" className="cb-bill"><span><b>{nightmail.perThousand}</b> per 1,000 emails, sent or received.</span> <span>That’s the whole bill.</span></h2>
      {start && <>{start.button('cb-key cb-key-start')}{!start.signedIn && <SignInConsent className="cb-consent" />}</>}
    </section>
  </section>
  {/* The small print, closed, on the page's own ground with its last links (index.tsx, PriceFrame). */}
  <div className="cb-fine">
    <Disclosure className="price-small cb-print" headingAs="h2" title="Sources and small print">
      <p className="price-note">{c.assume} Monthly billing, no promotions. <Checked source={{ checked: CHECKED, url: c.offer.pricing }} /></p>
      <p className="price-note">Nightmail charges {nightmail.perThousand} per 1,000 emails after {formatCount(nightmail.freeSent)} free a month.</p>
      <Terms floor={null} />
      <ul className="price-facts">{c.ours.map(fact => <li key={fact.text}>{fact.text}{fact.source && <Cite source={fact.source} />}</li>)}</ul>
      <CheckedOn facts={c.ours} />
    </Disclosure>
  </div>
  </>
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
