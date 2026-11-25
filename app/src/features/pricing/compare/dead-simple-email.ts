import { dayOf, fact, formatCount, listOf, nightmail, readOn, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs Dead Simple Email (/compare/dead-simple-email): a comparison's whole entry (prices.ts, Entry). Every
// figure was read on Dead Simple Email's own pages on CHECKED (its prices are on its homepage, which /pricing opens).
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const DSE = 'https://deadsimple.email/'
const LLMS = 'https://deadsimple.email/llms.txt'
// Each plan's inboxes and emails a month, sent and received together ("the monthly allowance is pooled across sends and
// receives", LLMS). Paid plans add inboxes at $0.40 each. (They add emails at $0.20 per 1,000 too, which no size here
// needs: a plan short of emails costs more than the next one up.)
const extra = { per: 1, cents: 40, name: 'inboxes', source: read(DSE, 'Overages on paid plans: $0.40 per extra inbox/mo, charged when created and at renewal') }
const plan = (size: number, cents: number, emails: number, quote: string): Tier => ({ size, cents, emails, ...cents ? { extra } : {}, source: read(DSE, quote) })
const offer: Offer = {
  id: 'dead-simple-email', vendor: 'Dead Simple Email', name: 'Dead Simple Email', pricing: DSE, checked: CHECKED, unit: 'inboxes', ladder: 'complete',
  counts: 'inboxes and emails, sent and received together',
  plans: [
    { name: 'Free', tiers: [plan(5, 0, 5_000, 'Starter Free … $0 /mo 5 inboxes 5,000 emails / month 500 MB storage Shared domain')] },
    { name: 'Hobby', tiers: [plan(15, 500, 15_000, 'Indie Hobby For solo builders and small product teams. $5 /mo 15 inboxes 15,000 emails / month 1 GB storage 1 custom domain')] },
    { name: 'Pro', tiers: [plan(100, 2_900, 100_000, 'Team Pro … $29 /mo 100 inboxes 100,000 emails / month 5 GB storage 5 custom domains')] },
    { name: 'Scale', tiers: [plan(500, 9_900, 500_000, 'High Volume Scale … $99 /mo 500 inboxes 500,000 emails / month 10 GB storage 25 custom domains')] },
  ],
}

const sizes: Entry['sizes'] = [10, 100, 1_000]
export const deadSimpleEmail: Entry = {
  slug: 'dead-simple-email',
  vendor: 'Dead Simple Email',
  focus: 'agents',
  offer,
  model: { per: 'inbox', receivedPerInbox: 100, sentPerInbox: 50 },
  sizes,
  // From 10 inboxes (Hobby) to 1,000.
  steps: [10, 25, 50, 100, 250, 500, 1_000],
  lead: 'Dead Simple Email sells inboxes and emails in plans, with more inboxes at $0.40 each. Nightmail charges for each email, not each inbox.',
  assume: 'Each inbox receives 100 emails and sends 50 a month. Dead Simple Email’s cheapest plan, with more inboxes where that costs less. List prices before tax.',
  rows: [
    fact('A free allowance for received email', `Received email has its own ${formatCount(nightmail.freeReceived)} free a month.`, 'Dead Simple Email pools sent and received mail in one allowance.', read(LLMS, 'the monthly allowance is pooled across sends and receives')),
    fact('Inboxes at no charge', 'No charge per inbox.', 'Dead Simple Email charges $0.40 a month for each inbox past its plan’s.', extra.source),
  ],
  // Its readers first see the agents' inboxes, receiving and the allowances.
  panels: ['agent', 'receive', 'free', 'domain', 'send', 'route', 'team'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} agent inboxes, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
