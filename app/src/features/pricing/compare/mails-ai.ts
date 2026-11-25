import { dayOf, fact, formatCount, listOf, readOn, type Entry, type Offer } from '../prices.ts'

// Nightmail vs Mails.ai (/compare/mails-ai): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// Mails.ai's own pages on CHECKED.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const MAILSAI = 'https://mails.ai/pricing'
// Each plan's agents (one address each), and its sent emails and inbound replies a month, each counted on its own
// ("Every plan counts two things, emails and inbound replies, each with its own monthly allowance"). Scale's agents are
// unlimited.
const offer: Offer = {
  id: 'mails-ai', vendor: 'Mails.ai', name: 'Mails.ai', pricing: MAILSAI, checked: CHECKED, unit: 'inboxes', ladder: 'complete',
  counts: 'agents, sent emails and inbound replies',
  plans: [
    { name: 'Free', tiers: [{ size: 1, cents: 0, sends: 3_000, receives: 3_000, source: read(MAILSAI, 'Free $0 / mo 3,000 emails / month 3,000 inbound replies / month 1 agent') }] },
    { name: 'Pro', tiers: [{ size: 5, cents: 2_000, sends: 50_000, receives: 50_000, source: read(MAILSAI, 'Pro $20 / mo 50K emails / month 50K inbound replies / month Send from your own domain (agent@yourcompany.com) 5 agents') }] },
    { name: 'Scale', tiers: [{ size: Infinity, cents: 9_900, sends: 250_000, receives: 500_000, source: read(MAILSAI, 'Scale $99 / mo 250K emails / month 500K inbound replies / month Unlimited agents — no per-inbox pricing') }] },
  ],
}

const sizes: Entry['sizes'] = [10, 100, 1_000]
export const mailsAi: Entry = {
  slug: 'mails-ai',
  vendor: 'Mails.ai',
  focus: 'agents',
  offer,
  model: { per: 'inbox', receivedPerInbox: 100, sentPerInbox: 50 },
  sizes,
  // From 10 inboxes (Scale: Pro holds 5) to 1,000.
  steps: [10, 25, 50, 100, 250, 500, 1_000],
  lead: 'Mails.ai sells plans by agents and monthly allowances, unlimited agents on Scale. Nightmail charges for each email, not each inbox.',
  assume: 'Each inbox receives 100 emails and sends 50 a month, one agent each. Mails.ai’s cheapest plan that holds them. List prices before tax.',
  rows: [
    fact('Receive at your own domain', 'Receive at your own domain.', 'Mails.ai’s custom domains are for sending; mail to them goes wherever the domain’s mail goes today.', read('https://mails.ai/docs/inbound.md', 'The DNS records mails.ai asks for cover sending only: mail written straight to `billing@acme.com` goes wherever that domain’s mail is delivered today')),
    fact('Campaigns and newsletters too', 'Campaigns and newsletters on the same account.', 'Mails.ai refuses bulk marketing at its API.', read(MAILSAI, 'cold outreach and bulk marketing are refused at the API with a 422 cold_email_prohibited')),
  ],
  // Mails.ai's readers first see the agents' inboxes, receiving and the domain.
  panels: ['agent', 'receive', 'domain', 'free', 'campaign', 'send', 'route'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} agent inboxes, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
