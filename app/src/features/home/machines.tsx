import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router'
import { SignInConsent } from '../../components/LegalLinks'
import { AnomalyLogo } from '../../components/AnomalyLogo'
import type { HomeStart } from '.'
import { StartButton } from './start'
import type { Plan } from './plan'
import { EndBand, endBand } from './end-band'
import { afterFirstPicture } from './first-picture'
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
type Kind = 'send' | 'campaign' | 'receive' | 'agent' | 'route'
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
      <nav aria-label="Site links"><a className="srt-by" href="https://anoma.ly" target="_blank" rel="noopener" title="Anomaly (opens in a new tab)">by <AnomalyLogo height={18} /></a><a href="/docs">API docs</a><Link to="/legal/terms">Terms</Link><Link to="/legal/privacy">Privacy</Link></nav>
      {p && <EndBand W={p.W} phone={p.phone} inset={p.inset} />}
    </footer>
  </>
}

// What each machine's screen shows. Sample mail is the homepage's own cast; the API's, the MCP's and the rules' names
// are the product's (POST /v1/emails/send answers 202 with the email queued; the agent's three tools; a rule as the
// rules guide writes one).
const LOG: [string, string, string, string][] = [
  ['02:14', 'Received', 'Your pager wants to be friends', 'Slack'],
  ['02:11', 'Sent', 'Sending version six. It is the last one.', ''],
  ['02:09', 'Received', 'Your webhook is answering in Latin', 'Webhook'],
  ['02:02', 'Delivered', 'We label the sausages by mood now', ''],
  ['01:58', 'Received', 'Turn a one-star canteen review into notes', 'Discord'],
  ['01:40', 'Received', 'Your hot desk is now cold', ''],
]
const Mail = ({ from, subject, when, open }: { from: string; subject: string; when: string; open?: boolean }) =>
  <div className="mx-row" data-open={open || undefined}><b>{from}</b><time>{when}</time><span>{subject}</span></div>
const SCREENS: Record<Kind, ReactNode> = {
  send: <div className="mx-code">
    <p><b>POST</b> /v1/emails/send</p>
    <pre>{'{\n  "from": "shop@acme.example",\n  "to": "dana@example.com",\n  "subject": "6 mugs, 7 handles"\n}'}</pre>
    <p className="mx-answer"><b>202</b> Accepted</p>
    <pre className="mx-dim">{'{ "status": "queued" }'}</pre>
  </div>,
  campaign: <div className="mx-card">
    <p className="mx-card-head"><span>Campaign</span><span className="mx-sent">Sent</span></p>
    <p className="mx-card-title">We label the sausages by mood now</p>
    <p className="mx-dim">Counter Six Butcher to Regulars</p>
    <span className="mx-meter"><i /></span>
    <dl className="mx-bill">
      <div><dt>Recipients</dt><dd>50,000</dd></div>
      <div><dt>Rate</dt><dd>$0.20 per 1,000</dd></div>
      <div className="mx-total"><dt>Cost</dt><dd>$10.00</dd></div>
    </dl>
  </div>,
  receive: <div className="mx-mail">
    <div className="mx-list">
      <p className="mx-list-head"><b>Inbox</b><span>hello@acme.example</span></p>
      <Mail from="On-Call Pager" subject="Your pager wants to be friends" when="02:14" />
      <Mail open from="Zahir Bhatt" subject="Re: can you send me the file again" when="02:11" />
      <Mail from="Handle Concern" subject="Order confirmed: 6 mugs, 7 handles" when="01:52" />
    </div>
    <div className="mx-thread">
      <p className="mx-thread-head">Re: can you send me the file again</p>
      <p className="mx-msg"><b>Zahir Bhatt</b>This is the fifth time. Each version is a different version.</p>
      <p className="mx-msg mx-mine"><b>hello@acme.example</b>Sending version six. It is the last one.</p>
    </div>
  </div>,
  agent: <div className="mx-agent">
    <p className="mx-call">listInboxMessages</p>
    <p className="mx-dim">1 new, from Bertram Quaife</p>
    <p className="mx-call">getInboxMessage</p>
    <p className="mx-quote">Turn a one-star canteen review into notes: “the soup was a warning.”</p>
    <p className="mx-call">replyToInboundThread</p>
    <p className="mx-draft"><span>1. Label the soup.</span></p>
  </div>,
  route: <div className="mx-route">
    <pre className="mx-rule mx-rule-wide">{'export default function route(email, ctx) {\n  if (ctx.junk) return\n  endpoints.slack({ text: email.subject })\n}'}</pre>
    <pre className="mx-rule mx-rule-narrow">{'export default\nfunction route(email, ctx) {\n  if (ctx.junk) return\n  endpoints.slack({\n    text: email.subject,\n  })\n}'}</pre>
    <div className="mx-tape"><div className="mx-roll">{[0, 1].map(copy => LOG.map(([at, status, subject, to]) =>
      <p key={`${copy}${at}`} className="mx-log"><time>{at}</time><span data-status={status}>{status}</span><b>{subject}</b><em>{to}</em></p>))}</div></div>
  </div>,
}
