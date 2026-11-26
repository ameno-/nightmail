import { fact, formatCount, nightmail, readOn, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs Bird (/compare/bird): a comparison's whole entry (prices.ts, Entry). Every figure was read on Bird's own
// pages on CHECKED. Bird sells SparkPost's email: sparkpost.com/pricing redirects to bird.com/pricing/email?sp=true.
const CHECKED = '2026-11-26'
const read = readOn(CHECKED)

const BIRD = 'https://bird.com/pricing/email'
const PRICES = 'https://bird.com/pricing/email.md'
// Bird's paid plans have no allowance: each takes a monthly deposit, and every email is charged from the balance at the
// plan's rate per 1,000, topped up when it runs out ("Paid Email plans are funding plans. They have no monthly email
// allowance or plan volume cap. Every email is charged from the wallet at the plan's published rate per 1,000",
// bird.com/docs/knowledge-base/billing/plans-and-pricing). A month costs its deposit or its emails, whichever is more.
// Two plans can be the cheapest here: Email Startup ($15 deposit, $0.40 per 1,000) and Email Growth 100 ($100 deposit,
// $0.39 per 1,000), each costing its deposit or its emails, whichever is more; Growth 250's rate is higher, and each
// Scale plan's deposit ($1,000 and up) is at least what the other two charge up to 2,500,000. At 10,000 Startup's $15
// deposit is the month. So 'points': only these sizes.
const RATES = '| Monthly balance deposit | $15 | $100 | $250 | $1,000 | $2,500 | $5,000 | $10,000 | | Transactional email rate per 1,000 | $0.40 | $0.39 | $0.45 | $0.35 | $0.30 | $0.25 | $0.20 |'
const plan = (deposit: number, rate: number) => (size: number): Tier => ({ size, cents: Math.max(deposit, size / 1000 * rate), source: read(PRICES, RATES) })
const SIZES = [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000]
const offer: Offer = {
  id: 'bird', vendor: 'Bird', name: 'Bird', pricing: BIRD, checked: CHECKED, unit: 'emails', ladder: 'points',
  counts: 'emails sent, from a monthly deposit',
  plans: [{ name: 'Email Startup', tiers: SIZES.map(plan(1_500, 40)) }, { name: 'Email Growth 100', tiers: SIZES.map(plan(10_000, 39)) }],
}

const sizes: Entry['sizes'] = [50_000, 100_000, 1_000_000]
export const bird: Entry = {
  slug: 'bird',
  vendor: 'Bird',
  // sparkpost.com/pricing redirects to Bird's (above): people still search for SparkPost.
  aka: 'SparkPost',
  focus: 'developer',
  offer,
  model: { per: 'email' },
  sizes,
  steps: SIZES,
  lead: 'Bird charges every email from a monthly deposit, with no free sends on paid plans. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, Bird’s cheapest plan for the size: its monthly deposit or its emails at the plan’s rate, whichever is more (Email Startup, $15 and $0.40 per 1,000; Email Growth 100, $100 and $0.39). List prices before tax.',
  rows: [
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month.`, 'Bird’s Free plan includes 1,000 emails a month; its paid plans charge from the first email.', readOn('2026-11-26')(PRICES, 'Free: 1,000 emails / month included, subject to the published Free limit.'), { shared: 'free' }),
    fact('Inboxes at no charge', 'No charge per inbox.', 'Bird’s Email Startup includes 10 mailboxes and Growth 25.', read(PRICES, '| Mailboxes | 5 | 10 | 25 | 100 |')),
  ],
  // Bird's readers first see the API, the allowances and the inboxes.
  panels: ['send', 'free', 'receive', 'agent', 'campaign', 'domain', 'route'],
}
