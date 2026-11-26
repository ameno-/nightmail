import { fact, formatCount, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs Loops (/compare/loops): a comparison's whole entry (prices.ts, Entry). Every figure was read on Loops's
// own pages on CHECKED: the monthly prices in pricing.md, which carries its pricing page's brackets.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const LOOPS = 'https://loops.so/pricing'
const MD = 'https://loops.so/pricing.md'
const tier = (size: number, cents: number, quote: string): Tier => ({ size, cents, source: read(MD, quote) })
const freePlan = read(MD, 'Our free plan includes unlimited contacts and up to 4,000 sends to your first 1,000 contacts in any rolling 30-day window, enough to email them weekly.')
// One paid plan, priced by subscribed contacts in 18 brackets, with no cap on sends. Free sends 4,000 emails in any 30
// days to the first 1,000 subscribed contacts.
const offer: Offer = {
  id: 'loops', vendor: 'Loops', name: 'Loops', pricing: LOOPS, checked: CHECKED, unit: 'contacts', ladder: 'complete',
  counts: 'subscribed contacts',
  beyond: { text: 'Enterprise, custom pricing', source: read(MD, 'name = Enterprise … price_usd_monthly = custom … subscriber_min = 1500001 … subscriber_max = null … custom_contract = true') },
  plans: [
    { name: 'Free', max: { size: 1_000, source: read(MD, 'Counts refer to subscribed contacts; 0 through 1,000 qualifies for Free, including exactly 1,000.') }, tiers: [{ size: 1_000, cents: 0, sends: 4_000, source: freePlan }] },
    { name: 'Growth', max: { size: 1_500_000, source: read(LOOPS, 'Growth $49 / month Up to 1,000 emails per second Subscribed contacts : Up to 5,000 contacts† 5,000 to 1.5 million subscribed contacts Marketing sends : Unlimited marketing sends') }, tiers: [
      tier(5_000, 4_900, 'name = 1,001–5,000 contacts … price_usd_monthly = 49 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(10_000, 9_900, 'name = 5,001–10,000 contacts … price_usd_monthly = 99 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(15_000, 14_900, 'name = 10,001–15,000 contacts … price_usd_monthly = 149 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(25_000, 19_900, 'name = 15,001–25,000 contacts … price_usd_monthly = 199 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(50_000, 24_900, 'name = 25,001–50,000 contacts … price_usd_monthly = 249 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(100_000, 39_900, 'name = 50,001–100,000 contacts … price_usd_monthly = 399 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(150_000, 59_900, 'name = 100,001–150,000 contacts … price_usd_monthly = 599 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(200_000, 79_900, 'name = 150,001–200,000 contacts … price_usd_monthly = 799 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(300_000, 119_900, 'name = 200,001–300,000 contacts … price_usd_monthly = 1199 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(400_000, 159_900, 'name = 300,001–400,000 contacts … price_usd_monthly = 1599 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(500_000, 199_900, 'name = 400,001–500,000 contacts … price_usd_monthly = 1999 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(600_000, 239_900, 'name = 500,001–600,000 contacts … price_usd_monthly = 2399 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(700_000, 279_900, 'name = 600,001–700,000 contacts … price_usd_monthly = 2799 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(800_000, 319_900, 'name = 700,001–800,000 contacts … price_usd_monthly = 3199 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(900_000, 359_900, 'name = 800,001–900,000 contacts … price_usd_monthly = 3599 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(1_000_000, 399_900, 'name = 900,001–1,000,000 contacts … price_usd_monthly = 3999 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(1_250_000, 439_900, 'name = 1,000,001–1,250,000 contacts … price_usd_monthly = 4399 … marketing_sends = unlimited … transactional_sends = unlimited'),
      tier(1_500_000, 479_900, 'name = 1,250,001–1,500,000 contacts … price_usd_monthly = 4799 … marketing_sends = unlimited … transactional_sends = unlimited'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [5_000, 10_000, 100_000]
export const loops: Entry = {
  slug: 'loops',
  vendor: 'Loops',
  focus: 'newsletter',
  offer,
  model: { per: 'contact', sendsPerContact: 4, seats: 1 },
  sizes,
  // Loops's Free plan holds 1,000 subscribers (4,000 emails), so the fader starts at its next bracket and runs through
  // every one it prices, to 1,500,000.
  steps: tierSizes(offer, 5_000, 1_500_000),
  lead: 'Loops prices by subscribers. Nightmail prices by email.',
  assume: 'Four emails a month to each subscriber, 1 teammate, Loops’s cheapest plan that holds them. List prices before tax.',
  rows: [
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent free every month.`, 'Loops Free is 4,000 sends in any 30 days, to the first 1,000 contacts.', freePlan),
    fact('Contacts at no charge', 'No charge for contacts.', 'Loops sets its price by subscribed contacts at each renewal.', read('https://loops.so/docs/account/billing.md', 'Your plan tier is always calculated based on the number of subscribed contacts you have **at the time of renewal**.')),
  ],
  // A newsletter's readers first see the list, the contacts and what keeps it clean.
  panels: ['campaign', 'contacts', 'hygiene', 'ready', 'free', 'send', 'receive'],
  without: ['signup forms', 'automations'],
}
