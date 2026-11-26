import { fact, formatCount, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs AWeber (/compare/aweber): a comparison's whole entry (prices.ts, Entry). Every figure was read on AWeber's
// own pages on CHECKED.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const AWEBER = 'https://www.aweber.com/pricing.htm'
const HOME = 'https://www.aweber.com/'
const tier = (size: number, cents: number, sends: number, quote: string): Tier => ({ size, cents, sends, source: read(AWEBER, quote) })
const freePlan = read(HOME, 'Yes. AWeber\'s free plan covers up to 500 subscribers and 3,000 emails a month, with one landing page and one automation. There\'s no time limit and no credit card. Free sends carry AWeber branding.')
// Lite sends up to 10 times its tier's subscribers a month and Plus 12 times; past either, AWeber moves the account up a
// tier. Done For You is Plus with a setup fee, so it isn't a cheaper plan and isn't here.
const offer: Offer = {
  id: 'aweber', vendor: 'AWeber', name: 'AWeber', pricing: AWEBER, checked: CHECKED, unit: 'contacts', ladder: 'complete',
  counts: 'subscribers and emails sent',
  beyond: { text: 'A quote from AWeber', source: read(AWEBER, 'Have a list of 100,000+ subscribers? Contact us or call us at 1-877-293-2371') },
  plans: [
    { name: 'Free', max: { size: 500, source: read(HOME, 'The free plan is permanent and capped at 500 subscribers. The 14-day free trial gives you a paid plan, Lite or Plus, at no charge.') }, tiers: [{ size: 500, cents: 0, sends: 3_000, source: freePlan }] },
    { name: 'Lite', tiers: [
      tier(500, 1_500, 5_000, '500 5,000 $15.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(1_000, 2_500, 10_000, '1,000 10,000 $25.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(2_500, 3_500, 25_000, '2,500 25,000 $35.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(5_000, 6_000, 50_000, '5,000 50,000 $60.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(7_500, 8_500, 75_000, '7,500 75,000 $85.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(10_000, 10_000, 100_000, '10,000 100,000 $100.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(15_000, 15_000, 150_000, '15,000 150,000 $150.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(20_000, 18_500, 200_000, '20,000 200,000 $185.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(25_000, 21_000, 250_000, '25,000 250,000 $210.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(35_000, 27_500, 350_000, '35,000 350,000 $275.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(50_000, 37_500, 500_000, '50,000 500,000 $375.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(75_000, 50_000, 750_000, '75,000 750,000 $500.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(100_000, 60_000, 1_000_000, '100,000 1,000,000 $600.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(150_000, 92_000, 1_500_000, '150,000 1,500,000 $920.00 (Subscribers / Email Sends / Monthly Cost)'),
    ] },
    { name: 'Plus', tiers: [
      tier(500, 3_000, 6_000, '500 6,000 $30.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(1_000, 4_500, 12_000, '1,000 12,000 $45.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(2_500, 5_500, 30_000, '2,500 30,000 $55.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(5_000, 9_000, 60_000, '5,000 60,000 $90.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(7_500, 12_000, 90_000, '7,500 90,000 $120.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(10_000, 13_500, 120_000, '10,000 120,000 $135.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(15_000, 18_000, 180_000, '15,000 180,000 $180.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(20_000, 21_500, 240_000, '20,000 240,000 $215.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(25_000, 25_000, 300_000, '25,000 300,000 $250.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(35_000, 35_000, 420_000, '35,000 420,000 $350.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(50_000, 40_000, 600_000, '50,000 600,000 $400.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(75_000, 60_000, 900_000, '75,000 900,000 $600.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(100_000, 75_000, 1_200_000, '100,000 1,200,000 $750.00 (Subscribers / Email Sends / Monthly Cost)'),
      tier(150_000, 105_000, 1_800_000, '150,000 1,800,000 $1,050.00 (Subscribers / Email Sends / Monthly Cost)'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [1_000, 10_000, 100_000]
export const aweber: Entry = {
  slug: 'aweber',
  vendor: 'AWeber',
  focus: 'newsletter',
  offer,
  model: { per: 'contact', sendsPerContact: 4, seats: 1 },
  sizes,
  // AWeber's Free plan holds 500 subscribers, so the fader starts at its next list size and runs through every one it
  // prices, to 150,000.
  steps: tierSizes(offer, 1_000, 150_000),
  lead: 'AWeber prices by subscribers. Nightmail prices by email.',
  assume: 'Four emails a month to each subscriber, 1 teammate, AWeber’s cheapest plan that holds them. List prices before tax.',
  rows: [
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent free every month.`, 'AWeber’s free plan is 3,000 emails a month, for up to 500 subscribers.', freePlan, { shared: 'free' }),
    fact('Teammates at no charge', 'No charge for teammates.', 'AWeber Lite includes 3 users.', read(AWEBER, 'Users Ultd Unlimited Ultd Unlimited 3'), { shared: 'teammates' }),
    fact('No send allowance', `Every email is ${nightmail.perThousand} per 1,000, with no tiers.`, 'AWeber’s tiers include sends of 10 times their subscribers a month on Lite and 12 times on Plus.', read('https://docs.aweber.com/getting-started-with-aweber/aweber-information/how-many-messages-can-i-send-per-day', 'AWeber Plus: Each subscriber tier includes monthly sends equal to 12 times the number of subscribers in that tier. … AWeber Lite: … 10 times'), `Every email is ${nightmail.perThousand} per 1,000, with no plan to outgrow`),
  ],
  // A newsletter's readers first see the list, the contacts and what keeps it clean.
  panels: ['campaign', 'contacts', 'hygiene', 'ready', 'team', 'free', 'domain'],
  without: ['signup forms', 'landing pages', 'a web archive', 'automations', 'paid subscriptions'],
}
