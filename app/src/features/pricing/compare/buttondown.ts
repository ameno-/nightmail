import { fact, formatCount, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs Buttondown (/compare/buttondown): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// Buttondown's own pages on CHECKED: each price from its pricing page's calculator, set to that list size.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const BUTTONDOWN = 'https://buttondown.com/pricing'
const tier = (size: number, cents: number, quote: string): Tier => ({ size, cents, source: read(BUTTONDOWN, quote) })
const free = read(BUTTONDOWN, 'Absolutely nothing for your first 100 subscribers.')
const contactUs = read(BUTTONDOWN, '100,000+ subscribers Buttondown will cost you: Contact us for a custom quote.')
// The calculator names no plans: one price per list size, and add-ons (automations, teams, whitelabeling) raise it to
// a bigger tier's price. Its prices assume at most one email a day to the whole list; four a month fits. From 100,000
// subscribers it asks you to get in touch.
const offer: Offer = {
  id: 'buttondown', vendor: 'Buttondown', name: 'Buttondown', pricing: BUTTONDOWN, checked: CHECKED, unit: 'contacts', ladder: 'complete',
  counts: 'active subscribers',
  beyond: { text: 'A custom quote', source: contactUs },
  plans: [
    { name: 'Free', max: { size: 100, source: free }, tiers: [
      tier(100, 0, 'Buttondown will cost you: Absolutely nothing for your first 100 subscribers. That price includes: Rich text or markdown editor Send from a custom domain Hosted newsletter archives Privacy-first'),
    ] },
    { name: 'Paid', max: { size: 99_999, source: contactUs }, tiers: [
      tier(1_000, 900, '[calculator at 1,000] $9/month or $90/year (two months free!) … Add-ons: Sponsorships +$20/month … Automations +$20/month Whitelabeling +$70/month Teams +$70/month'),
      tier(5_000, 2_900, '[calculator at 5,000] $29/month or $290/year (two months free!) … Automations Add-ons: Whitelabeling +$50/month Teams +$50/month'),
      tier(10_000, 7_900, '[calculator at 10,000] $79/month or $790/year (two months free!) … Automations Whitelabeling Teams'),
      tier(20_000, 13_900, '[calculator at 20,000] $139/month or $1390/year (two months free!)'),
      tier(40_000, 23_900, '[calculator at 40,000] $239/month or $2390/year (two months free!)'),
      tier(60_000, 31_900, '[calculator at 60,000] $319/month or $3190/year (two months free!)'),
      tier(80_000, 37_900, '[calculator at 80,000] $379/month or $3790/year (two months free!)'),
      tier(99_999, 45_900, '[calculator at 99,999] $459/month or $4590/year (two months free!)'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [1_000, 10_000, 80_000]
export const buttondown: Entry = {
  slug: 'buttondown',
  vendor: 'Buttondown',
  focus: 'newsletter',
  offer,
  model: { per: 'contact', sendsPerContact: 4, seats: 1 },
  sizes,
  // Buttondown is free to 100 subscribers, so the fader starts at its next list size and runs through every one it
  // prices, to 99,999 (from 100,000 it names no price).
  steps: tierSizes(offer, 1_000, 80_000),
  lead: 'Buttondown prices by subscribers. Nightmail prices by email.',
  assume: 'Four emails a month to each subscriber, 1 teammate, Buttondown’s cheapest plan that holds them. List prices before tax.',
  rows: [
    fact('Send as often as you like', `Every email is ${nightmail.perThousand} per 1,000, however often you send.`, 'Buttondown’s prices assume at most one email a day to the whole list.', read(BUTTONDOWN, 'All of these prices assume that you\'re sending at most one email a day to your entire subscriber base. If you\'re sending more than that, you\'ll need to contact us')),
    fact('Teammates at no charge', 'No charge for teammates.', 'Buttondown’s Teams adds $70 a month at 1,000 subscribers.', read(BUTTONDOWN, '[calculator at 1,000] Whitelabeling +$70/month Teams +$70/month')),
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent free every month.`, 'Buttondown is free for the first 100 subscribers.', free),
  ],
  // A newsletter's readers first see the list, the contacts and what keeps it clean.
  panels: ['campaign', 'contacts', 'hygiene', 'ready', 'team', 'free', 'domain'],
  without: ['signup forms', 'landing pages', 'a web archive', 'automations', 'paid subscriptions'],
}
