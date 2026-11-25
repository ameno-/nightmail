import { dayOf, fact, formatCount, listOf, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs MailerLite (/compare/mailerlite): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// MailerLite's own pages on CHECKED: the monthly prices in pricing.md, which carries its pricing page's table.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const MAILERLITE = 'https://www.mailerlite.com/pricing'
const MD = 'https://www.mailerlite.com/pricing.md'
const tier = (size: number, cents: number, sends: number | undefined, quote: string): Tier => ({ size, cents, sends, source: read(MD, quote) })
const freePlan = read(MD, '$0 per month. Up to 250 active subscribers. - 2,500 monthly emails - 2 user seats')
// Comfort sends up to 10 times its tier's ceiling a month and Power without a cap (fair use); both stop at 200,000.
const offer: Offer = {
  id: 'mailerlite', vendor: 'MailerLite', name: 'MailerLite', pricing: MAILERLITE, checked: CHECKED, unit: 'contacts', ladder: 'complete',
  counts: 'active subscribers and emails sent',
  beyond: { text: 'Enterprise, custom pricing', source: read(MD, 'Custom pricing for lists above 200,000 subscribers.') },
  plans: [
    { name: 'Free', max: { size: 250, source: read(MD, 'On a Free account, sending is locked for campaigns and automations once you pass 250 active subscribers.') }, tiers: [{ size: 250, cents: 0, sends: 2_500, source: freePlan }] },
    { name: 'Comfort', tiers: [
      tier(500, 1_200, 5_000, '| 500 | $12 | $10.80 | $25 | $22.50 |'),
      tier(1_000, 1_900, 10_000, '| 1,000 | $19 | $17.10 | $39 | $35.10 |'),
      tier(2_500, 3_300, 25_000, '| 2,500 | $33 | $29.70 | $49 | $44.10 |'),
      tier(5_000, 4_900, 50_000, '| 5,000 | $49 | $44.10 | $69 | $62.10 |'),
      tier(8_000, 6_900, 80_000, '| 8,000 | $69 | $62.10 | $99 | $89.10 |'),
      tier(10_000, 8_900, 100_000, '| 10,000 | $89 | $80.10 | $129 | $116.10 |'),
      tier(15_000, 12_900, 150_000, '| 15,000 | $129 | $116.10 | $179 | $161.10 |'),
      tier(20_000, 15_900, 200_000, '| 20,000 | $159 | $143.10 | $219 | $197.10 |'),
      tier(25_000, 17_900, 250_000, '| 25,000 | $179 | $161.10 | $239 | $215.10 |'),
      tier(30_000, 22_900, 300_000, '| 30,000 | $229 | $206.10 | $279 | $251.10 |'),
      tier(35_000, 24_900, 350_000, '| 35,000 | $249 | $224.10 | $309 | $278.10 |'),
      tier(40_000, 26_900, 400_000, '| 40,000 | $269 | $242.10 | $329 | $296.10 |'),
      tier(45_000, 28_900, 450_000, '| 45,000 | $289 | $260.10 | $359 | $323.10 |'),
      tier(50_000, 31_900, 500_000, '| 50,000 | $319 | $287.10 | $389 | $350.10 |'),
      tier(60_000, 35_900, 600_000, '| 60,000 | $359 | $323.10 | $419 | $377.10 |'),
      tier(70_000, 37_900, 700_000, '| 70,000 | $379 | $341.10 | $439 | $395.10 |'),
      tier(80_000, 39_900, 800_000, '| 80,000 | $399 | $359.10 | $459 | $413.10 |'),
      tier(90_000, 41_900, 900_000, '| 90,000 | $419 | $377.10 | $469 | $422.10 |'),
      tier(100_000, 43_900, 1_000_000, '| 100,000 | $439 | $395.10 | $489 | $440.10 |'),
      tier(110_000, 48_900, 1_100_000, '| 110,000 | $489 | $440.10 | $599 | $539.10 |'),
      tier(120_000, 52_900, 1_200_000, '| 120,000 | $529 | $476.10 | $649 | $584.10 |'),
      tier(130_000, 55_900, 1_300_000, '| 130,000 | $559 | $503.10 | $689 | $620.10 |'),
      tier(140_000, 58_900, 1_400_000, '| 140,000 | $589 | $530.10 | $719 | $647.10 |'),
      tier(150_000, 61_900, 1_500_000, '| 150,000 | $619 | $557.10 | $759 | $683.10 |'),
      tier(160_000, 65_900, 1_600_000, '| 160,000 | $659 | $593.10 | $829 | $746.10 |'),
      tier(170_000, 69_900, 1_700_000, '| 170,000 | $699 | $629.10 | $899 | $809.10 |'),
      tier(180_000, 73_900, 1_800_000, '| 180,000 | $739 | $665.10 | $959 | $863.10 |'),
      tier(190_000, 77_900, 1_900_000, '| 190,000 | $779 | $701.10 | $1,029 | $926.10 |'),
      tier(200_000, 81_900, 2_000_000, '| 200,000 | $819 | $737.10 | $1,119 | $1,007.10 |'),
    ] },
    { name: 'Power', tiers: [
      tier(500, 2_500, undefined, '| 500 | $12 | $10.80 | $25 | $22.50 |'),
      tier(1_000, 3_900, undefined, '| 1,000 | $19 | $17.10 | $39 | $35.10 |'),
      tier(2_500, 4_900, undefined, '| 2,500 | $33 | $29.70 | $49 | $44.10 |'),
      tier(5_000, 6_900, undefined, '| 5,000 | $49 | $44.10 | $69 | $62.10 |'),
      tier(8_000, 9_900, undefined, '| 8,000 | $69 | $62.10 | $99 | $89.10 |'),
      tier(10_000, 12_900, undefined, '| 10,000 | $89 | $80.10 | $129 | $116.10 |'),
      tier(15_000, 17_900, undefined, '| 15,000 | $129 | $116.10 | $179 | $161.10 |'),
      tier(20_000, 21_900, undefined, '| 20,000 | $159 | $143.10 | $219 | $197.10 |'),
      tier(25_000, 23_900, undefined, '| 25,000 | $179 | $161.10 | $239 | $215.10 |'),
      tier(30_000, 27_900, undefined, '| 30,000 | $229 | $206.10 | $279 | $251.10 |'),
      tier(35_000, 30_900, undefined, '| 35,000 | $249 | $224.10 | $309 | $278.10 |'),
      tier(40_000, 32_900, undefined, '| 40,000 | $269 | $242.10 | $329 | $296.10 |'),
      tier(45_000, 35_900, undefined, '| 45,000 | $289 | $260.10 | $359 | $323.10 |'),
      tier(50_000, 38_900, undefined, '| 50,000 | $319 | $287.10 | $389 | $350.10 |'),
      tier(60_000, 41_900, undefined, '| 60,000 | $359 | $323.10 | $419 | $377.10 |'),
      tier(70_000, 43_900, undefined, '| 70,000 | $379 | $341.10 | $439 | $395.10 |'),
      tier(80_000, 45_900, undefined, '| 80,000 | $399 | $359.10 | $459 | $413.10 |'),
      tier(90_000, 46_900, undefined, '| 90,000 | $419 | $377.10 | $469 | $422.10 |'),
      tier(100_000, 48_900, undefined, '| 100,000 | $439 | $395.10 | $489 | $440.10 |'),
      tier(110_000, 59_900, undefined, '| 110,000 | $489 | $440.10 | $599 | $539.10 |'),
      tier(120_000, 64_900, undefined, '| 120,000 | $529 | $476.10 | $649 | $584.10 |'),
      tier(130_000, 68_900, undefined, '| 130,000 | $559 | $503.10 | $689 | $620.10 |'),
      tier(140_000, 71_900, undefined, '| 140,000 | $589 | $530.10 | $719 | $647.10 |'),
      tier(150_000, 75_900, undefined, '| 150,000 | $619 | $557.10 | $759 | $683.10 |'),
      tier(160_000, 82_900, undefined, '| 160,000 | $659 | $593.10 | $829 | $746.10 |'),
      tier(170_000, 89_900, undefined, '| 170,000 | $699 | $629.10 | $899 | $809.10 |'),
      tier(180_000, 95_900, undefined, '| 180,000 | $739 | $665.10 | $959 | $863.10 |'),
      tier(190_000, 102_900, undefined, '| 190,000 | $779 | $701.10 | $1,029 | $926.10 |'),
      tier(200_000, 111_900, undefined, '| 200,000 | $819 | $737.10 | $1,119 | $1,007.10 |'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [1_000, 10_000, 100_000]
export const mailerLite: Entry = {
  slug: 'mailerlite',
  vendor: 'MailerLite',
  focus: 'newsletter',
  offer,
  model: { per: 'contact', sendsPerContact: 4, seats: 1 },
  sizes,
  // MailerLite's Free plan holds 250 subscribers, so the fader starts at its next list size and runs through every one
  // it prices, to 200,000.
  steps: tierSizes(offer, 500, 200_000),
  lead: 'MailerLite prices by subscribers. Nightmail prices by email.',
  assume: 'Four emails a month to each subscriber, 1 teammate, MailerLite’s cheapest plan that holds them. List prices before tax.',
  rows: [
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent free every month.`, 'MailerLite Free is 2,500 emails a month, for up to 250 subscribers.', freePlan),
    fact('Teammates at no charge', 'No charge for teammates.', 'MailerLite Free includes 2 seats and Comfort 3.', read(MD, '| Seats | 2 | 3 | Unlimited |')),
  ],
  // A newsletter's readers first see the list, the contacts and what keeps it clean.
  panels: ['campaign', 'contacts', 'hygiene', 'ready', 'team', 'free', 'domain'],
  without: ['signup forms', 'landing pages', 'a website', 'automations', 'paid subscriptions'],
  description: `MailerLite prices by subscribers, Nightmail by email. Monthly prices at ${listOf(sizes.map(formatCount))} subscribers, checked ${dayOf(CHECKED)}.`,
}
