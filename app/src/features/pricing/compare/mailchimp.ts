import { fact, formatCount, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs Mailchimp (/compare/mailchimp): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// Mailchimp's own pages on CHECKED.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const MAILCHIMP = 'https://mailchimp.com/pricing/marketing/'
const mailchimpTier = (size: number, cents: number, sends: number, quote: string): Tier => ({ size, cents, sends, source: read(MAILCHIMP, quote) })
const mailchimpFree = read('https://mailchimp.com/help/about-mailchimp-pricing-plans/', 'The Free plan includes up to 250 contacts and 500 sends per month, with a daily send limit of 250.')
const mailchimpSeats = (count: number | null) => ({ count, source: read(MAILCHIMP, 'Users … Unlimited 5 Seats 3 Seats 1 Seat') })
// Every tier the pricing page lists up to 100,000 contacts (it loads them from /forms/pricing/?currency=USD), at list
// price: the page itself shows a first-year discount. Still 'points': a size between two tiers has no checked price here,
// because past a tier's sends Mailchimp bills overages, not the next tier.
const offer: Offer = {
  id: 'mailchimp', vendor: 'Mailchimp', name: 'Mailchimp', pricing: MAILCHIMP, checked: CHECKED, unit: 'contacts', ladder: 'points',
  counts: 'contacts, sends and seats',
  plans: [
    { name: 'Free', seats: mailchimpSeats(1), startsAtZero: true, note: '250 sends a day', max: { size: 250, source: mailchimpFree }, tiers: [{ size: 250, cents: 0, sends: 500, source: mailchimpFree }] },
    { name: 'Essentials', seats: mailchimpSeats(3), max: { size: 50_000, source: read(MAILCHIMP, '"maxContacts":{"essential":50000,"free":250,"premium":1500000,"standard":100000}') }, tiers: [
      mailchimpTier(500, 1_300, 5_000, '"essential" ... {"value":13 ...},"audience_size":500,"sends":5000'),
      mailchimpTier(1_500, 2_650, 15_000, '{"value":26.5 ...},"audience_size":1500,"sends":15000'),
      mailchimpTier(2_500, 4_500, 25_000, '{"value":45 ...},"audience_size":2500,"sends":25000'),
      mailchimpTier(5_000, 7_500, 50_000, '{"value":75 ...},"audience_size":5000,"sends":50000'),
      mailchimpTier(10_000, 11_000, 100_000, '{"value":110 ...},"audience_size":10000,"sends":100000'),
      mailchimpTier(15_000, 18_000, 150_000, '{"value":180 ...},"audience_size":15000,"sends":150000'),
      mailchimpTier(20_000, 23_000, 200_000, '{"value":230 ...},"audience_size":20000,"sends":200000'),
      mailchimpTier(25_000, 27_000, 250_000, '{"value":270 ...},"audience_size":25000,"sends":250000'),
      mailchimpTier(30_000, 30_000, 300_000, '{"value":300 ...},"audience_size":30000,"sends":300000'),
      mailchimpTier(40_000, 34_000, 400_000, '{"value":340 ...},"audience_size":40000,"sends":400000'),
      mailchimpTier(50_000, 38_500, 500_000, '{"value":385 ...},"audience_size":50000,"sends":500000'),
    ] },
    { name: 'Standard', seats: mailchimpSeats(5), tiers: [
      mailchimpTier(500, 2_000, 6_000, '"standard" ... {"value":20 ...},"audience_size":500,"sends":6000'),
      mailchimpTier(1_500, 4_500, 18_000, '{"value":45 ...},"audience_size":1500,"sends":18000'),
      mailchimpTier(2_500, 6_000, 30_000, '{"value":60 ...},"audience_size":2500,"sends":30000'),
      mailchimpTier(5_000, 10_000, 60_000, '{"value":100 ...},"audience_size":5000,"sends":60000'),
      mailchimpTier(10_000, 13_500, 120_000, '{"value":135 ...},"audience_size":10000,"sends":120000'),
      mailchimpTier(15_000, 23_000, 180_000, '{"value":230 ...},"audience_size":15000,"sends":180000'),
      mailchimpTier(20_000, 28_500, 240_000, '{"value":285 ...},"audience_size":20000,"sends":240000'),
      mailchimpTier(25_000, 31_000, 300_000, '{"value":310 ...},"audience_size":25000,"sends":300000'),
      mailchimpTier(30_000, 34_000, 360_000, '{"value":340 ...},"audience_size":30000,"sends":360000'),
      mailchimpTier(40_000, 41_000, 480_000, '{"value":410 ...},"audience_size":40000,"sends":480000'),
      mailchimpTier(50_000, 45_000, 600_000, '{"value":450 ...},"audience_size":50000,"sends":600000'),
      mailchimpTier(75_000, 63_000, 900_000, '{"value":630 ...},"audience_size":75000,"sends":900000'),
      mailchimpTier(100_000, 80_000, 1_200_000, '{"value":800 ...},"audience_size":100000,"sends":1200000'),
    ] },
    { name: 'Premium', seats: mailchimpSeats(null), startsAtZero: true, tiers: [
      mailchimpTier(10_000, 35_000, 150_000, '"premium" ... {"value":350 ...},"audience_size":10000,"sends":150000 (Premium is not offered below 10,000)'),
      mailchimpTier(15_000, 46_500, 225_000, '{"value":465 ...},"audience_size":15000,"sends":225000'),
      mailchimpTier(20_000, 53_500, 300_000, '{"value":535 ...},"audience_size":20000,"sends":300000'),
      mailchimpTier(25_000, 62_000, 375_000, '{"value":620 ...},"audience_size":25000,"sends":375000'),
      mailchimpTier(30_000, 68_500, 450_000, '{"value":685 ...},"audience_size":30000,"sends":450000'),
      mailchimpTier(40_000, 75_000, 600_000, '{"value":750 ...},"audience_size":40000,"sends":600000'),
      mailchimpTier(50_000, 81_500, 750_000, '{"value":815 ...},"audience_size":50000,"sends":750000'),
      mailchimpTier(75_000, 90_000, 1_125_000, '{"value":900 ...},"audience_size":75000,"sends":1125000'),
      mailchimpTier(100_000, 102_500, 1_500_000, '{"value":1025 ...},"audience_size":100000,"sends":1500000'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [5_000, 25_000, 100_000]
export const mailchimp: Entry = {
  slug: 'mailchimp',
  vendor: 'Mailchimp',
  focus: 'newsletter',
  offer,
  model: { per: 'contact', sendsPerContact: 4, seats: 3 },
  sizes,
  // Every list size Mailchimp's page prices from 500 to 100,000 contacts.
  steps: tierSizes(offer, 500, 100_000),
  lead: 'Mailchimp prices by contacts. Nightmail prices by email.',
  assume: 'Four emails a month to each contact, 3 teammates, Mailchimp’s cheapest plan. List prices before tax.',
  rows: [
    fact('Contacts at no charge', 'No charge for contacts.', 'Mailchimp counts unsubscribed contacts too, at the month’s highest number.', read('https://mailchimp.com/help/about-mailchimp-pricing-plans/', '"Subscribed, unsubscribed, and non-subscribed contacts are included in your contact count." … "If your contact total increases beyond your contact limit at any time during your monthly billing cycle, we won’t interrupt your service. Instead, you’ll see an additional charge on your bill."'), { shared: 'contacts' }),
    fact('Teammates at no charge', 'No charge for teammates.', `Mailchimp Essentials includes ${offer.plans[1]!.seats!.count} seats and Standard ${offer.plans[2]!.seats!.count}.`, mailchimpSeats(3).source, { shared: 'teammates' }),
    fact('A role that edits but can’t send', 'Every workspace has a role that edits campaigns but can’t send them.', 'Mailchimp’s starts on Standard.', read('https://mailchimp.com/help/manage-user-levels-in-your-account/', 'The Author can create, edit, and delete emails and templates, and view reports. Standard or Premium'), 'Let someone edit campaigns without being able to send them'),
    { short: 'Receiving email', note: `${nightmail.perThousand} per 1,000 after ${formatCount(nightmail.freeReceived)} free.`, text: `Receiving email, at ${nightmail.perThousand} per 1,000 after ${formatCount(nightmail.freeReceived)} free.`, line: 'Receives email as well as sending it' },
  ],
  // Mailchimp's readers first see the list, the contacts and the team.
  panels: ['campaign', 'contacts', 'team', 'receive', 'free', 'agent', 'route'],
}
