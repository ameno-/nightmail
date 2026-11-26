import { LANGUAGES, fact, formatCount, gap, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs SendGrid (/compare/sendgrid): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// Twilio SendGrid's own pages on CHECKED: the Email API plans on its pricing page, and each plan's overage in the
// pricing PDF that page links to ("Download PDF"), whose plan prices are the page's.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)
const GAPS_READ = readOn('2026-11-26')

const SENDGRID = 'https://www.twilio.com/en-us/products/email-api/pricing'
const PDF = 'https://www.twilio.com/content/dam/twilio-com/global/en/pricing/all-pricing/twi121--sendgrid-pricing-pdf-st1.pdf'
const tier = (size: number, cents: number, quote: string, overage: number, overageQuote: string): Tier => ({ size, cents, overage, source: read(SENDGRID, quote), overageSource: read(PDF, overageQuote) })
// Teammates in SendGrid's own words: its plan cards list "Additional teammates" (besides the account's owner), which its
// feature table calls "Teammate Permissions … 1 teammate"; the kinder reading of the two is the cards'.
const seats = (count: number) => ({ count, label: 'additional teammates', source: readOn('2026-11-26')(SENDGRID, 'What’s included: … Additional teammates: 1 … Additional teammates: 1 … Additional teammates: 1,000 … Additional teammates: 1,000') })
// Past a plan's emails SendGrid bills each extra one at the plan's overage rate, so a smaller plan plus its overage can
// cost less than the next plan up. The free trial (100 emails a day for 60 days) isn't a plan, so it isn't here.
const offer: Offer = {
  id: 'sendgrid', vendor: 'SendGrid', name: 'SendGrid', pricing: SENDGRID, checked: CHECKED, unit: 'emails', ladder: 'complete',
  counts: 'emails sent', payg: ' plus overage',
  beyond: { text: 'Premier, custom pricing', source: read(SENDGRID, 'Need to send more? Talk to us for custom, high volume pricing. … Premier custom pricing') },
  plans: [
    { name: 'Essentials', seats: seats(1), tiers: [
      tier(50_000, 1_995, 'data-plans … ["Essentials 50k","50,000 emails/mo",true,…,"$19.95/mo"]', 133, '$19.95/mo … 50,000 emails/mo … $0.00133 /extra email'),
      tier(100_000, 3_495, 'data-plans … ["Essentials 100k","100,000 emails/mo",true,…,"$34.95/mo"]', 88, '$34.95/mo … 100,000 emails/mo … $0.00088 /extra email'),
    ] },
    { name: 'Pro', seats: seats(1_000), tiers: [
      tier(100_000, 8_995, 'data-plans … ["Pro 100k","100,000 emails/mo",true,…,"$89.95/mo"]', 110, '$89.95/mo … 100,000 emails/mo … $0.00110 /extra email'),
      tier(300_000, 24_900, 'data-plans … ["Pro 300k","300,000 emails/mo",true,…,"$249.00/mo"]', 91, '$249.00/mo … 300,000 emails/mo … $0.00091 /extra email'),
      tier(700_000, 49_900, 'data-plans … ["Pro 700k","700,000 emails/mo",true,…,"$499.00/mo"]', 78, '$499.00/mo … 700,000 emails/mo … $0.00078 /extra email'),
      tier(1_500_000, 79_900, 'data-plans … ["Pro 1.5M","1,500,000 emails/mo",true,…,"$799.00/mo"]', 59, '$799.00/mo … 1,500,000 emails/mo … $0.00059 /extra email'),
      tier(2_500_000, 109_900, 'data-plans … ["Pro 2.5M","2,500,000 emails/mo",true,…,"$1,099.00/mo"]', 47, '$1,099.00/mo … 2,500,000 emails/mo … $0.00047 /extra email'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [10_000, 100_000, 1_000_000]
export const sendgrid: Entry = {
  slug: 'sendgrid',
  vendor: 'SendGrid',
  focus: 'developer',
  offer,
  model: { per: 'email' },
  sizes,
  // 10,000 emails (SendGrid's smallest plan is 50,000), then every plan size its page lists up to its last (2,500,000;
  // past it SendGrid names no price).
  steps: [10_000, ...tierSizes(offer, 50_000, Infinity)],
  lead: 'SendGrid sells a monthly allowance of email and charges for each one past it. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, SendGrid’s cheapest plan, or a smaller one plus its overage where that costs less. List prices before tax.',
  rows: [
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month.`, 'SendGrid’s free trial is 100 emails a day for 60 days.', read(SENDGRID, 'Free trial lets you send 100 emails/day for 60 days'), { shared: 'free' }),
    fact('Teammates at no charge', 'No charge for teammates.', 'SendGrid Essentials includes 1 additional teammate.', seats(1).source, { shared: 'teammates' }),
  ],
  // SendGrid's readers first see the API, the allowances and the team.
  panels: ['send', 'free', 'team', 'receive', 'agent', 'campaign', 'domain'],
  // What it offers that Nightmail doesn't, read on its own pages on 26 Nov 2026 (prices.ts, Gap).
  gaps: [
    gap('dedicated IPs', 'SendGrid’s Pro and Premier plans include dedicated IPs, and more can be bought.', /\bdedicated IPs?\b/i, GAPS_READ(SENDGRID, 'Pro and premier plans include dedicated IPs, with option to purchase more')),
    gap('libraries for C#, Go, Java, PHP, Python and Ruby', 'SendGrid maintains official libraries for C#, Go, Java, Node.js, PHP, Python and Ruby.', LANGUAGES, GAPS_READ('https://www.twilio.com/docs/sendgrid/for-developers/sending-email/libraries', 'SendGrid maintains the following official libraries for mail sending.')),
  ],
}
