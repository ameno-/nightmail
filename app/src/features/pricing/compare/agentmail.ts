import { dayOf, fact, formatCount, listOf, readOn, type Entry, type Offer } from '../prices.ts'

// Nightmail vs AgentMail (/compare/agentmail): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// AgentMail's own pages (pricing.md is its pricing page's text) on CHECKED.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const AGENTMAIL = 'https://www.agentmail.to/pricing'
const PLANS = 'https://www.agentmail.to/pricing.md'
// Each plan's inboxes and emails a month, and more inboxes at $2 each on Developer and Startup. Free counts received
// mail too ("AgentMail Free likewise budgets 3,000 emails/month and 100/day across the inbox workload", its blog);
// whether Developer's 10,000 do isn't stated, so only its sends are counted here, which never prices it higher.
// Startup's pricing table names no monthly cap ("No separate cap"). (Developer sells more emails too, $2 per 1,000; no
// size here is cheaper with them.) Startup is listed before Developer: at 100 inboxes both cost $200, and AgentMail's own
// calculator shows Startup.
const inboxes = { per: 1, cents: 200, name: 'inboxes', source: read(PLANS, 'Available on Developer and Startup and billed with your plan, monthly or yearly. … Inboxes: $2/month per inbox') }
const offer: Offer = {
  id: 'agentmail', vendor: 'AgentMail', name: 'AgentMail', pricing: AGENTMAIL, checked: CHECKED, unit: 'inboxes', ladder: 'complete',
  counts: 'inboxes, emails, domains and seats',
  beyond: { text: 'Enterprise, custom pricing', source: read(PLANS, '### Enterprise — Custom pricing For tailored solutions. - Everything in Startup tier - Unlimited inboxes available - Bulk discounts') },
  plans: [
    { name: 'Free', tiers: [{ size: 3, cents: 0, emails: 3_000, source: read(PLANS, '### Free — $0/month For getting started. - No credit card required - 3 inboxes - 1 custom domain - 3,000 emails/month - 100 emails/day') }] },
    { name: 'Startup', tiers: [{ size: 150, cents: 20_000, extra: inboxes, source: read(PLANS, '### Startup — $200/month For scaling teams. - 150 inboxes - 15,000 emails/day - 1,500 emails/5 minutes - 150 custom domains - 10 organization seats') }] },
    { name: 'Developer', tiers: [{ size: 10, cents: 2_000, sends: 10_000, extra: inboxes, source: read(PLANS, '### Developer — $20/month For individual developers. - 10 inboxes - 10,000 emails/month - 1,000 emails/day - 100 emails/5 minutes - 10 GB storage - 10 custom domains - 2 organization seats') }] },
  ],
}

const sizes: Entry['sizes'] = [10, 100, 1_000]
export const agentmail: Entry = {
  slug: 'agentmail',
  vendor: 'AgentMail',
  focus: 'agents',
  offer,
  model: { per: 'inbox', receivedPerInbox: 100, sentPerInbox: 50 },
  sizes,
  // From 10 inboxes (Developer) to 1,000 (Startup and 850 more).
  steps: [10, 25, 50, 100, 150, 250, 500, 1_000],
  lead: 'AgentMail sells inboxes in plans, and more at $2 each. Nightmail charges for each email, not each inbox.',
  assume: 'Each inbox receives 100 emails and sends 50 a month. AgentMail’s cheapest plan, with more inboxes at $2 each where it needs them. List prices before tax.',
  rows: [
    fact('Inboxes at no charge', 'No charge per inbox.', 'AgentMail’s Developer plan includes 10 and charges $2 a month for each one after that.', read(PLANS, '- 10 inboxes … Inboxes: $2/month per inbox')),
    fact('Domains at no charge', 'No charge per domain.', 'AgentMail’s Developer plan includes 10 custom domains and charges $2 a month for each one after that.', read(PLANS, '- 10 custom domains … Domains: $2/month per domain')),
    fact('Teammates at no charge', 'No charge for teammates.', 'AgentMail’s Developer plan includes 2 seats and charges $5 a month for each one after that.', read(PLANS, '- 2 organization seats … Seats: $5/month per seat')),
  ],
  // AgentMail's readers first see the agents' inboxes, receiving and the API.
  panels: ['agent', 'receive', 'send', 'free', 'domain', 'team', 'route'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} agent inboxes, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
