import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { SignInConsent } from '../../components/LegalLinks'
import { useTheme } from '../../lib/theme'
import type { HomeProps } from '.'
import { StartButton } from './start'
import { plan, type Plan } from './sorter/plan'
import { toneVars } from './sorter/tones'
import { Machines } from './machines'
import { MANIFESTS, published, type Format, type Manifest } from './factory/manifest'
import { alphaFormat, mountPlayer, type Player } from './factory/player'
import desktopPoster from './factory/poster.jpg'
import phoneBare from './factory/phone/poster-bare.jpg'
import phoneBoard0 from './factory/phone/board0.webp'
import phoneBoard1 from './factory/phone/board1.webp'
import phoneBoard2 from './factory/phone/board2.webp'
import './factory-home.css'

// The homepage: the factory, in a wide frame on a desktop and a tall one on a phone (index.tsx picks), from the very top
// of the window: there is no header (the machine carries the name). A rendered hall with the sorting machine standing in it, the price on the
// machine's front, and billboards with the free tier on them behind it: sliding slowly along a rail on a desktop
// (factory/player.ts), hung in the middle in turn on a phone.
// The page writes the button, on the blank plate the machine's front has for it, and a tag over each pipe's label on
// the plinth (the render's stencils are too small and too grey to read). The first picture is the poster,
// laid out by CSS alone before anything loads (factory-home.css), so nothing moves when the videos take over from it;
// with reduced motion, without the renders' host (VITE_FACTORY_MEDIA), or where alpha video cannot play, the poster
// is what is seen. The hall's pipes go down out of the picture, into its floor; under it the factory goes on down the
// page, a storey and a machine for each thing it does (machines.tsx).

/** Where the render sets are published (their current.json and versions), ending in a slash: a build without it shows the poster alone. */
const MEDIA = (import.meta.env.VITE_FACTORY_MEDIA as string | undefined)?.replace(/\/*$/, '/') || null
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const connection = () => (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
const saveData = () => connection()?.saveData === true
/** Saving data, or on a connection no faster than 3G (as far as the browser says: Safari does not). */
const slow = () => saveData() || ['slow-2g', '2g', '3g'].includes(connection()?.effectiveType ?? '')

// What must be seen at any window's shape, in the frame's pixels (factory-home.css places the frame from these).
// Desktop: from the top of the boards' faces (a sprite's top third is its hanger) to a little under the button, and the
// machine's width. The frame covers the stage, cropped about the middle of that; a window too wide or too narrow for it
// to be seen whole shows the frame smaller, on the stage's own dark. And the stage's foot is never below the floor line,
// where the plinth's pipes go into the hall's floor (`--fac-floor`), so the picture never ends on bare floor.
// Phone: the button stands on its own console on the floor in front of the plinth, below the floor line. The stage's
// foot (`--fac-cut`) is a strip of floor under the console: as much as burst's letters land on (they pile up there and
// fly home in rebuild); the rest of the floor is cut off (the renders allow the bottom tenth). What signing in agrees to
// stands directly under it. Seen from the boards' faces (a phone sprite's hanger is its
// top seventh) down to that foot, and the middle 76% of the width (all the renders keep what must be read inside it).
const pct = (value: number, of: number) => `${value / of * 100}%`
function frameOf(m: Manifest, format: Format) {
  const faces = Math.min(...m.boards.y.map((y, k) => y + (m.boards.h?.[k] ?? 0) / (format === 'phone' ? 7 : 3))), safeTop = faces - 16
  const button = { left: pct(m.button.x, m.width), top: pct(m.button.y, m.height), width: pct(m.button.w, m.width), height: pct(m.button.h, m.height) }
  // (The button's label, in the frame's pixels: as tall as the plate is made for.)
  const label = format === 'phone' ? 40 : 19
  if (format === 'phone') {
    const cut = m.button.y + m.button.h + 72
    return { button, vars: { '--fac-w': m.width, '--fac-h': m.height, '--fac-safe-h': cut - safeTop, '--fac-safe-w': m.width * .76, '--fac-cut': cut, '--fac-label': label } as CSSProperties }
  }
  const safeBottom = m.button.y + m.button.h + 40, floor = Math.min(m.height, ...(m.pipes ?? []).map(pipe => pipe.yEnd))
  return { button, vars: { '--fac-w': m.width, '--fac-h': m.height, '--fac-safe-h': safeBottom - safeTop, '--fac-safe-w': 1120, '--fac-mid': (safeTop + safeBottom) / 2, '--fac-floor': floor, '--fac-label': label } as CSSProperties }
}
const FRAMES = { desktop: frameOf(MANIFESTS.desktop, 'desktop'), phone: frameOf(MANIFESTS.phone, 'phone') }

// The pipes' labels: a tag over each stencil some crop shows whole (the manifest's `labelBox`; none where `visible` is
// false), placed in the frame's pixels like the button and sized by factory-home.css: as large as the stencil, and
// never smaller than readable type, so it can be larger. The frame's crop depends on the window's shape, so before
// each paint (and as the stage's size changes) a tag whose stencil the stage cuts is left off, and one that would run
// past the stage's edge is moved in along it, still over its stencil; one that would then cover the tag before it (on
// the narrowest phones there is no room for both) is left off too.
const tagsOf = (m: Manifest) => (m.pipes ?? []).flatMap(pipe => pipe.labelBox && pipe.visible !== false ? [{ label: pipe.label, box: pipe.labelBox }] : [])
const TAGS = { desktop: tagsOf(MANIFESTS.desktop), phone: tagsOf(MANIFESTS.phone) }
const POSTERS: Record<Format, string> = { desktop: desktopPoster, phone: phoneBare }

// A phone's frame has room for one billboard at a time, and too little for one sliding along the rail to be read: at
// 390 px a board is whole in the frame about a quarter of the time, and the first one is cut off at the edge. So on a
// phone the free tier and the response time are said by the three boards hung in turn from the rail in the middle of
// the frame, a new one every four seconds, over the hall without its boards (poster-bare.jpg, the same first frame),
// whether or not the videos play. Nothing moves: one is put in the other's place (a short fade, or a cut where motion
// is reduced), and they dim with the hall.
const STILL_BOARDS = [1, 2, 0], STILL_SPRITES = [phoneBoard0, phoneBoard1, phoneBoard2]
function StillBoards({ m }: { m: Manifest }) {
  const [shown, setShown] = useState(0)
  useEffect(() => { const timer = setInterval(() => setShown(i => (i + 1) % STILL_BOARDS.length), 4000); return () => clearInterval(timer) }, [])
  return <div className="fac-layer fac-still" aria-hidden="true">{STILL_BOARDS.map((k, i) => {
    const w = m.boards.w?.[k] ?? 0
    return <img key={k} src={STILL_SPRITES[k]} alt="" decoding="async" data-on={i === shown || undefined} style={{ left: pct((m.width - w) / 2, m.width), top: pct(m.boards.y[k], m.height), width: pct(w, m.width) }} />
  })}</div>
}

export function FactoryHome({ start, notice, format }: HomeProps & { format: Format }) {
  const m = MANIFESTS[format], { vars: frameVars, button: buttonBox } = FRAMES[format]
  const still = format === 'phone'
  const visitor = start.signedIn ? null : start
  const dark = useTheme().theme === 'dark'
  const scene = useRef<HTMLElement>(null), probe = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), frame = useRef<HTMLDivElement>(null)
  const bg = useRef<HTMLDivElement>(null), boards = useRef<HTMLDivElement>(null), fg = useRef<HTMLDivElement>(null), tags = useRef<HTMLDivElement>(null)
  // The page's foot (machines.tsx, end-band.tsx) is measured as the sorter's page would measure it for this window (sorter/plan.ts).
  const [p, setP] = useState<Plan | null>(null)
  useLayoutEffect(() => {
    const measure = () => {
      const fold = probe.current!, safe = getComputedStyle(fold), next = plan(scene.current!.clientWidth, fold.offsetHeight, { left: parseFloat(safe.paddingLeft) || 0, right: parseFloat(safe.paddingRight) || 0, bottom: parseFloat(safe.paddingBottom) || 0 }, !start.signedIn)
      setP(now => now && now.W === next.W && now.H === next.H && now.fold === next.fold && now.ox === next.ox ? now : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scene.current!); observer.observe(probe.current!)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const layer = tags.current!, area = stage.current!
    const place = () => {
      const s = area.getBoundingClientRect(), f = frame.current!.getBoundingClientRect(), k = f.width / m.width
      let edge = -Infinity
      TAGS[format].forEach(({ box }, i) => {
        const tag = layer.children[i] as HTMLElement
        tag.style.removeProperty('--fac-tag-dx'); tag.style.removeProperty('--fac-tag-dy')
        // (The stencil is the box less the 3 frame px it has to spare all round.)
        const whole = f.left + (box.x + 3) * k >= s.left - .5 && f.left + (box.x + box.w - 3) * k <= s.right + .5 && f.top + (box.y + 3) * k >= s.top - .5 && f.top + (box.y + box.h - 3) * k <= s.bottom + .5
        const t = tag.getBoundingClientRect(), dx = Math.max(0, s.left - t.left) + Math.min(0, s.right - t.right), dy = Math.max(0, s.top - t.top) + Math.min(0, s.bottom - t.bottom)
        const off = !whole || t.left + dx < edge + 2
        tag.toggleAttribute('data-off', off)
        if (off) return
        edge = t.right + dx
        if (dx) tag.style.setProperty('--fac-tag-dx', `${dx}px`)
        if (dy) tag.style.setProperty('--fac-tag-dy', `${dy}px`)
      })
    }
    place()
    // (Each tag is watched too: its width changes when the mono web font takes over from its fallback.)
    const observer = new ResizeObserver(place)
    observer.observe(area); for (const tag of layer.children) observer.observe(tag)
    return () => observer.disconnect()
  }, [])

  // After the first paint: the set published on the renders' host, and its videos where they can play. (720p where the
  // frame is shown no wider than that has pixels for.)
  useEffect(() => {
    const codec = alphaFormat()
    if (!MEDIA || !codec || reducedMotion() || (format === 'desktop' && saveData())) return
    let player: Player | null = null, seen = true, gone = false
    // Off screen, or in a hidden tab, it stands still.
    const update = () => player?.setShown(seen && document.visibilityState === 'visible')
    const observer = new IntersectionObserver(([entry]) => { seen = entry.isIntersecting; update() }, { threshold: .02 })
    void published(MEDIA, format).then(set => {
      if (gone || !set) return
      // (A desktop takes the smaller files, 1280 wide, where the frame is shown no wider than that has pixels for; a
      // phone the 1080 × 1920 ones, and the 720 × 1280 ones where it is saving data or on 3G or slower.)
      const height = format === 'phone' ? slow() ? 720 : 1080 : frame.current!.getBoundingClientRect().width * devicePixelRatio > 1280 ? 1080 : 720
      player = mountPlayer({ stage: stage.current!, bg: bg.current!, boards: boards.current!, fg: fg.current!, tags: tags.current! }, { ...set, format: codec, height, rail: !still })
      observer.observe(stage.current!)
      document.addEventListener('visibilitychange', update)
    })
    return () => { gone = true; observer.disconnect(); document.removeEventListener('visibilitychange', update); player?.destroy() }
  }, [])

  return <div className="srt-page fac-page" data-format={format} data-visitor={visitor ? '' : undefined} style={toneVars(dark) as CSSProperties}>
    <main>
      <section className="fac-hero" ref={scene} aria-label="Pricing">
        <div className="srt-fold" ref={probe} aria-hidden="true" />
        {/* What the machine and its boards say, for whoever cannot see them. */}
        <h1 className="sr-only">$0.20 per 1,000 emails, sent or received via API.</h1>
        <p className="sr-only">Free every month: 3,000 emails sent and 3,000 received. Responds in about 100 ms.</p>
        <div className="fac-stage" ref={stage}>
          <div className="fac-frame" ref={frame} style={frameVars}>
            <img className="fac-poster" src={POSTERS[format]} alt="" width={m.width} height={m.height} fetchPriority="high" decoding="async" />
            <div className="fac-layer" ref={bg} />
            {still ? <div className="fac-layer" ref={boards}><StillBoards m={m} /></div> : <div className="fac-layer fac-boards" ref={boards} />}
            <div className="fac-layer" ref={fg} />
            <div className="fac-layer" ref={tags} aria-hidden="true">{TAGS[format].map(({ label, box }) =>
              <span key={label} className="fac-tag" style={{ left: pct(box.x, m.width), top: pct(box.y + box.h / 2, m.height), '--fac-tag-w': box.w, '--fac-tag-h': box.h } as CSSProperties}><span>{label}</span></span>)}</div>
            <StartButton start={start} className="fac-cta" style={buttonBox} />
          </div>
        </div>
        {/* Under the button, off the frame (on a phone directly under it): what signing in agrees to, and the way to
            the API docs beside it (where the header had it). */}
        {visitor && <div className="fac-under"><SignInConsent className="fac-consent" after={<><span aria-hidden="true"> · </span><a href="/docs">API docs</a></>} /></div>}
        {notice && <div className="srt-notice">{notice}</div>}
      </section>
      <Machines plan={p} start={start} />
    </main>
  </div>
}
