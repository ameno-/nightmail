import { dayOf, fact, formatCount, listOf, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs Ghost(Pro) (/compare/ghost): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// Ghost's own pages on CHECKED: the monthly prices in the script its pricing page loads (pricing.min.js).
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const GHOST = 'https://ghost.org/pricing/'
const JS = 'https://ghost.org/js/pricing.min.js'
const tier = (size: number, cents: number, quote: string): Tier => ({ size, cents, source: read(JS, quote) })
// Ghost counts members (anyone signed up, free or paid); here they're the subscribers. Every plan sends without a cap.
// There is no free plan, only a 14-day trial, so it isn't here.
const offer: Offer = {
  id: 'ghost', vendor: 'Ghost(Pro)', name: 'Ghost(Pro)', pricing: GHOST, checked: CHECKED, unit: 'contacts', ladder: 'complete',
  counts: 'members',
  beyond: { text: 'Custom, by quote', source: read(GHOST, 'Over 100,000 members? Reach out to our team') },
  plans: [
    { name: 'Starter', max: { size: 1_000, source: read(GHOST, 'Starter For solo blogs & newsletters $ 18 USD / mo Billed monthly … Email newsletter Simple design settings 1,000 members') }, tiers: [
      tier(1_000, 1_800, '{cost:18,billing_period:"month",active:1,limits:[{name:"members",value:1e3}]}'),
    ] },
    { name: 'Publisher', tiers: [
      tier(1_000, 3_500, '{cost:35,billing_period:"month",active:1,limits:[{name:"members",value:1e3}]}'),
      tier(2_500, 5_500, '{cost:55,billing_period:"month",active:1,limits:[{name:"members",value:2500}]}'),
      tier(5_000, 7_500, '{cost:75,billing_period:"month",active:1,limits:[{name:"members",value:5e3}]}'),
      tier(7_500, 9_500, '{cost:95,billing_period:"month",active:1,limits:[{name:"members",value:7500}]}'),
      tier(10_000, 10_500, '{cost:105,billing_period:"month",active:1,limits:[{name:"members",value:1e4}]}'),
      tier(25_000, 16_900, '{cost:169,billing_period:"month",active:1,limits:[{name:"members",value:25e3}]}'),
      tier(50_000, 24_900, '{cost:249,billing_period:"month",active:1,limits:[{name:"members",value:5e4}]}'),
      tier(75_000, 28_900, '{cost:289,billing_period:"month",active:1,limits:[{name:"members",value:75e3}]}'),
      tier(100_000, 32_900, '{cost:329,billing_period:"month",active:1,limits:[{name:"members",value:1e5}]}'),
    ] },
    { name: 'Business', tiers: [
      tier(1_000, 23_900, '{cost:239,billing_period:"month",active:1,limits:[{name:"members",value:1e3}]}'),
      tier(2_500, 23_900, '{cost:239,billing_period:"month",active:1,limits:[{name:"members",value:2500}]}'),
      tier(5_000, 23_900, '{cost:239,billing_period:"month",active:1,limits:[{name:"members",value:5e3}]}'),
      tier(7_500, 23_900, '{cost:239,billing_period:"month",active:1,limits:[{name:"members",value:7500}]}'),
      tier(10_000, 23_900, '{cost:239,billing_period:"month",active:1,limits:[{name:"members",value:1e4}]}'),
      tier(25_000, 31_900, '{cost:319,billing_period:"month",active:1,limits:[{name:"members",value:25e3}]}'),
      tier(50_000, 39_900, '{cost:399,billing_period:"month",active:1,limits:[{name:"members",value:5e4}]}'),
      tier(75_000, 43_900, '{cost:439,billing_period:"month",active:1,limits:[{name:"members",value:75e3}]}'),
      tier(100_000, 47_900, '{cost:479,billing_period:"month",active:1,limits:[{name:"members",value:1e5}]}'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [1_000, 10_000, 100_000]
export const ghost: Entry = {
  slug: 'ghost',
  vendor: 'Ghost(Pro)',
  focus: 'newsletter',
  offer,
  model: { per: 'contact', sendsPerContact: 4, seats: 1 },
  sizes,
  // Every list size Ghost(Pro) prices, from 1,000 to 100,000 members.
  steps: tierSizes(offer, 1_000, 100_000),
  lead: 'Ghost(Pro) prices by subscribers. Nightmail prices by email.',
  assume: 'Four emails a month to each subscriber, 1 teammate, Ghost(Pro)’s cheapest plan that holds them. List prices before tax.',
  rows: [
    fact('Your own sending domain at no charge', 'No charge for your own sending domains.', 'Ghost(Pro)’s custom sending domain starts on Publisher.', read(GHOST, 'Custom sending domain Send emails from your own domain for better deliverability and brand consistency. Includes DKIM and SPF authentication. – No Yes Yes Yes')),
    fact('Teammates at no charge', 'No charge for teammates.', 'Ghost(Pro) Starter includes 1 staff user, Publisher 3 and Business 15.', read(GHOST, 'Contributors and Suspended users are always free, they won\'t count towards your plan limits. 1 3 15 Unlimited')),
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent free every month.`, 'Ghost(Pro) starts with a 14-day free trial.', read('https://ghost.org/help/what-happens-when-my-ghost-pro-trial-ends/', 'Every Ghost(Pro) site starts with a 14-day free trial, and you won\'t be charged when it ends. To keep publishing, choose a plan')),
  ],
  // A newsletter's readers first see the list, the contacts and what keeps it clean.
  panels: ['campaign', 'contacts', 'hygiene', 'ready', 'domain', 'team', 'free'],
  without: ['signup forms', 'a web archive', 'a website', 'automations', 'paid subscriptions'],
  description: `Ghost(Pro) prices by subscribers, Nightmail by email. Monthly prices at ${listOf(sizes.map(formatCount))} subscribers, checked ${dayOf(CHECKED)}.`,
}
