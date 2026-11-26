import { fact, readOn, type Entry, type Offer } from '../prices.ts'

// Nightmail vs Postfleet (/compare/postfleet): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// Postfleet's own pages on CHECKED.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const POSTFLEET = 'https://postfleet.ai/pricing'
// Each plan's mailboxes and sends a month. Received mail isn't capped (plans meter the inbound messages its model
// reads, and mail past that still arrives), so it isn't counted here. The largest plan holds 150 mailboxes, and
// Postfleet's page names no price past it.
const offer: Offer = {
  id: 'postfleet', vendor: 'Postfleet', name: 'Postfleet', pricing: POSTFLEET, checked: CHECKED, unit: 'inboxes', ladder: 'complete',
  counts: 'mailboxes, sends and messages read by its model',
  plans: [
    { name: 'Free', tiers: [{ size: 3, cents: 0, sends: 3_000, source: read(POSTFLEET, 'Free $0 /mo Try it. No card. 100 messages turned into JSON / mo … 3 mailboxes 3,000 sends / month Up to 100 sends / day') }] },
    { name: 'Starter', tiers: [{ size: 5, cents: 700, sends: 5_000, source: read(POSTFLEET, 'Starter $7 /mo Screened mail, small scale. 250 messages turned into JSON / mo … Everything in Free 5 mailboxes 5,000 sends / month') }] },
    { name: 'Pro', tiers: [{ size: 10, cents: 2_000, sends: 10_000, source: read(POSTFLEET, 'Pro $20 /mo For a developer shipping agents. 1,500 messages turned into JSON / mo … 10 mailboxes 10,000 sends / month Custom sending domains') }] },
    { name: 'Scale', tiers: [{ size: 150, cents: 20_000, sends: 150_000, source: read(POSTFLEET, 'Scale $200 /mo For a team running agents in production. 25,000+ messages turned into JSON / mo … 150 mailboxes 150,000 sends / month Multiple custom domains') }] },
  ],
}

const sizes: Entry['sizes'] = [10, 50, 150]
export const postfleet: Entry = {
  slug: 'postfleet',
  vendor: 'Postfleet',
  focus: 'agents',
  offer,
  model: { per: 'inbox', receivedPerInbox: 100, sentPerInbox: 50 },
  sizes,
  // From 10 mailboxes (Pro) to 150, Scale's.
  steps: [10, 25, 50, 100, 150],
  lead: 'Postfleet sells mailboxes in plans, metered by the messages its model reads. Nightmail charges for each email, not each inbox.',
  assume: 'Each inbox receives 100 emails and sends 50 a month. Postfleet’s cheapest plan that holds the mailboxes and the sends. List prices before tax.',
  rows: [
    fact('Your own domain from the start', 'Your own domains on every workspace.', 'Postfleet’s custom sending domains start on Pro.', read(POSTFLEET, 'Pro $20 /mo … Custom sending domains … Scale $200 /mo … Multiple custom domains')),
    fact('Inboxes at no charge', 'No charge per inbox.', 'Postfleet’s Scale holds 150 mailboxes for $200 a month.', offer.plans[3]!.tiers[0]!.source),
  ],
  // Postfleet's readers first see the agents' inboxes, receiving and the domain.
  panels: ['agent', 'receive', 'domain', 'free', 'send', 'route', 'team'],
}
