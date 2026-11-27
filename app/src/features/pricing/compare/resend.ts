import { AUTOMATION, LANGUAGES, NO_DEDICATED_IP, TYPESCRIPT_SDK, formatCount, gap, money, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs Resend (/compare/resend): a comparison's whole entry (prices.ts, Entry), and Resend's marketing plans,
// which the calculator lists too (compare/index.ts, OFFERS). Every figure was read on Resend's own pricing page on
// CHECKED.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)
const GAPS_READ = readOn('2026-11-26')

const RESEND = 'https://resend.com/pricing'
const resendTier = (size: number, cents: number, overage: number | undefined, quote: string): Tier => ({ size, cents, ...overage === undefined ? {} : { overage }, source: read(RESEND, quote) })
const offer: Offer = {
  id: 'resend', vendor: 'Resend', name: 'Resend', pricing: RESEND, checked: CHECKED, unit: 'emails', ladder: 'complete',
  counts: 'emails sent and received',
  beyond: { text: 'Enterprise, custom pricing', source: read(RESEND, '| Enterprise | Custom |') },
  plans: [
    { name: 'Free', note: '100 a day', tiers: [resendTier(3_000, 0, undefined, '| Free | $0/mo | 3,000 | … "The Free plan is limited to 100 emails per day."')] },
    { name: 'Pro', tiers: [
      resendTier(50_000, 2_000, 90, '| Pro | $20/mo | 50,000 | $0.90 |'),
      resendTier(100_000, 3_500, 90, '| Pro | $35/mo | 100,000 | $0.90 |'),
    ] },
    { name: 'Scale', tiers: [
      resendTier(100_000, 9_000, 90, '| Scale | $90/mo | 100,000 | $0.90 |'),
      resendTier(200_000, 16_000, 80, '| Scale | $160/mo | 200,000 | $0.80 |'),
      resendTier(500_000, 35_000, 70, '| Scale | $350/mo | 500,000 | $0.70 |'),
      resendTier(1_000_000, 65_000, 65, '| Scale | $650/mo | 1,000,000 | $0.65 |'),
      resendTier(1_500_000, 82_500, 52, '| Scale | $825/mo | 1,500,000 | $0.52 |'),
      resendTier(2_500_000, 115_000, 46, '| Scale | $1,150/mo | 2,500,000 | $0.46 |'),
    ] },
  ],
}
/** Resend's pay-as-you-go: past a paid tier, "Overages are billed in buckets of 1,000 emails at your plan's overage rate". */
export const resendOverage = read(RESEND, 'Overages are billed in buckets of 1,000 emails at your plan\'s overage rate. You can enable this in your team settings under "Transactional Overages."')
export const resendReceived = read(RESEND, 'Each received email counts towards your transactional emails quota.')

const resendMarketingFree = read(RESEND, '## Marketing Email … | Free | $0/mo | 1,000 |')
export const resendMarketing: Offer = {
  id: 'resend-marketing', vendor: 'Resend', name: 'Resend marketing', pricing: RESEND, checked: CHECKED, unit: 'contacts', ladder: 'points',
  counts: 'contacts, not sends',
  plans: [
    { name: 'Free', startsAtZero: true, max: { size: 1_000, source: resendMarketingFree }, tiers: [{ size: 1_000, cents: 0, source: resendMarketingFree }] },
    { name: 'Pro marketing', tiers: [
      { size: 5_000, cents: 4_000, source: read(RESEND, '| Pro marketing | $40/mo | 5,000 | … "Marketing plans are not limited by the number of emails sent — only by the number of contacts."') },
      { size: 25_000, cents: 18_000, source: read(RESEND, '| Pro marketing | $180/mo | 25,000 |') },
      { size: 100_000, cents: 45_000, source: read(RESEND, '| Pro marketing | $450/mo | 100,000 |') },
    ] },
  ],
}

const sizes: Entry['sizes'] = [10_000, 100_000, 1_000_000]
export const resend: Entry = {
  slug: 'resend',
  vendor: 'Resend',
  focus: 'developer',
  offer,
  model: { per: 'email' },
  sizes,
  // 10,000 emails, then every paid tier Resend's page lists up to its last (2,500,000; past it Resend names no price).
  // Not below: up to Resend's free 3,000 both cost $0, so Nightmail isn't cheaper there.
  steps: [10_000, ...tierSizes(offer, 50_000, Infinity)],
  lead: 'Resend sells a monthly allowance of email. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, Resend’s cheapest plan or pay-as-you-go. List prices before tax.',
  rows: [
    { short: 'A free allowance for received email', text: `Received email has its own ${formatCount(nightmail.freeReceived)} free a month. Resend counts it against the sending allowance.`, source: resendReceived, line: { shared: 'free' } },
    { short: 'Inboxes at no charge', text: 'No charge per inbox. Resend includes 3 and charges $1 a month for each one after that.', source: read(RESEND, 'Every plan includes 3 inboxes. Paid plans can enable pay-as-you-go to add more at $1 per inbox per month') },
    { short: 'Marketing without a contact plan', text: `No contact plan for marketing. Resend’s Pro marketing is ${money(resendMarketing.plans[1]!.tiers[0]!.cents)} a month at ${formatCount(resendMarketing.plans[1]!.tiers[0]!.size)} contacts.`, source: resendMarketing.plans[1]!.tiers[0]!.source, line: { shared: 'contacts' } },
  ],
  // Resend's readers first see the API, the allowances and the domain.
  panels: ['send', 'free', 'domain', 'receive', 'agent', 'campaign', 'route'],
  // What it offers that Nightmail doesn't, read on its own pages on 26 Nov 2026 (prices.ts, Gap).
  gaps: [
    gap('dedicated IPs', 'Resend sells a dedicated IP for $30 a month on its Scale plan, to customers sending more than 3,000 emails a day.', /\bdedicated IPs?\b/i, GAPS_READ(RESEND, 'Dedicated IPs - $30 / mo Available to customers exceeding 3,000 emails sent per day on the Scale plan.'), NO_DEDICATED_IP),
    gap('automations', 'Resend’s Automations run a series of steps, such as sending an email, started by custom events from your application.', AUTOMATION, GAPS_READ('https://resend.com/docs/dashboard/automations/introduction', 'Automations allow you to create a series of executable steps based on custom trigger events from your application.')),
    gap('SDKs for PHP, Python, Ruby, Go, Java, Rust and .NET', 'Resend has official SDKs for PHP, Python, Ruby, Go, Java, Rust and .NET.', LANGUAGES, GAPS_READ('https://resend.com/docs/sdks', 'Official SDKs Node.js github.com/resend/resend-node PHP github.com/resend/resend-php Laravel github.com/resend/resend-laravel Python github.com/resend/resend-python Ruby github.com/resend/resend-ruby Go github.com/resend/resend-go Java github.com/resend/resend-java Rust github.com/resend/resend-rust .NET'), TYPESCRIPT_SDK),
  ],
}
