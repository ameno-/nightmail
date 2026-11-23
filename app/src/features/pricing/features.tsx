import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { routeScreen, SCREENS } from '../home/screens'
import { Flaps } from './flaps'
import { formatCount, nightmail, type Comparison } from './prices'

// What else Nightmail does, under a comparison's board: a wall of the homepage's machines, small, each one thing the
// product does, something to look at and a few words. As the board stands over its console, a screen stands on a steel
// plate with its words: on the screen, the homepage's own depiction of that job (home/screens.tsx: the sample mail, the
// API call, the agent's tools, the rule and its log). A steel cabinet holds a made thing instead, split-flap figures or
// the team's paper tags, with its words under it. Every claim is the product's as
// shipped (the billing code's figures come from prices.ts). Each comparison sets which panels it shows, in what order
// and how large (LAYOUTS): Mailchimp's readers first see the list, the contacts and the team; Resend's the API, the
// allowances and the domain. (Seven each: a wall, not a catalogue.) On a wide page the panels are set on a 12-column grid by row and column; narrower, two
// across with the large one across both; on a phone, one under another in the same order.
// Three screens move while they are in view, as on the homepage (the campaign's meter, the agent's reply, the log's
// tape), and a panel's flaps turn over as it comes into view; with reduced motion nothing does (board.css).

export type FeatureId = 'send' | 'campaign' | 'contacts' | 'team' | 'free' | 'receive' | 'agent' | 'route' | 'domain'
type Feature = { title: string; line: string; face: 'screen' | 'steel'; show: ReactNode }

const TEAM = [['Dana', 'Owner'], ['Zahir', 'Admin'], ['Bertram', 'Member'], ['Mina', 'Member']] as const
// A domain's records as the product lists them (api/src/operations.ts, readiness): three DKIM CNAMEs, MAIL FROM's SPF,
// the DMARC it checks for, and the MX that receives.
const RECORDS = [['DKIM', 'x7k2._domainkey'], ['DKIM', 'p4qd._domainkey'], ['SPF', 'email'], ['DMARC', '_dmarc'], ['MX', 'acme.example']] as const
const free = formatCount(nightmail.freeSent)

const FEATURES: Record<FeatureId, Feature> = {
  send: { title: 'Send from your app.', line: 'One API call each, and a signed webhook for every event.', face: 'screen', show: <div className="ft-screen ft-send">
    {SCREENS.send}
    <div className="ft-hooks">{['email.sent', 'email.delivered'].map(event => <p key={event}><span>Webhook</span><b>{event}</b><em>200</em></p>)}</div>
  </div> },
  campaign: { title: 'Email your whole list.', line: `Campaigns and newsletters, at the same ${nightmail.perThousand} per 1,000.`, face: 'screen', show: <div className="ft-screen ft-campaign">{SCREENS.campaign}</div> },
  contacts: { title: 'No charge per contact.', line: 'You pay for the email, never for the list.', face: 'steel', show: <div className="ft-flapboard">
    <p><span>Contacts</span><Flaps text="100,000" width={7} end className="ft-flaps" /></p>
    <p><span>Charge</span><Flaps text="$0" width={7} end className="ft-flaps ft-lit" /></p>
  </div> },
  team: { title: 'Bring the whole team.', line: 'No charge per seat. Members edit campaigns; admins send them.', face: 'steel', show: <div className="ft-rail">
    {TEAM.map(([name, role], i) => <span key={name} className="ft-tag" style={{ '--k': i } as CSSProperties}><b>{name}</b><span>{role}</span></span>)}
  </div> },
  free: { title: 'Free every month.', line: 'Sent and received each have their own allowance.', face: 'steel', show: <div className="ft-flapboard">
    <p><Flaps text={free} width={free.length} className="ft-flaps ft-lit" /><span>Sent</span></p>
    <p><Flaps text={formatCount(nightmail.freeReceived)} width={free.length} className="ft-flaps ft-lit" /><span>Received</span></p>
  </div> },
  receive: { title: 'Receive mail, and reply.', line: 'Inboxes at no charge. Open them in any mail app too.', face: 'screen', show: <div className="ft-screen ft-receive">{SCREENS.receive}</div> },
  agent: { title: 'Inboxes for your agents.', line: 'Agents read and answer email over MCP.', face: 'screen', show: <div className="ft-screen ft-agent">{SCREENS.agent}</div> },
  route: { title: 'Route it. Keep the record.', line: 'Rules forward mail to Slack, Discord or a webhook.', face: 'screen', show: <div className="ft-screen ft-route">{routeScreen(6)}</div> },
  domain: { title: 'Your own domain.', line: 'DKIM, SPF and DMARC, each record checked.', face: 'screen', show: <div className="ft-screen ft-dns">
    {RECORDS.map(([kind, name]) => <p key={name}><span>{kind}</span><b>{name}</b><em>✓</em></p>)}
  </div> },
}

/** Each comparison's panels, in reading order, with their place on the wide grid: row start, column start, row end,
 *  column end (of 12 columns). The same shape for each: the lead panel with two beside it, one across the wall, and two
 *  beside the rules' log, whose tape runs as long as they stand. The first is the lead. */
const LAYOUTS: Record<Comparison['offer']['id'], [FeatureId, string][]> = {
  mailchimp: [['campaign', '1 / 1 / 3 / 8'], ['contacts', '1 / 8 / 2 / 13'], ['team', '2 / 8 / 3 / 13'], ['receive', '3 / 1 / 4 / 13'], ['free', '4 / 1 / 5 / 6'], ['agent', '5 / 1 / 6 / 6'], ['route', '4 / 6 / 6 / 13']],
  resend: [['send', '1 / 1 / 3 / 8'], ['free', '1 / 8 / 2 / 13'], ['domain', '2 / 8 / 3 / 13'], ['receive', '3 / 1 / 4 / 13'], ['agent', '4 / 1 / 5 / 6'], ['campaign', '5 / 1 / 6 / 6'], ['route', '4 / 6 / 6 / 13']],
  'resend-marketing': [],
}

export function Features({ comparison: c }: { comparison: Comparison }) {
  const root = useRef<HTMLElement>(null)
  // A panel's screen moves, and its flaps turn, while it is in view.
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const observer = new IntersectionObserver(entries => { for (const entry of entries) (entry.target as HTMLElement).toggleAttribute('data-on', entry.isIntersecting) }, { threshold: .25 })
    for (const card of root.current!.querySelectorAll('.ft-card')) observer.observe(card)
    return () => observer.disconnect()
  }, [])
  const layout = LAYOUTS[c.offer.id]
  return <section className="ft" ref={root} aria-labelledby="ft-title">
    <div className="ft-slab">
      <h2 id="ft-title" className="ft-title">Also in the box.</h2>
      <div className="ft-grid">{layout.map(([id, at], k) => {
        const { title, line, face, show } = FEATURES[id]
        // (A panel across more than half the wide grid is across both columns on a tablet.)
        const [, from, , to] = at.split('/').map(Number), wide = to! - from! > 6
        return <article key={id} className="ft-card" data-face={face} data-feature={id} data-lead={k === 0 || undefined} data-wide={wide || undefined} style={{ '--at': at, '--k': k } as CSSProperties}>
          <div className="ft-show" aria-hidden="true">{show}</div>
          <div className="ft-words"><h3>{title}</h3><p>{line}</p></div>
        </article>
      })}</div>
    </div>
  </section>
}
