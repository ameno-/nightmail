import { fact, formatCount, nightmail, readOn, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs Brevo (/compare/brevo): a comparison's whole entry (prices.ts, Entry). Every figure was read on Brevo's
// own pages on CHECKED: each paid tier's monthly total from its pricing page's configurator (Monthly selected), and the
// contacts each tier stores from pricing.md.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const BREVO = 'https://www.brevo.com/pricing/'
const MD = 'https://www.brevo.com/pricing.md'
// Brevo sells emails a month, and each tier stores so many contacts: here a tier's size is the contacts it stores and
// its sends the emails it includes, so the cheapest tier that holds both the list and four emails to each is its price.
const tier = (contacts: number, cents: number, sends: number, quote: string, url = BREVO): Tier => ({ size: contacts, cents, sends, source: read(url, quote) })
const daily = read(BREVO, '[Customize your plan › Free] Daily email volume (campaigns & transactional) Upgrade to remove daily sending limit. 300 emails/day … Free plan $0.00/month')
// Free stores 100,000 contacts but sends at most 300 emails a day, and an issue goes to the whole list in a day: so it
// holds a newsletter of at most 300 subscribers. Professional's tiers past 500,000 emails weren't read, so past
// Standard's 500,000 emails (125,000 subscribers at four each) the page names no price.
const offer: Offer = {
  id: 'brevo', vendor: 'Brevo', name: 'Brevo', pricing: BREVO, checked: CHECKED, unit: 'contacts', ladder: 'complete',
  counts: 'emails a month and contacts stored',
  plans: [
    { name: 'Free', note: '300 emails a day', max: { size: 300, source: daily }, tiers: [{ size: 300, cents: 0, source: daily }] },
    { name: 'Starter', tiers: [
      tier(500, 900, 5_000, '[Customize your plan › Starter, Monthly] 5,000 emails/month … Your plan Starter features $9.00/month 5,000 emails/month Included 500 contacts Included … Total price $9.00/month'),
      tier(1_500, 1_700, 10_000, '[Customize your plan › Starter, Monthly] 10,000 emails/month … Your plan Starter features $17.00/month 10,000 emails/month Included 1,500 contacts Included … Total price $17.00/month'),
      tier(2_500, 2_500, 15_000, '[Customize your plan › Starter, Monthly] 15,000 emails/month … Your plan Starter features $25.00/month 15,000 emails/month Included 2,500 contacts Included … Total price $25.00/month'),
      tier(500_000, 3_200, 20_000, '[Customize your plan › Starter, Monthly] 20,000 emails/month … Your plan Starter features $32.00/month 20,000 emails/month Included 500,000 contacts Included … Total price $32.00/month'),
      tier(500_000, 3_900, 30_000, '[Customize your plan › Starter, Monthly] 30,000 emails/month … Your plan Starter features $39.00/month 30,000 emails/month Included 500,000 contacts Included … Total price $39.00/month'),
      tier(500_000, 4_600, 40_000, '[Customize your plan › Starter, Monthly] 40,000 emails/month … Your plan Starter features $46.00/month 40,000 emails/month Included 500,000 contacts Included … Total price $46.00/month'),
      tier(500_000, 5_600, 50_000, '[Customize your plan › Starter, Monthly] 50,000 emails/month … Your plan Starter features $56.00/month 50,000 emails/month Included 500,000 contacts Included … Total price $56.00/month'),
      tier(500_000, 6_500, 60_000, '[Customize your plan › Starter, Monthly] 60,000 emails/month … Your plan Starter features $65.00/month 60,000 emails/month Included 500,000 contacts Included … Total price $65.00/month'),
      tier(500_000, 7_400, 80_000, '[Customize your plan › Starter, Monthly] 80,000 emails/month … Your plan Starter features $74.00/month 80,000 emails/month Included 500,000 contacts Included … Total price $74.00/month'),
      tier(500_000, 8_200, 100_000, '[Customize your plan › Starter, Monthly] 100,000 emails/month … Your plan Starter features $82.00/month 100,000 emails/month Included 500,000 contacts Included … Total price $82.00/month'),
    ] },
    { name: 'Standard', tiers: [
      tier(500, 1_800, 5_000, 'Starter and Standard include their first credit tier at no charge, so their prices are base prices. … | Standard | `business` | \\$18.00 |', MD),
      tier(1_500, 3_500, 10_000, '[Customize your plan › Standard, Monthly] 10,000 emails/month … Your plan Standard features $35.00/month 10,000 emails/month Included 1,500 contacts Included … Total price $35.00/month'),
      tier(2_500, 4_900, 15_000, '[Customize your plan › Standard, Monthly] 15,000 emails/month … Your plan Standard features $49.00/month 15,000 emails/month Included 2,500 contacts Included … Total price $49.00/month'),
      tier(500_000, 6_900, 20_000, '[Customize your plan › Standard, Monthly] 20,000 emails/month … Your plan Standard features $69.00/month 20,000 emails/month Included 500,000 contacts Included … Total price $69.00/month'),
      tier(500_000, 7_900, 30_000, '[Customize your plan › Standard, Monthly] 30,000 emails/month … Your plan Standard features $79.00/month 30,000 emails/month Included 500,000 contacts Included … Total price $79.00/month'),
      tier(500_000, 8_900, 40_000, '[Customize your plan › Standard, Monthly] 40,000 emails/month … Your plan Standard features $89.00/month 40,000 emails/month Included 500,000 contacts Included … Total price $89.00/month'),
      tier(500_000, 9_700, 50_000, '[Customize your plan › Standard, Monthly] 50,000 emails/month … Your plan Standard features $97.00/month 50,000 emails/month Included 500,000 contacts Included … Total price $97.00/month'),
      tier(500_000, 10_400, 60_000, '[Customize your plan › Standard, Monthly] 60,000 emails/month … Your plan Standard features $104.00/month 60,000 emails/month Included 500,000 contacts Included … Total price $104.00/month'),
      tier(500_000, 11_900, 80_000, '[Customize your plan › Standard, Monthly] 80,000 emails/month … Your plan Standard features $119.00/month 80,000 emails/month Included 500,000 contacts Included … Total price $119.00/month'),
      tier(500_000, 13_900, 100_000, '[Customize your plan › Standard, Monthly] 100,000 emails/month … Your plan Standard features $139.00/month 100,000 emails/month Included 500,000 contacts Included … Total price $139.00/month'),
      tier(500_000, 17_900, 150_000, '[Customize your plan › Standard, Monthly] 150,000 emails/month … Your plan Standard features $179.00/month 150,000 emails/month Included 500,000 contacts Included … Total price $179.00/month'),
      tier(500_000, 24_900, 250_000, '[Customize your plan › Standard, Monthly] 250,000 emails/month … Your plan Standard features $249.00/month 250,000 emails/month Included 500,000 contacts Included … Total price $249.00/month'),
      tier(500_000, 30_900, 350_000, '[Customize your plan › Standard, Monthly] 350,000 emails/month … Your plan Standard features $309.00/month 350,000 emails/month Included 500,000 contacts Included … Total price $309.00/month'),
      tier(500_000, 42_900, 500_000, '[Customize your plan › Standard, Monthly] 500,000 emails/month … Your plan Standard features $429.00/month 500,000 emails/month Included 500,000 contacts Included … Total price $429.00/month'),
    ] },
    { name: 'Professional', tiers: [
      tier(2_000_000, 49_900, 150_000, '[Customize your plan › Professional, Monthly] Your plan Professional features $499.00/month 150k emails/month Included 2 million contacts Included 10 Marketing seats … Total price $499.00/month'),
      tier(2_000_000, 59_900, 250_000, '[Customize your plan › Professional, Monthly] Your plan Professional features $599.00/month 250k emails/month Included 2 million contacts Included 10 Marketing seats … Total price $599.00/month'),
      tier(2_000_000, 69_900, 500_000, '[Customize your plan › Professional, Monthly] Your plan Professional features $699.00/month 500k emails/month Included 2 million contacts Included 10 Marketing seats … Total price $699.00/month'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [1_000, 10_000, 100_000]
export const brevo: Entry = {
  slug: 'brevo',
  vendor: 'Brevo',
  focus: 'newsletter',
  offer,
  model: { per: 'contact', sendsPerContact: 4, seats: 1 },
  sizes,
  // Every list size where Brevo's price changes, past the 300 subscribers its Free plan reaches: the most each tier
  // holds (its contacts, or a quarter of its emails), to Standard's 500,000 emails.
  steps: [...new Set([...offer.plans.flatMap(plan => plan.tiers.map(t => Math.min(t.size, (t.sends ?? Infinity) / 4))), ...sizes])].filter(size => size > 300).sort((a, b) => a - b),
  lead: 'Brevo prices by emails a month, with a cap on contacts. Nightmail prices by email.',
  assume: 'Four emails a month to each subscriber, 1 teammate, Brevo’s cheapest plan that holds them. List prices before tax.',
  rows: [
    fact('Contacts at no charge', 'No charge for contacts.', 'Brevo’s 5,000-email tier stores 500 contacts, and its 10,000-email tier 1,500.', read(MD, '| Starter | 5,000 emails | 500 | | Starter | 10,000 emails | 1,500 | | Starter | 15,000 emails | 2,500 | | Starter | 20,000 to 100,000 emails | 500,000 |'), { shared: 'contacts' }),
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent free every month.`, 'Brevo’s free plan sends at most 300 emails a day.', read(BREVO, 'Daily email volume (campaigns & transactional) Upgrade to remove daily sending limit. 300 emails/day'), { shared: 'free' }),
  ],
  // A newsletter's readers first see the list, the contacts and what keeps it clean.
  panels: ['campaign', 'contacts', 'hygiene', 'ready', 'team', 'free', 'send'],
  without: ['signup forms', 'landing pages', 'automations'],
}
