import { CREDIT, perThousandUsd, RATES, STORAGE_AFTER_DAYS, usd } from '../../../../api/src/billing/rates.ts'
import { EVALUATION, GROWTH } from '../../../../api/src/standing-model.ts'

// Every price the public price pages show (features/pricing), in one place. Nightmail's own come from the billing code
// (api/src/billing/rates.ts), so a page can't drift from what is billed. Each competitor figure carries the vendor's
// page, the day it was read and the text it was read from. Only figures read on the vendor's own page are here: none is
// estimated or extrapolated, and a size the vendor's page doesn't price, or that wasn't read, shows no number. A figure
// that fails a re-check is removed, not left stale. api/scripts/check-premerge.ts (price pages) checks all of it.

/** The day every competitor figure below was read. */
export const CHECKED = '2026-11-21'
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
const ucOf = (cents: number) => BigInt(cents) * 1_000_000n
export const money = (cents: number) => usd(ucOf(cents))
/** A price in a sentence: "$20" for whole dollars, else as money(). */
export const dollars = (cents: number) => cents % 100 === 0 ? `$${(cents / 100).toLocaleString('en-US')}` : money(cents)
export const dayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

// ---------------------------------------------------------------- Nightmail, from the billing code

export const nightmail = {
  perThousand: `$${perThousandUsd(RATES.emailUc)}`,
  freeSent: RATES.freeSentEmails,
  freeReceived: RATES.freeReceivedEmails,
  storagePerGb: usd(RATES.storageUcPerGbMonth),
  freeStorageGb: Number(RATES.freeStorageBytes / 1_000_000_000n),
  storageAfterDays: STORAGE_AFTER_DAYS,
  minTopUp: dollars(CREDIT.minTopUpCents),
  expiresAfterMonths: CREDIT.expiresAfterMonths,
  evaluation: EVALUATION.recipients,
  growthHours: GROWTH.hours,
}

/** One meter's part of the bill: what was used, what was free, and what it costs. */
export type BillLine = { used: number; free: number; paid: number; uc: bigint; text: string }
/** Nightmail's monthly bill for a usage: (sent − free) and (received − free), each at RATES.emailUc, never below zero. */
export function nightmailBill(sent: number, received: number) {
  const line = (used: number, free: number): BillLine => {
    const paid = Math.max(0, used - free), uc = BigInt(paid) * RATES.emailUc
    return { used, free, paid, uc, text: usd(uc) }
  }
  const s = line(sent, RATES.freeSentEmails), r = line(received, RATES.freeReceivedEmails), total = s.uc + r.uc
  return { sent: s, received: r, uc: total, text: usd(total) }
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
export const mailchimp: Offer = {
  id: 'mailchimp', vendor: 'Mailchimp', name: 'Mailchimp', pricing: MAILCHIMP, unit: 'contacts', ladder: 'points',
  counts: 'contacts, sends and seats',
  plans: [
    { name: 'Free', seats: mailchimpSeats(1), startsAtZero: true, note: '250 sends a day', max: { size: 250, source: mailchimpFree }, tiers: [{ size: 250, cents: 0, sends: 500, source: mailchimpFree }] },
    { name: 'Essentials', seats: mailchimpSeats(3), max: { size: 50_000, source: read(MAILCHIMP, 'Essentials at 100,000 contacts: not offered (max 50,000 contacts)') }, tiers: [
      mailchimpTier(5_000, 7_500, 50_000, '"essential" ... {"value":75 ...},"audience_size":5000,"sends":50000'),
      mailchimpTier(25_000, 27_000, 250_000, '{"value":270 ...},"audience_size":25000,"sends":250000'),
    ] },
    { name: 'Standard', seats: mailchimpSeats(5), tiers: [
      mailchimpTier(5_000, 10_000, 60_000, '"standard" ... {"value":100 ...},"audience_size":5000,"sends":60000'),
      mailchimpTier(25_000, 31_000, 300_000, '{"value":310 ...},"audience_size":25000,"sends":300000'),
      mailchimpTier(100_000, 80_000, 1_200_000, '{"value":800 ...},"audience_size":100000,"sends":1200000'),
    ] },
    { name: 'Premium', seats: mailchimpSeats(null), startsAtZero: true, tiers: [
      mailchimpTier(10_000, 35_000, 150_000, '"premium" ... {"value":350 ...},"audience_size":10000,"sends":150000 (Premium is not offered below 10,000)'),
      mailchimpTier(25_000, 62_000, 375_000, '{"value":620 ...},"audience_size":25000,"sends":375000'),
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

// ---------------------------------------------------------------- Amazon SES, priced per email

const SES = 'https://aws.amazon.com/ses/pricing/'
export const ses = {
  vendor: 'Amazon SES', name: 'Amazon SES', plan: 'Pay as you go', pricing: SES,
  /** $0.10 per 1,000 sent and per 1,000 received, in micro-cents per email. */
  ucPerEmail: 10_000n,
  sentSource: read(SES, 'Outbound email $0.10 / 1,000 emails | $0.12 per GB of attachment data sent'),
  receivedSource: read(SES, 'Inbound email $0.10 / 1,000 emails | $0.09 for every 1,000 incoming email chunks'),
  essentials: { ucPerEmail: 16_000n, source: read(SES, 'Essentials: 0 – 10M emails / month $0.16 per 1,000 emails … New SES accounts … will start on the Essentials plan beginning July 21, 2026.') },
}
export const sesPerThousand = (uc: bigint) => `$${perThousandUsd(uc)}`
export const sesBill = (u: Usage) => usd(BigInt(u.sent + u.received) * ses.ucPerEmail)

// ---------------------------------------------------------------- the pages' comparisons and disclosures

export type Fact = { text: string; source: Source }
/** Flodesk's flat monthly price, and the sent volume above which Nightmail costs more than it. */
const FLODESK_CENTS = 4_600
export const flodeskCrossover = RATES.freeSentEmails + Number(ucOf(FLODESK_CENTS) / RATES.emailUc)

/** Where Nightmail costs more, or isn't like for like (the calculator page). */
export const notCheaper: Fact[] = [
  { text: `Amazon SES on its own: ${sesPerThousand(ses.ucPerEmail)} per 1,000 sent or received (${sesPerThousand(ses.essentials.ucPerEmail)} sent on the Essentials plan, where new AWS accounts start). Connect your own AWS account and Nightmail charges nothing; Amazon bills you.`, source: ses.essentials.source },
  { text: 'Mailchimp’s paid plans include automations, sign-up forms, landing pages and A/B testing. Nightmail has none of these.', source: read(MAILCHIMP, 'visual automation flows …, templates, A/B testing, …, forms and landing pages') },
  { text: 'Kit is free up to 10,000 subscribers, without automations.', source: read('https://kit.com/pricing', '$0 /mo Free—up to 10,000 subscribers … Visual automation builder … Free: No') },
  { text: `Flodesk is ${dollars(FLODESK_CENTS)} a month for unlimited subscribers and sends. Nightmail costs more above ${formatCount(flodeskCrossover)} emails sent a month.`, source: read('https://flodesk.com/pricing', 'Email: $38/month with annual billing ($456/year), or $46/month billed monthly … Both paid plans include unlimited subscribers and unlimited email sends.') },
  { text: 'Cloudflare Email Routing forwards mail for free. On Nightmail a forward is one received and one sent email.', source: read('https://developers.cloudflare.com/email-service/platform/pricing/', 'Inbound emails (Email Routing) | Unlimited | Unlimited') },
]

export type Comparison = {
  offer: Offer
  /** The three sizes, as the product map sets them. */
  sizes: Usage[]
  usage: string
  lead: string
  /** What the competitor has that Nightmail doesn't, and the other way round. */
  theirs: Fact[]
  ours: (Fact | { text: string; source?: undefined })[]
}
export const comparisons: Record<'mailchimp' | 'resend', Comparison> = {
  mailchimp: {
    offer: mailchimp,
    sizes: [{ contacts: 5_000, sent: 20_000, received: 0, seats: 3 }, { contacts: 25_000, sent: 100_000, received: 0, seats: 3 }, { contacts: 100_000, sent: 400_000, received: 0, seats: 3 }],
    usage: 'Four campaigns a month to the whole list, 3 teammates, nothing received.',
    lead: 'Mailchimp prices by contacts. Nightmail prices by email.',
    theirs: [
      { text: 'Automation flows', source: read(MAILCHIMP, 'visual automation flows (Essentials up to 4 flow steps; Standard/Premium up to 200 flows)') },
      { text: 'Sign-up forms and landing pages', source: read(MAILCHIMP, 'forms and landing pages') },
      { text: 'A/B testing', source: read(MAILCHIMP, 'A/B testing, multivariate testing (Standard+)') },
      { text: 'Phone support on Premium', source: read(MAILCHIMP, 'phone and priority support and dedicated onboarding (Premium)') },
    ],
    ours: [
      { text: 'No charge for contacts. Mailchimp counts unsubscribed contacts too, at the month’s highest number.', source: read('https://mailchimp.com/help/about-mailchimp-pricing-plans/', '"Subscribed, unsubscribed, and non-subscribed contacts are included in your contact count." … "your bill will reflect the highest number of contacts stored in your account that month"') },
      { text: `No charge for teammates. Mailchimp Essentials includes ${mailchimp.plans[1]!.seats!.count} seats and Standard ${mailchimp.plans[2]!.seats!.count}.`, source: mailchimpSeats(3).source },
      { text: 'Every workspace has a role that edits campaigns but can’t send them. Mailchimp’s starts on Standard.', source: read('https://mailchimp.com/help/manage-user-levels-in-your-account/', 'Author "can create, edit, and delete emails and templates, and view reports" … Role-based Access: 5 Roles, 4 Roles, 2 Roles, Not included (Premium, Standard, Essentials, Free)') },
      { text: `Receiving email, at ${nightmail.perThousand} per 1,000 after ${formatCount(nightmail.freeReceived)} free.` },
    ],
  },
  resend: {
    offer: resend,
    sizes: [{ contacts: 0, sent: 10_000, received: 0, seats: 1 }, { contacts: 0, sent: 100_000, received: 0, seats: 1 }, { contacts: 0, sent: 1_000_000, received: 0, seats: 1 }],
    usage: 'Emails sent a month, one recipient each, nothing received.',
    lead: 'Resend sells a monthly allowance of email. Nightmail charges for each email.',
    theirs: [
      { text: 'Automations, 10,000 runs a month on paid plans', source: read(RESEND, 'All paid plans include 10,000 Automation Runs per month.') },
      { text: 'Dedicated IPs, $30 a month on Scale', source: read(RESEND, 'Dedicated IPs - $30 / mo') },
    ],
    ours: [
      { text: `Received email has its own ${formatCount(nightmail.freeReceived)} free a month. Resend counts it against the sending allowance.`, source: resendReceived },
      { text: 'No charge per inbox. Resend includes 3 and charges $1 a month for each one after that.', source: read(RESEND, 'Every plan includes 3 inboxes. Paid plans can enable pay-as-you-go to add more at $1 per inbox per month') },
      { text: `No contact plan for marketing. Resend’s Pro marketing is ${dollars(resendMarketing.plans[1]!.tiers[0]!.cents)} a month at ${formatCount(resendMarketing.plans[1]!.tiers[0]!.size)} contacts.`, source: resendMarketing.plans[1]!.tiers[0]!.source },
    ],
  },
}
