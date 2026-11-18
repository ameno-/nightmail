import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { SignInConsent } from '../../components/LegalLinks'
import { useTheme } from '../../lib/theme'
import type { HomeProps } from '.'
import { HomeHeader } from './home-header'
import { DashboardLink, StartButton } from './start'
import { plan, type Plan } from './sorter/plan'
import { toneVars } from './sorter/tones'
import { Stations } from './sorter-stations'
import { MANIFEST as m } from './factory/manifest'
import { alphaFormat, mountPlayer } from './factory/player'
import poster from './factory/poster.jpg'
import './factory-home.css'

// The homepage on a desktop: the factory. A rendered hall with the sorting machine standing in it, the price on the
// machine's front, and billboards with the free tier on them sliding slowly along a rail behind it (factory/player.ts).
// The page writes only the button, on the blank plate the machine's front has for it. The first picture is the poster,
// laid out by CSS alone before anything loads (factory-home.css), so nothing moves when the videos take over from it;
// with reduced motion, without the renders' host (VITE_FACTORY_MEDIA), or where alpha video cannot play, the poster
// is what is seen. Under it the tubes run on down the page to each place mail can go, as under the sorter.

/** Where the renders are, ending in a slash: a build without them shows the poster alone. */
const MEDIA = (import.meta.env.VITE_FACTORY_MEDIA as string | undefined)?.replace(/\/*$/, '/') || null
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const saveData = () => (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true

// What must be seen at any window's shape, in the frame's pixels: from the top of the boards' faces (a sprite's top
// third is its hanger) to a little under the button, and the machine's width. The frame covers the stage, cropped
// about the middle of that; a window too wide or too narrow for it to be seen whole shows the frame smaller, on the
// stage's own dark.
const faces = Math.min(...m.boards.y.map((y, k) => y + (m.boards.h?.[k] ?? 0) / 3))
const safeTop = faces - 16, safeBottom = m.button.y + m.button.h + 40, MACHINE_W = 1120
const frameVars = {
  '--fac-w': m.width, '--fac-h': m.height, '--fac-safe-h': safeBottom - safeTop, '--fac-safe-w': MACHINE_W, '--fac-mid': (safeTop + safeBottom) / 2,
} as CSSProperties
const pct = (value: number, of: number) => `${value / of * 100}%`
const buttonBox = { left: pct(m.button.x, m.width), top: pct(m.button.y, m.height), width: pct(m.button.w, m.width), height: pct(m.button.h, m.height) }

export function FactoryHome({ start, notice }: HomeProps) {
  const visitor = start.signedIn ? null : start
  const dark = useTheme().theme === 'dark'
  const scene = useRef<HTMLElement>(null), probe = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), frame = useRef<HTMLDivElement>(null)
  const bg = useRef<HTMLDivElement>(null), boards = useRef<HTMLDivElement>(null), fg = useRef<HTMLDivElement>(null)
  // The tubes under the hero are placed as the sorter's page would place them for this window (sorter/plan.ts).
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

  // After the first paint: the videos, where they can play. (720p where the frame is shown no wider than that has pixels for.)
  useEffect(() => {
    const format = alphaFormat()
    if (!MEDIA || !format || reducedMotion() || saveData()) return
    const height = frame.current!.getBoundingClientRect().width * devicePixelRatio > 1280 ? 1080 : 720
    const player = mountPlayer({ stage: stage.current!, bg: bg.current!, boards: boards.current!, fg: fg.current! }, { base: MEDIA, manifest: m, format, height })
    // Off screen, or in a hidden tab, it stands still.
    let seen = true
    const update = () => player.setShown(seen && document.visibilityState === 'visible')
    const observer = new IntersectionObserver(([entry]) => { seen = entry.isIntersecting; update() }, { threshold: .02 })
    observer.observe(stage.current!)
    document.addEventListener('visibilitychange', update)
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); player.destroy() }
  }, [])

  return <div className="srt-page fac-page" data-visitor={visitor ? '' : undefined} style={toneVars(dark) as CSSProperties}>
    <HomeHeader>{!visitor && <DashboardLink>Dashboard</DashboardLink>}</HomeHeader>
    <main>
      <section className="fac-hero" ref={scene} aria-label="Pricing">
        <div className="srt-fold" ref={probe} aria-hidden="true" />
        {/* What the machine and its boards say, for whoever cannot see them. */}
        <h1 className="sr-only">$0.20 per 1,000 emails, sent or received via API.</h1>
        <p className="sr-only">Free every month: 3,000 emails sent and 3,000 received. Responds in about 100 ms.</p>
        <div className="fac-stage" ref={stage}>
          <div className="fac-frame" ref={frame} style={frameVars}>
            <img className="fac-poster" src={poster} alt="" width={m.width} height={m.height} fetchPriority="high" decoding="async" />
            <div className="fac-layer" ref={bg} />
            <div className="fac-layer fac-boards" ref={boards} />
            <div className="fac-layer" ref={fg} />
            <StartButton start={start} className="fac-cta" style={buttonBox} />
          </div>
        </div>
        {/* Directly under the button, off the frame: what signing in agrees to. */}
        {visitor && <div className="fac-under"><SignInConsent className="fac-consent" /></div>}
        {notice && <div className="srt-notice">{notice}</div>}
      </section>
      <Stations plan={p} start={start} />
    </main>
  </div>
}
