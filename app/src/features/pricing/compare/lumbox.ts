import { fact, nightmail, readOn, type Entry, type Offer } from '../prices.ts'

// Nightmail vs Lumbox (/compare/lumbox): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// Lumbox's own pages on CHECKED.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const LUMBOX = 'https://lumbox.co/pricing'
const PLANS = 'https://lumbox.co/pricing.md'
const DOCS = 'https://lumbox.co/docs/pricing/'
// Each plan's inboxes, and its received and sent emails a month, each counted on its own. The largest plan holds 250
// inboxes; for more, Lumbox asks you to email sales.
const offer: Offer = {
  id: 'lumbox', vendor: 'Lumbox', name: 'Lumbox', pricing: LUMBOX, checked: CHECKED, unit: 'inboxes', ladder: 'complete',
  counts: 'inboxes, received and sent emails',
  beyond: { text: 'Custom, by email to sales', source: read(DOCS, 'For higher inbox counts, dedicated IPs, EU region, SOC 2 deliverables, or a BYOC deployment, email sales@lumbox.co .') },
  plans: [
    { name: 'Free', tiers: [{ size: 3, cents: 0, sends: 100, receives: 500, source: read(PLANS, '## Free $0/mo Get started. No credit card required. … - 3 agent inboxes - 500 emails received / month - 100 emails sent / month') }] },
    { name: 'Starter', tiers: [{ size: 10, cents: 900, sends: 2_000, receives: 5_000, source: read(PLANS, '## Starter $9/mo … - 10 agent inboxes - 5,000 emails received / month - 2,000 emails sent / month') }] },
    { name: 'Pro', tiers: [{ size: 50, cents: 2_900, sends: 10_000, receives: 25_000, source: read(PLANS, '## Pro … $29/mo … - 50 agent inboxes - 25,000 emails received / month - 10,000 emails sent / month') }] },
    { name: 'Scale', tiers: [{ size: 250, cents: 9_900, sends: 50_000, receives: 100_000, source: read(PLANS, '## Scale $99/mo … - 250 agent inboxes - 100,000 emails received / month - 50,000 emails sent / month') }] },
  ],
}

const sizes: Entry['sizes'] = [10, 50, 250]
export const lumbox: Entry = {
  slug: 'lumbox',
  vendor: 'Lumbox',
  focus: 'agents',
  offer,
  model: { per: 'inbox', receivedPerInbox: 100, sentPerInbox: 50 },
  sizes,
  // From 10 inboxes (Starter) to 250, Scale's.
  steps: [10, 25, 50, 100, 250],
  lead: 'Lumbox sells inboxes in plans, each with a monthly quota of received and sent mail. Nightmail charges for each email, not each inbox.',
  assume: 'Each inbox receives 100 emails and sends 50 a month. Lumbox’s cheapest plan that holds the inboxes and both quotas. List prices before tax.',
  rows: [
    fact('No monthly quota', `No monthly quota: past the free allowance, each email is ${nightmail.perThousand} per 1,000.`, 'Once a Lumbox quota runs out, its API refuses sends and new inboxes until the 1st.', read(DOCS, 'When a monthly quota is exceeded the API returns 402 Payment Required on writes (send, create inbox, etc.). Reads keep working. Quotas reset on the first of each month UTC.')),
    fact('Inboxes at no charge', 'No charge per inbox.', 'For more inboxes than its plans hold, Lumbox asks you to email sales.', offer.beyond!.source),
  ],
  // Lumbox's readers first see the agents' inboxes, receiving and the allowances.
  panels: ['agent', 'receive', 'free', 'domain', 'send', 'route', 'team'],
}
