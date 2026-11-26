import { fact, readOn, type Entry, type Offer } from '../prices.ts'

// Nightmail vs Inkbox (/compare/inkbox): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// Inkbox's own pages on CHECKED.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const INKBOX = 'https://inkbox.ai/pricing'
const PLANS = 'https://inkbox.ai/pricing.md'
const DOCS = 'https://inkbox.ai/docs'
// Each plan's agent identities, an inbox each, and packs of 100 more at $100 a month. Inkbox has no email allowance;
// its sending is limited to 100 recipients a day by default ("plan limits may be higher", unpublished:
// DOCS/api/mail/messages.md), so the page stops at 50 inboxes, whose 2,500 sends a month fit that.
const pack = { per: 100, cents: 10_000, name: 'identities', source: read(PLANS, 'Each identity pack adds 100 identity slots for $100 USD per month on Developer, Startup, or Enterprise.') }
const offer: Offer = {
  id: 'inkbox', vendor: 'Inkbox', name: 'Inkbox', pricing: INKBOX, checked: CHECKED, unit: 'inboxes', ladder: 'complete',
  counts: 'agent identities, an inbox each',
  plans: [
    { name: 'Free', tiers: [{ size: 3, cents: 0, source: read(PLANS, '## Free For exploring Inkbox $0 / month 3 agent identities.') }] },
    { name: 'Developer', tiers: [{ size: 10, cents: 3_000, extra: pack, source: read(PLANS, '## Developer … $25 / month Billed annually: $300/year. Billed monthly: $30 / month. … 10 agent identities.') }] },
    { name: 'Startup', tiers: [{ size: 100, cents: 20_000, extra: pack, source: read(PLANS, '## Startup … $167 / month Billed annually: $2,000/year. Billed monthly: $200 / month. … 100 agent identities.') }] },
  ],
}

const sizes: Entry['sizes'] = [10, 25, 50]
export const inkbox: Entry = {
  slug: 'inkbox',
  vendor: 'Inkbox',
  focus: 'agents',
  offer,
  model: { per: 'inbox', receivedPerInbox: 100, sentPerInbox: 50 },
  sizes,
  // From 10 identities (Developer) to 50, within Inkbox's default sending limit.
  steps: [10, 25, 50],
  lead: 'Inkbox sells agent identities in plans, and more in packs of 100. Nightmail charges for each email, not each inbox.',
  assume: 'Each inbox receives 100 emails and sends 50 a month. Inkbox’s cheapest plan, with a pack of 100 more identities where that costs less. Up to 50 inboxes: Inkbox sends to 100 recipients a day by default. List prices before tax.',
  rows: [
    fact('Inboxes at no charge', 'No charge per inbox.', 'Inkbox sells more identities in packs of 100 for $100 a month.', pack.source),
    fact('No branding in your mail', 'No Nightmail branding in your mail, free allowance included.', 'Inkbox’s free plan adds a “Sent via Inkbox” footer.', read(`${DOCS}/capabilities/email.md`, 'Outgoing emails include a short "Sent via Inkbox" footer by default. Organizations on a paid plan can remove it'), 'No Nightmail footer added to your mail, free or paid'),
  ],
  // Its readers first see the agents' inboxes, receiving and the domain.
  panels: ['agent', 'receive', 'domain', 'free', 'send', 'route', 'team'],
}
