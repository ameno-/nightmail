// (With extensions: the build's config imports this file, through pages.ts.)
import { comparisons } from '../compare/index.ts'
import type { Doc } from './doc.ts'
import { emailForAgents } from './agents.ts'
import { cheapestEmailApi } from './cheapest.ts'
import { freeEmailApi } from './free.ts'
import { vendorAlternatives } from './alternatives.ts'
import { ALTERNATIVES_VENDORS, PRICING_VENDORS } from './registry.ts'
import { vendorPricing } from './vendor-pricing.ts'
import { hubCard, hubDoc } from '../page/hub.ts'

// The pages that answer a question about email prices (docs/doc.ts), every one the registry names (registry.ts). pages.ts
// lists them among the price pages, so each gets what a price page gets (app/price-pages.ts): its own HTML with the words
// in it, its Markdown twin, its structured data, its sitemap entry and its line in llms.txt.

const pricingVendors = PRICING_VENDORS.map(slug => ({ slug, vendor: comparisons[slug]!.vendor }))
export const DOCS: Doc[] = [
  ...PRICING_VENDORS.map(slug => vendorPricing(comparisons[slug]!, pricingVendors)),
  ...ALTERNATIVES_VENDORS.map(slug => vendorAlternatives(comparisons[slug]!)),
  // The use-case pages, each from the comparisons of its kind.
  emailForAgents(),
  cheapestEmailApi(),
  freeEmailApi(),
]

/** A vendor's pricing page needs this much of its own to be worth an address: a page with less is a template with a name
 *  in it, and the build refuses it (docProblems). */
/** The one search phrase a title may ask as a question, on the one page that answers it: /cheapest-email-api's "Cheapest
 *  email API? 15 priced …" (docs/cheapest.ts), which states nothing about Nightmail. Exactly that, case-sensitive, and only
 *  there; nothing about "best" is exempt. */
const QUESTION = { path: '/cheapest-email-api', title: /^Cheapest email API\? / }

export const ENOUGH = { pricePoints: 4, citedFacts: 1, sizes: 3 }

/** What's wrong with the pages, as the build reports it (app/price-pages.ts): a registry entry with no comparison, a
 *  vendor with too little data for a page of its own, a title or description outside its length, an answer without the
 *  day its figures were read, or a figure without its source. Empty when they can ship. */
export function docProblems(): string[] {
  const problems: string[] = []
  for (const slug of PRICING_VENDORS) {
    const c = comparisons[slug]
    if (!c) { problems.push(`docs/registry.ts names ${slug}, which has no comparison (compare/index.ts).`); continue }
    const points = c.offer.plans.flatMap(plan => plan.tiers).length, cited = c.rows.filter(row => row.source).length
    if (points < ENOUGH.pricePoints || cited < ENOUGH.citedFacts || c.steps.length < ENOUGH.sizes)
      problems.push(`/pricing/${slug} would be thin: ${points} price points, ${cited} sourced facts and ${c.steps.length} sizes, against at least ${ENOUGH.pricePoints}, ${ENOUGH.citedFacts} and ${ENOUGH.sizes}. Leave it out of docs/registry.ts.`)
  }
  for (const doc of DOCS) {
    if (doc.searchTitle.length > 60) problems.push(`${doc.path}'s title is over 60 characters: ${doc.searchTitle}`)
    if (doc.description.length < 140 || doc.description.length > 160) problems.push(`${doc.path}'s description isn't 140 to 160 characters (${doc.description.length}): ${doc.description}`)
    if (!doc.cited.length) problems.push(`${doc.path}'s table cites no source.`)
    if (/\b(?:cheapest|best) (?:email|transactional|api|provider|service|option|choice|alternative|way to send|free)|\b(?:largest|biggest|most generous|highest) free\b|\bmost generous\b|Nightmail[^.]*\b(?:cheapest|best)\b/i.test([doc.path === QUESTION.path ? doc.searchTitle.replace(QUESTION.title, '') : doc.searchTitle, doc.description, JSON.stringify([doc.h1, doc.answer, doc.cardWords, doc.sections, doc.copy, doc.llms])].join(' ')))
      problems.push(`${doc.path} says "cheapest" or "best": no page states either of Nightmail (Ryan, A294).`)
    if (/\bAmazon SES\b|\bBento\b/.test(JSON.stringify(doc))) problems.push(`${doc.path} names Amazon SES or Bento: pages compare only providers Nightmail costs less than (Ryan, A294).`)
  }
  // A card gives the day or days read exactly as its page's caption does (docs/alternatives.ts, checkedOn), never only the
  // latest of a span.
  const pageText = (answer: unknown) => JSON.stringify(answer).replaceAll('\\u00a0', ' ').replaceAll('\u00a0', ' ')
  for (const { path, card, answer } of [...DOCS.map(doc => ({ path: doc.path, card: doc.cardWords.caption, answer: doc.answer })), { path: '/compare', card: hubCard().caption, answer: hubDoc().answer }]) {
    const day = card.match(/checked ([^.]+)\./)?.[1]
    if (day && !pageText(answer).includes(`checked ${day}`)) problems.push(`${path}'s card says "checked ${day}", which its page's caption doesn't.`)
  }
  if (new Set(DOCS.map(doc => doc.path)).size !== DOCS.length) problems.push('Two pages have the same address (docs/registry.ts).')
  return problems
}
