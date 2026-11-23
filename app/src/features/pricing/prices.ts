import { CREDIT, perThousandUsd, RATES, STORAGE_AFTER_DAYS, usd } from '../../../../api/src/billing/rates.ts'

// Every price the public price pages show (features/pricing), in one place. Nightmail's own come from the billing code
// (api/src/billing/rates.ts), so a page can't drift from what is billed. Each competitor figure carries the vendor's
// page, the day it was read and the text it was read from. Only figures read on the vendor's own page are here: none is
// estimated or extrapolated, and a size the vendor's page doesn't price, or that wasn't read, shows no number. A figure
// that fails a re-check is removed, not left stale. api/scripts/check-premerge.ts (price pages) checks all of it.

/** The day every competitor figure below was read. */
export const CHECKED = '2026-11-22'
export type Source = { url: string; checked: string; quote: string }
const read = (url: string, quote: string): Source => ({ url, checked: CHECKED, quote })

/** What the calculator asks: emails sent and received a month, contacts on the list, teammates. */
export type Usage = { sent: number; received: number; contacts: number; seats: number }
export const MAX_INPUT = 1_000_000_000
/** Any text as a count: digits only, 0 when there are none, at most MAX_INPUT. */
export function count(value: unknown): number {
  const digits = String(value ?? '').replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '').slice(0, 10)
  const n = digits ? Number(digits) : 0
  return Number.isSafeInteger(n) ? Math.min(n, MAX_INPUT) : MAX_INPUT
}

export const formatCount = (n: number) => n.toLocaleString('en-US')
/** Whole US cents as micro-cents (1¢ = 1,000,000 µ¢), the billing code's unit. */
export const ucOf = (cents: number) => BigInt(cents) * 1_000_000n
/** A price as the pages print it: the billing code's usd() without the cents of a whole-dollar amount ("$270", "$26.50", "$0"). */
export const price = (uc: bigint) => usd(uc).replace(/\.00$/, '')
export const money = (cents: number) => price(ucOf(cents))
export const dayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

// ---------------------------------------------------------------- Nightmail, from the billing code

export const nightmail = {
  perThousand: `$${perThousandUsd(RATES.emailUc)}`,
  freeSent: RATES.freeSentEmails,
  freeReceived: RATES.freeReceivedEmails,
  storagePerGb: usd(RATES.storageUcPerGbMonth),
  freeStorageGb: Number(RATES.freeStorageBytes / 1_000_000_000n),
  storageAfterDays: STORAGE_AFTER_DAYS,
  minTopUp: money(CREDIT.minTopUpCents),
  expiresAfterMonths: CREDIT.expiresAfterMonths,
}

/** One meter's part of the bill: what was used, what was free, and what it costs. */
export type BillLine = { used: number; free: number; paid: number; uc: bigint; text: string }
/** Nightmail's monthly bill for a usage: (sent − free) and (received − free), each at RATES.emailUc, never below zero. */
export function nightmailBill(sent: number, received: number) {
  const line = (used: number, free: number): BillLine => {
    const paid = Math.max(0, used - free), uc = BigInt(paid) * RATES.emailUc
    return { used, free, paid, uc, text: price(uc) }
  }
  const s = line(sent, RATES.freeSentEmails), r = line(received, RATES.freeReceivedEmails), total = s.uc + r.uc
  return { sent: s, received: r, uc: total, text: price(total) }
}
/** The arithmetic behind one line, as the pages print it. */
export const billMath = (line: BillLine) => line.paid === 0
  ? `${formatCount(line.used)}, within ${formatCount(line.free)} free`
  : `(${formatCount(line.used)} − ${formatCount(line.free)} free) × ${nightmail.perThousand} per 1,000`
/** Paid usage comes from prepaid credit of at least CREDIT.minTopUpCents, which expires: below that a year, the least a year costs. */
export const yearlyFloor = (uc: bigint) => uc > 0n && uc * 12n < ucOf(CREDIT.minTopUpCents) ? nightmail.minTopUp : null

// ---------------------------------------------------------------- competitors priced in tiers

export type Tier = { size: number; cents: number; sends?: number; overage?: number; source: Source }
export type Plan = {
  name: string
  /** Seats the plan includes (null: unlimited); undefined when the vendor's price doesn't depend on them. */
  seats?: { count: number | null; source: Source }
  /** The largest size the plan is sold at. */
  max?: { size: number; source: Source }
  /** points: the first tier is also the plan's smallest, so it covers every size below it. */
  startsAtZero?: boolean
  note?: string
  tiers: Tier[]
}
export type Offer = {
  id: 'mailchimp' | 'resend' | 'resend-marketing'
  vendor: string
  name: string
  pricing: string
  unit: 'contacts' | 'emails'
  /** complete: every tier the vendor's page lists, so a size between two is priced at the next one up, as the vendor
   *  does. points: only the sizes that were read; a size between them has no checked price. */
  ladder: 'complete' | 'points'
  /** What the vendor sells past its last tier. */
  beyond?: { text: string; source: Source }
  counts: string
  plans: Plan[]
}

const MAILCHIMP = 'https://mailchimp.com/pricing/marketing/'
const mailchimpTier = (size: number, cents: number, sends: number, quote: string): Tier => ({ size, cents, sends, source: read(MAILCHIMP, quote) })
const mailchimpFree = read('https://mailchimp.com/help/about-mailchimp-pricing-plans/', 'The Free plan includes up to 250 contacts and 500 sends per month, with a daily send limit of 250.')
const mailchimpSeats = (count: number | null) => ({ count, source: read(MAILCHIMP, '"seats":{"essential":3,"free":1,"premium":"unlimited","standard":5}') })
// Every tier the pricing page lists up to 100,000 contacts (it loads them from /forms/pricing/?currency=USD), at list
// price: the page itself shows a first-year discount. Still 'points': a size between two tiers has no checked price here,
// because past a tier's sends Mailchimp bills overages, not the next tier.
export const mailchimp: Offer = {
  id: 'mailchimp', vendor: 'Mailchimp', name: 'Mailchimp', pricing: MAILCHIMP, unit: 'contacts', ladder: 'points',
  counts: 'contacts, sends and seats',
  plans: [
    { name: 'Free', seats: mailchimpSeats(1), startsAtZero: true, note: '250 sends a day', max: { size: 250, source: mailchimpFree }, tiers: [{ size: 250, cents: 0, sends: 500, source: mailchimpFree }] },
    { name: 'Essentials', seats: mailchimpSeats(3), max: { size: 50_000, source: read(MAILCHIMP, 'Essentials at 100,000 contacts: not offered (max 50,000 contacts)') }, tiers: [
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

const RESEND = 'https://resend.com/pricing'
const resendTier = (size: number, cents: number, overage: number | undefined, quote: string): Tier => ({ size, cents, ...overage === undefined ? {} : { overage }, source: read(RESEND, quote) })
export const resend: Offer = {
  id: 'resend', vendor: 'Resend', name: 'Resend', pricing: RESEND, unit: 'emails', ladder: 'complete',
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

const resendMarketingFree = read(RESEND, 'Free: marketing 1,000 contacts')
export const resendMarketing: Offer = {
  id: 'resend-marketing', vendor: 'Resend', name: 'Resend marketing', pricing: RESEND, unit: 'contacts', ladder: 'points',
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

export const OFFERS = [mailchimp, resend, resendMarketing] as const

export type Quote =
  | { kind: 'price'; plan: Plan; tier: Tier; cents: number; payg: { plan: Plan; tier: Tier; buckets: number; cents: number } | null }
  | { kind: 'unpublished'; text: string; source: Source }
  | { kind: 'unchecked' }

export const offerSize = (offer: Offer, u: Usage) => offer.unit === 'contacts' ? u.contacts : u.sent + u.received
type Fit = { tier: Tier } | 'no' | 'unknown'
// The tier a plan would sell for a usage, as the vendor's page states it: the smallest tier that holds the size, its
// sends and its seats. On a 'points' offer only a size that was read (or one below a plan's smallest tier) has one,
// and when that tier's sends are too few, the bigger tier that would hold them wasn't read.
function fit(offer: Offer, plan: Plan, size: number, u: Usage): Fit {
  if (plan.seats && plan.seats.count !== null && u.seats > plan.seats.count) return 'no'
  if (plan.max && size > plan.max.size) return 'no'
  const holds = (t: Tier) => t.sends === undefined || u.sent <= t.sends
  if (offer.ladder === 'complete') {
    const tier = plan.tiers.find(t => t.size >= size && holds(t))
    return tier ? { tier } : 'no'
  }
  const at = plan.tiers.find(t => t.size === size) ?? (plan.startsAtZero && size <= plan.tiers[0]!.size ? plan.tiers[0] : undefined)
  if (!at) return 'unknown'
  if (holds(at)) return { tier: at }
  return plan.max?.size === at.size ? 'no' : 'unknown'
}
/** A vendor's price for a usage: its cheapest plan that holds it, when every plan's answer is known. */
export function quote(offer: Offer, u: Usage): Quote {
  const size = offerSize(offer, u)
  const fits = offer.plans.map(plan => ({ plan, fit: fit(offer, plan, size, u) }))
  const priced = fits.flatMap(({ plan, fit }) => typeof fit === 'object' ? [{ plan, tier: fit.tier }] : []).sort((a, b) => a.tier.cents - b.tier.cents)
  const best = priced[0]
  // A $0 plan is the cheapest whatever the unknowns cost; otherwise an unknown plan might be cheaper.
  if (best && (best.tier.cents === 0 || !fits.some(f => f.fit === 'unknown'))) return { kind: 'price', plan: best.plan, tier: best.tier, cents: best.tier.cents, payg: payg(offer, size, best.tier.cents) }
  if (!best && offer.beyond && fits.every(f => f.fit === 'no')) return { kind: 'unpublished', ...offer.beyond }
  return { kind: 'unchecked' }
}
// Opting into pay-as-you-go instead: a smaller paid tier plus its overage buckets, when that costs less. Only within the
// sizes the vendor's tiers reach: past them its page names no price.
function payg(offer: Offer, size: number, price: number) {
  let found: { plan: Plan; tier: Tier; buckets: number; cents: number } | null = null
  if (offer.ladder !== 'complete' || size > Math.max(...offer.plans.flatMap(plan => plan.tiers.map(t => t.size)))) return null
  for (const plan of offer.plans) for (const tier of plan.tiers) {
    if (tier.overage === undefined || tier.size >= size) continue
    const buckets = Math.ceil((size - tier.size) / 1000), total = tier.cents + buckets * tier.overage
    if (total < price && (!found || total < found.cents)) found = { plan, tier, buckets, cents: total }
  }
  return found
}

// ---------------------------------------------------------------- the pages' comparisons and disclosures

/** short: the same claim in a few words, for a list that is scanned; note: what stands behind it, in a line (mailchimp.tsx). */
export type Fact = { text: string; short?: string; note?: string; source: Source }
/** A claim about Nightmail and the competitor's own page for the other half of it: text is the two sentences together. */
const fact = (short: string, ours: string, note: string, source: Source): Fact => ({ short, note, text: `${ours} ${note}`, source })
export type Comparison = {
  offer: Offer
  /** The three sizes, as the product map sets them. */
  sizes: Usage[]
  usage: string
  lead: string
  /** What Nightmail has that the competitor charges for or lacks, each with the competitor's page where it says so. */
  ours: (Fact | { text: string; short?: string; note?: string; source?: undefined })[]
  /** The same in one clause, after "Nightmail has". */
  summary?: string
  /** The sizes the price-against-a-price control can reach (contacts or emails a month, by the offer's unit), each one
   *  the vendor prices; use turns one into the usage both prices are for; assume is the line under the picture. On a
   *  'complete' ladder a typed size between the first and the last is priced too (reachable). */
  steps: number[]
  use: (size: number) => Usage
  assume: string
}
/** A competitor's price for a usage as a buyer would pay it: its cheapest plan, or pay-as-you-go where that costs less. */
export function theirPrice(offer: Offer, u: Usage): { cents: number; plan: string } | null {
  const q = quote(offer, u)
  if (q.kind !== 'price') return null
  return q.payg ? { cents: q.payg.cents, plan: `${q.payg.plan.name}, pay as you go` } : { cents: q.cents, plan: q.plan.name }
}
/** Every size the control can show: its steps, and on a 'complete' ladder every 1,000 between the first and the last. */
export function reachable(c: Comparison): number[] {
  if (c.offer.ladder !== 'complete') return c.steps
  const first = c.steps[0]!, last = c.steps.at(-1)!, grid = new Set(c.steps)
  for (let size = Math.ceil(first / 1000) * 1000; size <= last; size += 1000) grid.add(size)
  return [...grid].sort((a, b) => a - b)
}
/** The page's headline: the gap as it holds at every size the control can reach. */
export function claim(c: Comparison): string {
  const least = Math.min(...reachable(c).map(size => {
    const u = c.use(size), ours = nightmailBill(u.sent, u.received).uc, theirs = ucOf(theirPrice(c.offer, u)!.cents)
    return ours === 0n ? Infinity : Number(theirs) / Number(ours)
  }))
  if (least >= 2) return `${c.offer.vendor} costs ${Number.isInteger(least) ? 'at least' : 'over'} ${Math.floor(least)}\u00a0times as much as Nightmail`
  return `Nightmail costs less than ${c.offer.vendor}`
}
/** The Mailchimp comparison's use of a list: this many emails a month to every contact, this many teammates. */
export const MAILCHIMP_USE = { sendsPerContact: 4, seats: 3 }
const mailchimpSize = (contacts: number): Usage => ({ contacts, sent: contacts * MAILCHIMP_USE.sendsPerContact, received: 0, seats: MAILCHIMP_USE.seats })
export const comparisons: Record<'mailchimp' | 'resend', Comparison> = {
  mailchimp: {
    offer: mailchimp,
    sizes: [5_000, 25_000, 100_000].map(mailchimpSize),
    usage: 'Four campaigns a month to the whole list, 3 teammates, nothing received.',
    lead: 'Mailchimp prices by contacts. Nightmail prices by email.',
    // Every list size Mailchimp's page prices from 500 to 100,000 contacts.
    steps: [...new Set(mailchimp.plans.flatMap(plan => plan.tiers.map(tier => tier.size)))].filter(size => size >= 500 && size <= 100_000).sort((a, b) => a - b),
    use: mailchimpSize,
    assume: 'Four emails a month to each contact, 3 teammates, Mailchimp’s cheapest plan. List prices before tax.',
    summary: 'contacts and teammates at no charge, a role that edits but can’t send, and receiving email',
    ours: [
      fact('Contacts at no charge', 'No charge for contacts.', 'Mailchimp counts unsubscribed contacts too, at the month’s highest number.', read('https://mailchimp.com/help/about-mailchimp-pricing-plans/', '"Subscribed, unsubscribed, and non-subscribed contacts are included in your contact count." … "If your contact total increases beyond your contact limit at any time during your monthly billing cycle, we won’t interrupt your service. Instead, you’ll see an additional charge on your bill."')),
      fact('Teammates at no charge', 'No charge for teammates.', `Mailchimp Essentials includes ${mailchimp.plans[1]!.seats!.count} seats and Standard ${mailchimp.plans[2]!.seats!.count}.`, mailchimpSeats(3).source),
      fact('A role that edits but can’t send', 'Every workspace has a role that edits campaigns but can’t send them.', 'Mailchimp’s starts on Standard.', read('https://mailchimp.com/help/manage-user-levels-in-your-account/', 'Author "can create, edit, and delete emails and templates, and view reports" … Role-based Access: 5 Roles, 4 Roles, 2 Roles, Not included (Premium, Standard, Essentials, Free)')),
      { short: 'Receiving email', note: `${nightmail.perThousand} per 1,000 after ${formatCount(nightmail.freeReceived)} free.`, text: `Receiving email, at ${nightmail.perThousand} per 1,000 after ${formatCount(nightmail.freeReceived)} free.` },
    ],
  },
  resend: {
    offer: resend,
    sizes: [{ contacts: 0, sent: 10_000, received: 0, seats: 1 }, { contacts: 0, sent: 100_000, received: 0, seats: 1 }, { contacts: 0, sent: 1_000_000, received: 0, seats: 1 }],
    usage: 'Emails sent a month, one recipient each, nothing received.',
    lead: 'Resend sells a monthly allowance of email. Nightmail charges for each email.',
    // 10,000 emails, then every paid tier Resend's page lists up to its last (2,500,000; past it Resend names no price).
    // Not below: up to Resend's free 3,000 both cost $0, so Nightmail isn't cheaper there.
    steps: [10_000, ...new Set(resend.plans.flatMap(plan => plan.tiers.map(tier => tier.size)).filter(size => size >= 50_000))].sort((a, b) => a - b),
    use: (sent: number): Usage => ({ contacts: 0, sent, received: 0, seats: 1 }),
    assume: 'One recipient each, nothing received, Resend’s cheapest plan or pay-as-you-go. List prices before tax.',
    ours: [
      { short: 'A free allowance for received email', text: `Received email has its own ${formatCount(nightmail.freeReceived)} free a month. Resend counts it against the sending allowance.`, source: resendReceived },
      { short: 'Inboxes at no charge', text: 'No charge per inbox. Resend includes 3 and charges $1 a month for each one after that.', source: read(RESEND, 'Every plan includes 3 inboxes. Paid plans can enable pay-as-you-go to add more at $1 per inbox per month') },
      { short: 'Marketing without a contact plan', text: `No contact plan for marketing. Resend’s Pro marketing is ${money(resendMarketing.plans[1]!.tiers[0]!.cents)} a month at ${formatCount(resendMarketing.plans[1]!.tiers[0]!.size)} contacts.`, source: resendMarketing.plans[1]!.tiers[0]!.source },
    ],
  },
}
