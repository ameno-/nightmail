import { fact, formatCount, nightmail, readOn, type Entry, type Offer } from '../prices.ts'

// Nightmail vs Robotomail (/compare/robotomail): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// Robotomail's own pages on CHECKED.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const ROBOTOMAIL = 'https://robotomail.com/pricing'
const LIMITS = 'https://robotomail.com/docs/concepts/limits.md'
// Each plan's mailboxes, and its monthly inbound cap across them (sends are capped per mailbox, far above 50 a month).
// Free and Solo hold one mailbox, so they aren't here; the largest plan holds 200, and Robotomail's pages name no price
// past it.
const offer: Offer = {
  id: 'robotomail', vendor: 'Robotomail', name: 'Robotomail', pricing: ROBOTOMAIL, checked: CHECKED, unit: 'inboxes', ladder: 'complete',
  counts: 'mailboxes and received emails',
  plans: [
    { name: 'Starter', tiers: [{ size: 10, cents: 1_900, receives: 2_000, source: read(LIMITS, 'Starter: $19/month or $168/year — 10 mailboxes, 500 sends/day and 15,000 sends/month per mailbox, 2,000 receives/month per account, 1 custom domain, 10 GB storage.') }] },
    { name: 'Growth', tiers: [{ size: 50, cents: 7_900, receives: 20_000, source: read(LIMITS, 'Growth: $79/month or $708/year — 50 mailboxes, 1,000 sends/day and unlimited sends/month per mailbox, 20,000 receives/month per account, 5 custom domains, 25 GB storage.') }] },
    { name: 'Scale', tiers: [{ size: 200, cents: 19_900, source: read(LIMITS, 'Scale: $199/month or $1788/year — 200 mailboxes, 2,000 sends/day and unlimited sends/month per mailbox, unlimited receives/month per account, unlimited custom domains, 100 GB storage.') }] },
  ],
}

const sizes: Entry['sizes'] = [10, 50, 200]
export const robotomail: Entry = {
  slug: 'robotomail',
  vendor: 'Robotomail',
  focus: 'agents',
  offer,
  model: { per: 'inbox', receivedPerInbox: 100, sentPerInbox: 50 },
  sizes,
  // From 10 mailboxes (Starter) to 200, Scale's.
  steps: [10, 25, 50, 100, 200],
  lead: 'Robotomail sells mailboxes in plans, each with a cap on received mail. Nightmail charges for each email, not each inbox.',
  assume: 'Each inbox receives 100 emails and sends 50 a month. Robotomail’s cheapest plan that holds the mailboxes and the received mail. List prices before tax.',
  rows: [
    fact('Receiving without a monthly cap', `Receiving with no monthly cap: ${formatCount(nightmail.freeReceived)} free, then ${nightmail.perThousand} per 1,000.`, 'Robotomail’s Starter receives 2,000 a month across all mailboxes and Growth 20,000.', read(LIMITS, 'Paid accounts have a monthly inbound cap that applies across all mailboxes: Solo **500**, Starter **2,000**, Growth **20,000**, Scale **unlimited**.')),
    fact('Campaigns and newsletters too', 'Campaigns and newsletters on the same account.', 'Robotomail isn’t for bulk marketing, by its own description.', read('https://robotomail.com/llms.txt', 'Do NOT use Robotomail for one-way bulk marketing blasts — it is built for two-way conversations.')),
    fact('Domains at no charge', 'Your own domains, at no charge.', 'Robotomail’s Starter includes 1 custom domain and Growth 5.', read(LIMITS, 'Starter: $19/month … 1 custom domain … Growth: $79/month … 5 custom domains')),
  ],
  // Robotomail's readers first see the agents' inboxes, receiving and the domain.
  panels: ['agent', 'receive', 'free', 'domain', 'campaign', 'send', 'route'],
}
