import { useEffect, useRef, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { SignInConsent } from '../../components/LegalLinks'
import { AnomalyLogo } from '../../components/AnomalyLogo'
import type { HomeStart } from '.'
import { StartButton } from './start'
import type { Plan } from './plan'
import { EndBand, endBand } from './end-band'
import { afterFirstPicture } from './first-picture'
import { PRICE_LINKS, PRICE_PAGES_LIVE } from '../pricing/live'
import { SCREENS, type Kind } from './screens'
import './machines.css'

// Under the hero, the factory goes on down the page: one storey for each thing the product does, each with one
// machine on its floor and that job happening on the machine's screen in the page's own text, and the price at the
// foot. The parts are a kit rendered once in the hero's materials and light (kit/, machines-kit.css): the concrete
// wall and floor, a screen housing and a cabinet under it for each machine, its feet, the pipe pieces, a plate and a
// lamp. Its pictures are put on the page once the hero has been painted (they are all below the fold), as one
// stylesheet with each piece inlined: nothing of theirs is in the way of the hero's first paint, and they are one
// file in the build, not thirteen (Cloudflare reads a cache rule per file up to a limit: asset-headers.ts).
// Each machine's pipe comes in from the page's edge on its own side, along the wall under the floor over it, and
// turns down into its top; on a wide page a second leaves its cabinet for the same edge. No pipe crosses another.
// The section is laid out by CSS alone, so nothing moves once it has been painted. Three things move on the
// screens while they are in view (the campaign's meter, the agent's reply being typed, the log tape); with reduced
// motion nothing does.
const MACHINES: { kind: Kind; name: string; title: string; line: string }[] = [
  { kind: 'send', name: 'Send', title: 'Send from your app.', line: 'Receipts, password resets and alerts, one API call each.' },
  { kind: 'campaign', name: 'Campaigns', title: 'Email your whole list. Same price.', line: 'No charge per contact or per list: a newsletter to 50,000 people costs $10.' },
  { kind: 'receive', name: 'Inbox', title: 'Receive mail, and reply.', line: 'Every address gets an inbox. Answer from the address the mail came to, or open it in any mail app.' },
  { kind: 'agent', name: 'Agents', title: 'Inboxes for your agents.', line: 'Your agents read and answer email over MCP.' },
  { kind: 'route', name: 'Rules', title: 'Route it. Keep the record.', line: 'Rules run on mail as it arrives, forward it to Slack, Discord or a webhook, and every message is logged.' },
]

export function Machines({ plan: p, start }: { plan: Plan | null; start: HomeStart }) {
  const root = useRef<HTMLElement>(null)
  // The kit's pictures: when the page is next idle after the hero's picture, or as soon as the factory comes into view.
  useEffect(() => {
    let done = false
    const load = () => {
      if (done) return
      done = true
      void import('./machines-kit.css?inline').then(({ default: css }) => {
        if (document.getElementById('mx-kit')) return
        const style = document.createElement('style')
        style.id = 'mx-kit'; style.textContent = css
        document.head.append(style)
      }).catch(() => { /* the factory keeps its plain tones */ })
    }
    // (Idle comes no sooner than the hero's picture is in: on a slow connection the kit would take its bandwidth.)
    let idle = 0
    const wait = afterFirstPicture(() => { idle = typeof requestIdleCallback === 'function' ? requestIdleCallback(load, { timeout: 2000 }) : window.setTimeout(load, 1200) })
    // (Only once some of it is on the screen: its top touching the screen's foot does not count.)
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) load() }, { rootMargin: '0px 0px -1px 0px' })
    observer.observe(root.current!)
    return () => { wait(); observer.disconnect(); if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idle); else clearTimeout(idle) }
  }, [])
  // A machine's screen moves only while it is on the page.
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const observer = new IntersectionObserver(entries => { for (const entry of entries) (entry.target as HTMLElement).toggleAttribute('data-on', entry.isIntersecting) }, { threshold: .25 })
    for (const machine of root.current!.querySelectorAll('.mx-machine')) observer.observe(machine)
    return () => observer.disconnect()
  }, [])
  const band = p && endBand(p.W, p.phone, p.inset)
  return <>
    <section className="mx" ref={root} aria-label="What it does">
      <div className="mx-floor" aria-hidden="true" />
      {MACHINES.map(({ kind, name, title, line }, k) => <div key={kind} className="mx-storey" data-side={k % 2 ? 'r' : 'l'}>
        <div className="mx-machine" data-kind={kind} aria-hidden="true">
          <span className="mx-pipes"><i className="mx-run" /><i className="mx-elbow" /><i className="mx-drop" /><i className="mx-collar mx-collar-1" /><i className="mx-collar mx-collar-2" /><i className="mx-collar-v" /><i className="mx-out" /><i className="mx-collar mx-collar-3" /><i className="mx-collar mx-collar-4" /></span>
          <div className="mx-screen">{SCREENS[kind]}</div>
          <div className="mx-base"><span className="mx-stencil">{name}</span><span className="mx-plate">Included</span><i className="mx-lamp" /></div>
          <span className="mx-feet"><i /><i /></span>
        </div>
        <div className="mx-copy">
          <h2>{title}</h2>
          <p>{line}</p>
        </div>
        <div className="mx-floor" aria-hidden="true" />
      </div>)}
      {/* The bill, and the way in. What signing in agrees to stands directly under the button. */}
      <div className="mx-close">
        <p className="mx-price"><span><b>$0.20</b> per 1,000 emails, sent or received.</span> <span>That’s the whole bill.</span></p>
        <StartButton start={start} className="srt-cta mx-cta" />
        {!start.signedIn && <SignInConsent className="mx-consent" />}
      </div>
      <div className="mx-floor" aria-hidden="true" />
    </section>
    {/* Out of the factory, in the page's own light: the last links, and the wordmark across the page's end
        (end-band.tsx), which stands clear of a phone's home indicator on a sill. */}
    <footer className="mx-end" style={band ? { '--mx-band': `${band.h + p.inset.bottom}px` } as CSSProperties : undefined}>
      <nav aria-label="Site links"><a className="srt-by" href="https://anoma.ly" target="_blank" rel="noopener" title="Anomaly (opens in a new tab)">by <AnomalyLogo height={18} /></a><a href="/docs">API docs</a>{PRICE_PAGES_LIVE && PRICE_LINKS.map(([path, label]) => <Link key={path} to={path}>{label}</Link>)}<Link to="/legal/terms">Terms</Link><Link to="/legal/privacy">Privacy</Link></nav>
      {p && <EndBand W={p.W} phone={p.phone} inset={p.inset} />}
    </footer>
  </>
}
