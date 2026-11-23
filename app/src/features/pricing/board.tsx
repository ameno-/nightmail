import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { AnomalyLogo } from '../../components/AnomalyLogo'
import { NightmailWordmark } from '../../components/NightmailLogo'
import { SignInConsent } from '../../components/LegalLinks'
import { EndBand, endBand } from '../home/end-band'
import { toneVars } from '../home/tones'
import { calculatorPath, Checked, CheckedOn, Cite, Ours, Terms } from './content'
import { Features } from './features'
import { FlapRow } from './splitflap'
import { PRICE_LINKS } from './live'
import { Bolts, keySound, reducedMotion, SoundSwitch, useReplay, useTypedWord } from './eggs'
import { play, wake } from './sound'
import { CHECKED, claim, formatCount, money, nightmail, nightmailBill, theirPrice, ucOf, type Comparison, type Usage } from './prices'

// A comparison page (/compare/mailchimp, /compare/resend): the two prices on a board hung in the homepage's factory, as
// its hero's boards hang. The reader's own size is set on a fader on the console under it, over the vendor's own
// published sizes (comparison.steps: each one priced by the vendor and cheaper on Nightmail, as the pre-merge check
// proves). On the board: the prices on split-flap tiles (lit for Nightmail, unlit for the competitor), which turn as
// a real split-flap board's do (splitflap.tsx), and each price as a bar of forty pigeonholes on one scale, the
// competitor's every one, Nightmail's its share, lit in the homepage's periwinkle, the only colour, a pigeonhole at a
// time. Along the board's foot, its small print: what both prices are for, the plan, and the day and page the
// competitor's was read on. The console under it has the fader and the page's two ways on, Get started (the key) and Try your numbers. Then what else Nightmail does
// (features.tsx, a wall of the homepage machine's concrete), the close with Get started again, and the page's end
// (BoardEnd): the homepage's row of links with Sources, and the wordmark. The page is the same scene in either theme.
// Every figure keeps the room of the widest it can show, so nothing moves as the fader does.
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

/** Nightmail's wordmark, read as the word. */
const Mark = ({ className }: { className: string }) => <NightmailWordmark className={`cb-mark ${className}`} title="Nightmail" />
/** The headline, with the wordmark in the place of the word. */
const Claim = ({ text }: { text: string }) => <>{text.split('Nightmail').map((part, i) => <span key={i}>{i > 0 && <Mark className="cb-mark-title" />}{part}</span>)}</>

/** A price as a row of pigeonholes on one scale: the competitor's fills every one, Nightmail's its share. They fill and
 *  empty a pigeonhole at a time, at the tiles' cadence, from where the bar ends (each one's --k: its place in the
 *  change), and fill from empty as the page opens. */
const CELLS = 40
function Cells({ lit, mine, settle }: { lit: number; mine?: boolean; settle?: boolean }) {
  const [shown, setShown] = useState(settle ? 0 : lit), was = useRef(shown)
  useEffect(() => { setShown(lit) }, [lit])
  useEffect(() => { was.current = shown }, [shown])
  const from = was.current
  return <span className="cb-cells" data-mine={mine || undefined} aria-hidden="true">{Array.from({ length: CELLS }, (_, i) =>
    <i key={i} style={{ '--k': shown > from ? i - from : from - 1 - i } as CSSProperties} data-on={i < shown || undefined} />)}</span>
}
/** The fader: a native range over the vendor's sizes (arrow keys, Home and End, a cap to drag), a tick at each. */
/** At either end its cap knocks on the stop (`bump` replays it), arriving there or pushed against it. */
function Fader({ c, size, onChange, onStop, bump, id }: { c: Comparison; size: number; onChange: (size: number) => void; onStop: () => void; bump?: string; id: string }) {
  const at = c.steps.indexOf(size), last = c.steps.length - 1
  return <span className="cb-fader" data-bump={bump} style={{ '--at': at / last } as CSSProperties}>
    <input id={id} type="range" min={0} max={last} step={1} value={at} aria-valuetext={`${formatCount(size)} ${unitOf(c)}`}
      onChange={event => onChange(c.steps[Number(event.target.value)]!)}
      onKeyDown={event => { if ((at === 0 && ['ArrowLeft', 'ArrowDown', 'Home', 'PageDown'].includes(event.key)) || (at === last && ['ArrowRight', 'ArrowUp', 'End', 'PageUp'].includes(event.key))) onStop() }} />
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
  // The board's tiles settle from blank once, as the page opens, and its bars fill.
  const settled = useRef(false), settle = !settled.current
  useEffect(() => { settled.current = true }, [])
  const theirs = byContacts(c) ? [`${formatCount(p.usage.sent)} emails a month`, `${p.usage.sent / p.usage.contacts} to each contact`] : ['One recipient each', 'Nothing received']
  // The surprises (eggs.tsx): the lamp swings when it's clicked, and three quick clicks pull its cord (and one more puts
  // it back on); the board, clicked, turns every tile over as if its message were sent again; the fader's cap knocks on
  // its end stops; "night", typed, puts the light out and turns every tile on the page. A change of size turns the
  // tiles that change, each flap with its tick (splitflap.tsx).
  const [refresh, setRefresh] = useState(0), [swing, replaySwing] = useReplay(), [flip, replayFlip] = useReplay(), [bump, replayBump] = useReplay()
  const [lights, setLights] = useState<'on' | 'off'>()
  const clicks = useRef<number[]>([])
  const change = (next: number) => {
    const k = c.steps.indexOf(next)
    play('tick')
    if (k === 0 || k === c.steps.length - 1) stop()
    setSize(next)
  }
  const stop = () => { replayBump(); play('bump') }
  const toggleLights = () => { setLights(now => now === 'off' ? 'on' : 'off'); play('cord') }
  const lamp = () => {
    if (lights === 'off') return toggleLights()
    const now = performance.now()
    clicks.current = [...clicks.current.filter(at => now - at < 900), now]
    if (clicks.current.length >= 3) { clicks.current = []; return toggleLights() }
    if (!reducedMotion()) { replaySwing(); play('creak') }
  }
  // (The flaps tick a frame or two after the press, so the press itself wakes the sound.)
  useTypedWord('night', () => { wake(); toggleLights(); setRefresh(n => n + 1); if (!reducedMotion()) replayFlip() })
  const resend = (event: { target: EventTarget | null }) => { if (!(event.target as HTMLElement).closest('a, button, input')) { wake(); setRefresh(n => n + 1) } }
  const keys = { onPointerDown: (event: { pointerType: string; type: string; target: EventTarget | null }) => { if (event.pointerType === 'mouse') keySound(event) },
    onClick: (event: { nativeEvent: Event; type: string; target: EventTarget | null }) => { if ((event.nativeEvent as PointerEvent).pointerType !== 'mouse') keySound(event) } }
  return <section className="cb-hall" aria-labelledby="cb-title" data-frame={frame === 'steel' ? 'steel' : undefined} data-lights={lights} data-flip={flip}>
    <div className="cb-stage">
      <div className="cb-backdrop" aria-hidden="true" data-swing={swing}><i className="cb-pool" /><i className="cb-lamp" /><i className="cb-dark" /></div>
      <i className="cb-lamp-hit" aria-hidden="true" onClick={lamp} />
      <SoundSwitch />
      <div className="cb-wrap">
        <h1 id="cb-title" className="cb-title"><Claim text={claim(c)} /></h1>
        <div className="cb-hang" aria-hidden="true"><i /><i /></div>
        <div className="cb-board" aria-live="polite" onClick={resend}>
          <Bolts />
          <div className="cb-face">
            <p className="cb-head" aria-hidden="true"><span>A month at</span><FlapRow text={formatCount(size)} width={room.size.length} end className="cb-small" x={[.38, .56]} settle={settle} refresh={refresh} /><span>{byContacts(c) ? 'contacts' : 'emails'}</span></p>
            <p className="sr-only">{formatCount(size)} {unitOf(c)}{byContacts(c) && `, ${formatCount(p.usage.sent)} emails a month`}: Nightmail <Ours sent={p.usage.sent} received={p.usage.received}>{p.ours.text}</Ours>, {vendor} {money(p.theirs.cents)} a month.</p>
            <div className="cb-row cb-mine" aria-hidden="true"><Mark className="cb-mark-board" /><FlapRow text={p.ours.text} width={room.price.length} end className="cb-price" size="big" x={[.72, 1]} row={1} settle={settle} refresh={refresh} /></div>
            <Cells lit={lit} mine settle={settle} />
            <div className="cb-row"><FlapRow text={vendor} width={vendor.length} className="cb-name" size="name" x={[0, .32]} row={2} settle={settle} refresh={refresh} /><FlapRow text={money(p.theirs.cents)} width={room.price.length} end className="cb-price" size="big" x={[.72, 1]} row={2} settle={settle} refresh={refresh} /></div>
            <Cells lit={CELLS} settle={settle} />
            {/* The board's small print: what both prices are for, the plan, and where and when it was read. */}
            <div className="cb-foot"><p>{theirs.map(line => <span key={line}>{line}</span>)}</p><p><span>{vendor} {p.theirs.plan}, list price</span><Checked source={{ checked: CHECKED, url: c.offer.pricing }} /></p></div>
          </div>
        </div>
        {/* The console: the fader, then the page's two ways on: the calculator, quietly, and Get started, the key. What
            signing in agrees to stands under the key. */}
        <div className="cb-console" {...keys}>
          <Bolts />
          <label className="cb-stencil" htmlFor={id}>{byContacts(c) ? 'Contacts' : 'Emails'}</label>
          <Fader c={c} size={size} onChange={change} onStop={stop} bump={bump} id={id} />
          <Link className="cb-try" to={calculatorPath(p.usage)}>Try your numbers<ArrowRight size={17} strokeWidth={2} aria-hidden="true" /></Link>
          {start?.button('cb-key cb-key-start')}
        </div>
        {start && !start.signedIn && <SignInConsent className="cb-consent cb-consent-hero" />}
      </div>
    </div>
    <Features comparison={c} />
    {/* The close: the bill, and the way in again. */}
    <section className="cb-close" aria-labelledby="cb-close" {...keys}>
      <h2 id="cb-close" className="cb-bill"><span><b>{nightmail.perThousand}</b> per 1,000 emails, sent or received.</span> <span>Contacts and teammates are free.</span></h2>
      {start && <>{start.button('cb-key cb-key-start')}{!start.signedIn && <SignInConsent className="cb-consent" />}</>}
    </section>
  </section>
}

/** The page's end, as the homepage ends (machines.tsx, .mx-end): one small row of links on the scene's own dark, and
 *  the wordmark across the page's end (end-band.tsx) in the machine's night tones, measured before the first paint. The
 *  row is the homepage's (by Anomaly, API docs, Terms, Privacy) with the other price pages (not this one) and Sources,
 *  which opens the sources and small print in place under the row (#sources opens it too): the competitor's sourced
 *  facts, the pricing terms and the trademark line, which a legal review depends on. */
export function BoardEnd({ comparison: c }: { comparison: Comparison }) {
  const ref = useRef<HTMLElement>(null), [W, setW] = useState(0), [open, setOpen] = useState(false)
  // An envelope resting on the wordmark slides off when it's clicked, and another lands in its place.
  const nudge = (event: { target: EventTarget | null }) => {
    const letter = (event.target as Element).closest?.('.srt-rest') as SVGGElement | null
    if (!letter || letter.dataset.off || reducedMotion()) return
    letter.dataset.off = ''
    play('paper')
    window.setTimeout(() => { delete letter.dataset.off }, 2400)
  }
  useLayoutEffect(() => {
    const node = ref.current!, measure = () => setW(node.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { if (window.location.hash === '#sources') setOpen(true) }, [])
  const phone = W < 900, inset = { left: 0, right: 0, bottom: 0 }, band = W ? endBand(W, phone, inset) : null
  const here = `/compare/${c.offer.id}`
  return <footer className="mx-end cb-end" ref={ref} onClick={nudge} style={{ ...toneVars(true), ...band ? { '--mx-band': `${band.h}px` } : {} } as CSSProperties}>
    <nav aria-label="Site links">
      <a className="srt-by" href="https://anoma.ly" target="_blank" rel="noopener" title="Anomaly (opens in a new tab)">by <AnomalyLogo height={18} /></a>
      {PRICE_LINKS.filter(([path]) => path !== here).map(([path, label]) => <Link key={path} to={path}>{label}</Link>)}
      <button type="button" className="cb-sources-toggle" aria-expanded={open} aria-controls="sources" onClick={() => setOpen(now => !now)}>Sources</button>
      <a href="/docs">API docs</a><Link to="/legal/terms">Terms</Link><Link to="/legal/privacy">Privacy</Link>
    </nav>
    <section className="cb-sources" id="sources" hidden={!open} aria-labelledby="sources-title">
      <h2 id="sources-title" className="cb-sources-title">Sources and small print</h2>
      <p className="price-note">{c.assume} Monthly billing, no promotions. <Checked source={{ checked: CHECKED, url: c.offer.pricing }} /></p>
      <p className="price-note">Nightmail charges {nightmail.perThousand} per 1,000 emails after {formatCount(nightmail.freeSent)} free a month.</p>
      <Terms floor={null} />
      <ul className="price-facts">{c.ours.map(fact => <li key={fact.text}>{fact.text}{fact.source && <Cite source={fact.source} />}</li>)}</ul>
      <CheckedOn facts={c.ours} />
      <p className="price-note">Product names belong to their owners and only identify their products. Nightmail isn’t affiliated with them.</p>
    </section>
    {band && <EndBand W={W} phone={phone} inset={inset} />}
  </footer>
}
