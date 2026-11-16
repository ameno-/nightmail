import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ThemeToggle } from '../../components/ThemeToggle'
import { SignInConsent } from '../../components/LegalLinks'
import { PrivateAddress } from '../../components/PrivateAddress'
import { NightmailMark } from '../../components/NightmailLogo'
import { useTheme } from '../../lib/theme'
import { productName } from '../../../../api/src/brand'
import type { HomeProps } from '.'
import { DashboardLink, StartButton } from './start'
import { DX, DY, onFront, plan, type Plan, type Rect } from './sorter/plan'
import { drawStill } from './sorter/still'
import { toneVars } from './sorter/tones'
import { COLS } from './sorter/price'
import { Stations } from './sorter-stations'
import type { Hooks, Letter, Phase, Sorter } from './sorter/engine'
import './sorter-home.css'

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// The homepage: the page is a mail-sorting machine. Letters fall into its hopper, are read, and leave by the
// tube for wherever they are routed; the price of a thousand of them is spelt by the thousand letters filed in its
// sorting frame. It runs faster and faster until it bursts, and the letters settle where they fall. Below it the tubes
// run on down the page to each place mail can go. The price is api/src/billing/money.ts's rate, the response time the
// API's acceptance time as measured on 2026-11-15.
const SEEN = 'sorter.seen'
/** The seven routes by the names the product uses (a phone's machine has a lane for four of them: sorter/plan.ts); a scam's route is the laser. */
export const LANE_NAMES = ['Threads', 'Endpoints', 'Agents', 'Inbox', 'IMAP', 'Rituals', 'Campaigns'] as const
/** The same where a lane's plate is too narrow for its name. */
const LANE_CODES = ['Thr', 'End', 'Agt', 'Inb', 'IMAP', 'Rit', 'Cmp'] as const
/** Where each of the eight tubes leads, in the tubes' own order (sorter/plan.ts). */
const TUBE_NAMES = ['Inbox', 'Agents', 'Endpoints', 'Threads', 'IMAP', 'Rituals', 'Campaigns', 'Logs'] as const
const TUBE_CODES = ['Inb', 'Agt', 'End', 'Thr', 'IMAP', 'Rit', 'Cmp', 'Logs'] as const
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']

export function SorterHome({ start, notice }: HomeProps) {
  // Signed in, there is nothing to agree to: no consent under the buttons.
  const visitor = start.signedIn ? null : start
  const dark = useTheme().theme === 'dark'
  const scene = useRef<HTMLElement>(null), still = useRef<HTMLCanvasElement>(null), gl = useRef<HTMLCanvasElement>(null), sorter = useRef<Sorter | null>(null)
  const head = useRef<HTMLElement>(null), probe = useRef<HTMLDivElement>(null)
  const veiled = useRef<(HTMLElement | null)[]>([]), tally = useRef<HTMLSpanElement>(null), cta = useRef<HTMLElement>(null)
  const readout = useRef<HTMLDivElement>(null), cardBox = useRef<HTMLDivElement>(null), counts = useRef([0, 0]), shown = useRef<Letter | null>(null)
  // `over`: how far the canvases reach up behind the header (its height, with a phone's status bar where the page runs under one).
  const [p, setP] = useState<Plan | null>(null), [over, setOver] = useState(64)
  const [reduced] = useState(reducedMotion)
  // Whoever has watched it burst once gets there sooner the next time.
  const [quick] = useState(() => { try { return localStorage.getItem(SEEN) === '1' } catch { return false } })
  const [phase, setPhase] = useState<Phase>('boot'), [live, setLive] = useState(false), [card, setCard] = useState<Letter | null>(null)
  // Which lanes the machine has so far: it begins with one and is fitted with the rest (sorter/plan.ts `fit`). A
  // lane's plate carries its name once its works are in.
  const [fitted, setFitted] = useState<boolean[] | null>(null)
  // And how much of the tower stands: it begins as its foot and the price's frame with the roof on them, and the
  // sorting floor and the console are slid in under the roof (sorter/engine.ts). What the page writes on a floor is
  // not there before the floor is; `whole`: fitted out, with everything on it that can be pressed.
  const [tower, setTower] = useState(() => ({ floors: reduced ? 2 : 0, whole: reduced }))

  // What the machine tells the page: the letter under the scanner, the tally, where it is in its day, the letter under the pointer.
  const [hooks] = useState<Hooks>(() => ({
    scan(letter, verdict) {
      const box = readout.current
      if (!box) return
      // (Where the letter goes is set at the readout's right, so a new name begins somewhere else: it is a new
      // element each time, not one that moves.)
      const [from, subject, route] = box.children as unknown as HTMLElement[], go = (text: string) => { const tag = document.createElement('span'); tag.textContent = text; route.replaceChildren(...text ? [tag] : []) }
      box.dataset.verdict = verdict
      if (letter) { from.textContent = letter.from; subject.textContent = letter.subject; go(letter.scam ? 'Scam' : LANE_NAMES[letter.route]) }
      else if (verdict === 'jam') { from.textContent = `${counts.current[0]} sorted, ${counts.current[1]} burnt`; subject.textContent = 'Jammed. Press the gauge.'; go('') }
      else { from.textContent = `${productName.toLowerCase()} sorter`; subject.textContent = 'Waiting for mail'; go('') }
    },
    count(sorted, burnt) { counts.current = [sorted, burnt]; if (tally.current) tally.current.textContent = String(sorted % 100000).padStart(5, '0') },
    phase(next) { setPhase(next); if (next === 'boom') try { localStorage.setItem(SEEN, '1') } catch { /* private mode: the long version again next time */ } },
    // Smoke in front of what is written on the machine hides it, as it hides the machine.
    floors(count, whole) { setTower(now => now.floors === count && now.whole === whole ? now : { floors: count, whole }) },
    fit(lanes) { setFitted(now => now && now.length === lanes.length && now.every((on, i) => on === lanes[i]) ? now : lanes) },
    veil(zone, clear) { const el = zone === 0 ? readout.current : veiled.current[zone]; if (el) el.style.opacity = clear >= 1 ? '' : String(clear) },
    hover(letter, x, y) {
      if (letter !== shown.current) { shown.current = letter; setCard(letter) }
      if (!letter || !cardBox.current) return
      // The card stays on the page: clear of both edges, and of the top (under the letter where there is no room over
      // it). And it never covers the button: it goes to the letter's other side, or beside the button, or is not shown.
      const width = scene.current?.clientWidth ?? 0, half = (width < 900 ? 232 : 264) / 2 + 8, tall = 136, key = cta.current
      let cx = Math.min(width - half, Math.max(half, x)), under = y < 176, show = true
      if (key) {
        const l = key.offsetLeft - 10, r = l + key.offsetWidth + 20, t = key.offsetTop - 10, b = t + key.offsetHeight + 20
        const hits = (at: number, below: boolean) => at - half < r && at + half > l && (below ? y + 22 < b && y + 22 + tall > t : y - 16 > t && y - 16 - tall < b)
        if (hits(cx, under)) {
          if (!hits(cx, !under) && (under ? y - 16 - tall > 24 : true)) under = !under
          else { const beside = x < (l + r) / 2 ? l - half : r + half; if (beside >= half && beside <= width - half) cx = beside; else show = false }
        }
      }
      cardBox.current.style.translate = `${Math.round(cx)}px ${Math.round(Math.max(24, y))}px`; cardBox.current.toggleAttribute('data-under', under); cardBox.current.style.visibility = show ? '' : 'hidden'
    },
  }))

  // Before the first paint: measure the page and place the machine, so nothing moves afterwards.
  useLayoutEffect(() => {
    // (The probe is as tall as the page is under the header before any scrolling, by the small viewport: a phone's
    // toolbars coming and going do not change it. Its padding is the page's safe areas.)
    const measure = () => {
      const fold = probe.current!, safe = getComputedStyle(fold), next = plan(scene.current!.clientWidth, fold.offsetHeight, { left: parseFloat(safe.paddingLeft) || 0, right: parseFloat(safe.paddingRight) || 0, bottom: parseFloat(safe.paddingBottom) || 0 }, !start.signedIn)
      setP(now => now && now.W === next.W && now.H === next.H && now.fold === next.fold && now.ox === next.ox ? now : next); setOver(head.current!.offsetHeight)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scene.current!); observer.observe(probe.current!); observer.observe(head.current!)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => { if (p) drawStill(still.current!, p, over, dark, reduced) }, [p, over, dark, reduced])

  // After the first paint: fetch the engine and start it; then the letters.
  useEffect(() => {
    if (!p) return
    if (sorter.current) { sorter.current.setPlan(p, over); return }
    let cancelled = false
    const start = async () => {
      const [{ mountSorter }, { STARTERS, loadLetters }] = await Promise.all([import('./sorter/engine'), import('./sorter/letters')])
      if (cancelled || sorter.current) return
      const mounted = mountSorter(gl.current!, { plan: p, over, dark: document.documentElement.dataset.theme === 'dark', reduced, quick, letters: STARTERS, hooks })
      if (!mounted) return
      sorter.current = mounted; setLive(true)
      loadLetters().then(letters => sorter.current?.setLetters(letters)).catch(() => { /* the machine keeps its first dozen */ })
    }
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => void start()))
    return () => { cancelled = true; cancelAnimationFrame(frame) }
  }, [p, over, reduced, quick, hooks])
  useEffect(() => () => { sorter.current?.destroy(); sorter.current = null }, [])
  useEffect(() => { sorter.current?.setTheme(dark) }, [dark])
  // Off screen the machine stands still.
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => sorter.current?.setVisible(entry.isIntersecting), { threshold: .02 })
    observer.observe(scene.current!)
    return () => observer.disconnect()
  }, [])
  // `?perf`: a frame meter in the corner, for checking pace on a real phone.
  useEffect(() => { if (new URLSearchParams(location.search).has('perf')) void import('./sorter/meter').then(meter => meter.mountMeter()) }, [])
  // The old code brings the flood.
  useEffect(() => {
    let at = 0
    const onKey = (event: KeyboardEvent) => {
      at = event.key === KONAMI[at] ? at + 1 : event.key === KONAMI[0] ? 1 : 0
      // Two ups in, the arrows belong to the code: the page doesn't scroll under it (nor rubber-band at its top).
      if (event.key.startsWith('Arrow') && (at > 2 || (event.key === 'ArrowUp' && window.scrollY <= 0))) event.preventDefault()
      if (at === KONAMI.length) { at = 0; sorter.current?.rain() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const at = (r: Rect): CSSProperties => p ? onFront(p, r) : { display: 'none' }
  const price = p ? { x: -COLS / 2 * p.U, w: COLS * p.U } : { x: 0, w: 0 }
  // Whole names where a lane's plate holds them; the lanes' codes where it does not.
  const named = !!p && p.label * p.P >= (p.phone ? 56 : 60)
  const cannonBox = (c: Plan['cannon'], q: Plan) => { const sx = DX * c.z, sy = DY * c.z, ce = Math.cos(c.el), se = Math.sin(c.el), x0 = c.x - c.back * ce - 2.4 * c.cs, x1 = c.x + c.fore * ce + c.r, top = c.y + c.pivot + c.fore * se + c.r, w = Math.max(44, x1 - x0 + 8), h = Math.max(44, top - c.y + 8)
    return { left: q.ox + (x0 + x1) / 2 + sx - w / 2, top: q.oy - top - sy - 4 - (h - (top - c.y + 8)), width: w, height: h } }
  // The hopper's mouth, as it is seen: wide enough to press.
  const hopperBox = (q: Plan) => { const w = Math.max(48, 2.6 * q.lw), h = Math.max(44, q.hopper * .82 + 12), x = DX * q.zL, y = DY * q.zL; return { left: q.ox + x - w / 2, top: q.oy - q.yTop - y - h, width: w, height: h } }
  return <div className="srt-page" data-phase={phase} data-live={live || undefined} data-phone={p?.phone || undefined} data-tight={p?.tight || undefined} data-floors={tower.floors} data-whole={tower.whole || undefined} style={{ ...toneVars(dark), ...p && { '--srt-u': `${p.U}px`, '--srt-v': `${p.V}px`, '--srt-price': `${price.w}px`, '--srt-below': `${p.floor - p.front - p.lip}px`, '--srt-ext': `${p.ext}px`, '--srt-ox': `${p.ox}px`, '--srt-plate': `${p.label * p.P}px` } } as CSSProperties}>
    <header className="srt-header" ref={head}>
      {/* The monogram alone: the wordmark is in lights on the machine, over the price (sorter/name.ts). */}
      <a className="srt-mark" href="/" aria-label={`${productName.toLowerCase()} home`}><NightmailMark /></a>
      <nav className="srt-nav" aria-label="Site">
        <a href="/docs">API docs</a>
        {/* Signed in, the way into the dashboard; signed out, where the page is too short for the machine's own button to
            be seen before scrolling, the button. */}
        {visitor ? p?.short && <button type="button" className="srt-head-cta" disabled={visitor.busy} aria-busy={visitor.busy || undefined} onClick={visitor.onSignIn} onPointerDown={visitor.onSignInIntent}>Get started</button> : <DashboardLink>Dashboard</DashboardLink>}
        <ThemeToggle />
      </nav>
    </header>

    <main>
      <section className="srt-hero" ref={scene} style={p ? { height: p.H } : undefined} aria-label="Pricing">
        <div className="srt-fold" ref={probe} aria-hidden="true" />
        <canvas ref={still} className="srt-canvas" aria-hidden="true" />
        <canvas ref={gl} className="srt-canvas srt-gl" aria-hidden="true" />
        {p && <div className="srt-on">
          {/* On the fascia: what the scanner is reading, and the gauge (press it and see). */}
          <div className="srt-readout" ref={readout} style={at(p.readout)} data-verdict="idle" aria-hidden="true">
            <span className="srt-readout-from">{productName.toLowerCase()} sorter</span><span className="srt-readout-subject">Waiting for mail</span><span className="srt-readout-route" />
          </div>
          <button type="button" className="srt-gauge" style={at({ x: p.gauge.x - p.gauge.r - 5, y: p.gauge.y - p.gauge.r - 5, w: 2 * p.gauge.r + 10, h: 2 * p.gauge.r + 10 })} aria-label={phase === 'rest' ? 'Put the sorter back together' : 'Pressure gauge'} title={phase === 'rest' ? 'Put it back together' : 'Pressure'} onClick={() => sorter.current?.gauge()} />
          <ol className="srt-lanes" data-names={!p.phone && named || undefined} ref={el => { veiled.current[1] = el }} aria-hidden="true">{p.lanes.map((x, i) => <li key={i} data-off={!(fitted && fitted.length === p.lanes.length ? fitted[i] : reduced) || undefined} style={at({ x: x - p.label / 2 * p.P, y: p.ySlot + .14 * p.slot, w: p.label * p.P, h: .72 * p.slot })}>{(named ? LANE_NAMES : LANE_CODES)[p.routes[i]]}</li>)}</ol>
          {/* On a wide page, the name on each unit plugged onto the tower's side: there once its lane is. */}
          {p.pods.length > 0 && <ol className="srt-lanes srt-pods" aria-hidden="true">{p.pods.map((pod, k) => <li key={k} data-off={!(fitted && fitted.length === p.lanes.length ? fitted[pod.lane] : reduced) || undefined} style={{ left: p.ox + pod.x + .5 * p.U + DX * pod.z, top: p.oy - pod.y - 2.3 * p.U - DY * pod.z, width: pod.w - 2.2 * p.U, height: 1.4 * p.U }}>{(pod.w - 2.2 * p.U >= 57 ? LANE_NAMES : LANE_CODES)[p.routes[pod.lane]]}</li>)}</ol>}
          {/* The hopper: press it and more mail comes down (what the old code does from a keyboard). */}
          {!reduced && <button type="button" className="srt-hopper" style={hopperBox(p)} aria-label="Hopper: pour in more mail" title="More mail" onMouseDown={event => event.preventDefault()} onClick={() => sorter.current?.rain()} />}
          {/* The send cannon: press it and it fires one. */}
          {!reduced && <button type="button" className="srt-cannon" style={cannonBox(p.cannon, p)} aria-label="Send cannon: fire a letter" title="Send one" onMouseDown={event => event.preventDefault()} onClick={() => sorter.current?.send()} />}
          {!p.phone && <ol className="srt-lanes srt-mouths" aria-hidden="true">{p.drops.map((x, t) => <li key={t} data-side={t < 4 ? 'l' : 'r'} style={{ top: p.oy + p.front, height: p.lip, ...(t < 4 ? { left: x + p.tubeR + 7 } : { right: p.W - x + p.tubeR + 9 }) }}>{(Math.abs(p.fan[1].x - p.fan[0].x) < 84 ? TUBE_CODES : TUBE_NAMES)[t]}</li>)}<li data-side="r" style={{ top: p.oy + p.front, height: p.lip, right: p.W - p.ox - p.out + p.tubeR + 9 }}>{Math.abs(p.fan[1].x - p.fan[0].x) < 84 ? 'Out' : 'Outbound'}</li></ol>}
          {/* Under the price, as wide as the price: what it buys. */}
          <h1 className="srt-band" ref={el => { veiled.current[2] = el }} style={at({ x: price.x, y: p.yBand, w: price.w, h: p.band })} aria-label="$0.20 per 1,000 emails, sent or received via API.">
            <span className="srt-line" aria-hidden="true">
              <span className="srt-row"><span>per</span><span>1,000</span><span>emails,</span></span>
              <span className="srt-row srt-row-wide"><span>sent</span><span>or</span><span>received</span><span>via</span><span className="srt-last">API<span className="srt-stop">.</span></span></span>
            </span>
          </h1>
          {p.tally && <span className="srt-tally" ref={tally} style={{ left: p.ox + p.tally.x + DX * p.tally.z, top: p.oy - p.tally.y - p.tally.h - DY * p.tally.z, width: p.tally.w, height: p.tally.h }} aria-hidden="true">00000</span>}
          {/* The two facts: instruments in the base, a legend over a window each. */}
          <p className="srt-fact" ref={el => { veiled.current[3] = el }} style={at(p.facts[0])}><span className="srt-fact-label">Responds in</span><span className="srt-fact-value"><span><b>~100</b><i>ms</i></span><span className="srt-scale" aria-hidden="true" /></span></p>
          <p className="srt-fact" ref={el => { veiled.current[4] = el }} style={at(p.facts[1])}><span className="srt-fact-label">Free every month</span><span className="srt-fact-value"><span><b>3,000</b><i>sent</i></span><span><b>3,000</b><i>received</i></span></span></p>
          <StartButton start={start} className="srt-cta" ref={cta} style={at(p.cta)} />
          {/* What signing in agrees to, directly under a phone's button (a wide page has it under the slab's lip). */}
          {p.consent && <div className="srt-consent-on" style={at(p.consent)}><SignInConsent className="srt-consent" /></div>}
        </div>}
        {p && <>
          {visitor && !p.consent && <SignInConsent className="srt-consent" />}
          {/* And under the header's button, where the header carries one. */}
          {visitor && p.short && <SignInConsent className="srt-consent srt-consent-head" />}
          {/* The letter under the pointer, opened. */}
          <div className="srt-card" ref={cardBox} data-open={card ? '' : undefined} aria-hidden="true">
            {card && <div className="srt-card-body" data-scam={card.scam || undefined}>
              <span className="srt-card-from"><span>{card.from}</span><PrivateAddress value={card.addr} /></span>
              <b>{card.subject}</b>
              <span>{card.snippet}</span>
              <span className="srt-card-route">{card.scam ? 'A scam. Click to burn it.' : `Routed to ${LANE_NAMES[card.route]}`}</span>
            </div>}
          </div>
        </>}
        {notice && <div className="srt-notice">{notice}</div>}
      </section>
      <Stations plan={p} start={start} />
    </main>
  </div>
}
