import { fact, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs beehiiv (/compare/beehiiv): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// beehiiv's own pages on CHECKED: its pricing page renders its slider in the browser, so the prices are from pricing.md,
// which beehiiv generates from the same plan data.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const BEEHIIV = 'https://www.beehiiv.com/pricing'
const MD = 'https://www.beehiiv.com/pricing.md'
const tier = (size: number, cents: number, quote: string): Tier => ({ size, cents, source: read(MD, quote) })
const soldThrough = read(MD, 'Lite is sold through 100,000 subscribers. Pro is sold through 250,000.')
// Every plan sends without a cap. Pro's last bucket reads "250,000+", but its limits table stops Pro at 250,000, so
// 250,000 is its last size here.
const offer: Offer = {
  id: 'beehiiv', vendor: 'beehiiv', name: 'beehiiv', pricing: BEEHIIV, checked: CHECKED, unit: 'contacts', ladder: 'complete',
  counts: 'active subscribers',
  beyond: { text: 'Enterprise, custom pricing', source: read(MD, 'Lite is sold through 100,000 subscribers. Pro is sold through 250,000. Enterprise is custom-priced at every list size.') },
  plans: [
    { name: 'Free', max: { size: 2_500, source: read(MD, '| Subscribers | Up to 2,500 | Up to 100,000 | Up to 250,000 | Custom |') }, tiers: [
      tier(2_500, 0, 'You get up to 2,500 subscribers, unlimited email sends, and access to beehiiv\'s core newsletter, website, and podcast tools.'),
    ] },
    { name: 'Lite', max: { size: 100_000, source: soldThrough }, tiers: [
      tier(1_000, 5_900, '| Up to 1,000 | $59 | $588 | $49 | $109 | $1,140 | $95 |'),
      tier(2_500, 7_900, '| Up to 2,500 | $79 | $828 | $69 | $149 | $1,548 | $129 |'),
      tier(5_000, 10_900, '| Up to 5,000 | $109 | $1,140 | $95 | $199 | $2,028 | $169 |'),
      tier(10_000, 13_900, '| Up to 10,000 | $139 | $1,428 | $119 | $239 | $2,388 | $199 |'),
      tier(25_000, 19_900, '| Up to 25,000 | $199 | $2,028 | $169 | $349 | $3,588 | $299 |'),
      tier(50_000, 29_900, '| Up to 50,000 | $299 | $2,988 | $249 | $469 | $4,788 | $399 |'),
      tier(75_000, 38_900, '| Up to 75,000 | $389 | $3,948 | $329 | $589 | $5,988 | $499 |'),
      tier(100_000, 46_900, '| Up to 100,000 | $469 | $4,788 | $399 | $699 | $7,188 | $599 |'),
    ] },
    { name: 'Pro', max: { size: 250_000, source: soldThrough }, tiers: [
      tier(1_000, 10_900, '| Up to 1,000 | $59 | $588 | $49 | $109 | $1,140 | $95 |'),
      tier(2_500, 14_900, '| Up to 2,500 | $79 | $828 | $69 | $149 | $1,548 | $129 |'),
      tier(5_000, 19_900, '| Up to 5,000 | $109 | $1,140 | $95 | $199 | $2,028 | $169 |'),
      tier(10_000, 23_900, '| Up to 10,000 | $139 | $1,428 | $119 | $239 | $2,388 | $199 |'),
      tier(25_000, 34_900, '| Up to 25,000 | $199 | $2,028 | $169 | $349 | $3,588 | $299 |'),
      tier(50_000, 46_900, '| Up to 50,000 | $299 | $2,988 | $249 | $469 | $4,788 | $399 |'),
      tier(75_000, 58_900, '| Up to 75,000 | $389 | $3,948 | $329 | $589 | $5,988 | $499 |'),
      tier(100_000, 69_900, '| Up to 100,000 | $469 | $4,788 | $399 | $699 | $7,188 | $599 |'),
      tier(150_000, 79_900, '| Up to 150,000 | — | — | — | $799 | $8,268 | $689 |'),
      tier(200_000, 89_900, '| Up to 200,000 | — | — | — | $899 | $9,348 | $779 |'),
      tier(250_000, 99_900, '| 250,000+ | — | — | — | $999 | $10,428 | $869 |'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [5_000, 10_000, 100_000]
export const beehiiv: Entry = {
  slug: 'beehiiv',
  vendor: 'beehiiv',
  focus: 'newsletter',
  offer,
  model: { per: 'contact', sendsPerContact: 4, seats: 1 },
  sizes,
  // beehiiv's Free plan holds 2,500 subscribers, so the fader starts at its next list size and runs through every one
  // it prices, to Pro's 250,000.
  steps: tierSizes(offer, 5_000, 250_000),
  lead: 'beehiiv prices by subscribers. Nightmail prices by email.',
  assume: 'Four emails a month to each subscriber, 1 teammate, beehiiv’s cheapest plan that holds them. List prices before tax.',
  rows: [
    fact('Your own domain at no charge', 'No charge for your own domains.', 'beehiiv’s custom domains start on Lite.', read(MD, '| Custom domains | — | Yes | Yes | Yes |')),
    fact('Teammates at no charge', 'No charge for teammates.', 'beehiiv Free includes 1 seat, Lite 2 and Pro 10.', read(MD, '| Team seats | 1 | 2 | 10 | Unlimited |'), { shared: 'teammates' }),
  ],
  // A newsletter's readers first see the list, the contacts and what keeps it clean.
  panels: ['campaign', 'contacts', 'hygiene', 'ready', 'domain', 'team', 'free'],
  without: ['signup forms', 'a web archive', 'a website', 'automations', 'paid subscriptions'],
}
