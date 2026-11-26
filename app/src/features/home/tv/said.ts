// (With extensions: the build's config imports this file, through readable.ts and home-tv.ts.)
import { productName, publicOrigin } from '../../../../../api/src/brand.ts'
import { formatCount, listOf, nightmail } from '../../pricing/prices.ts'
import { CHECKED, MONTHS, OPENING, nightmailDollars, usd } from './data.ts'

// What the television homepage says in words, for whoever reads it without watching it: a search engine, an agent, a
// screen reader. The page's title and description (home-tv.ts), its hidden text (words.tsx), its Markdown twin and its
// structured data (readable.ts) all say these, so they agree; every figure is the billing code's (pricing/prices.ts)
// or the comparison's (data.ts), as the picture's are.

const each = `${nightmail.perThousand} per ${formatCount(1000)} emails`
const cost = (emails: number) => usd(nightmailDollars(emails))
const others = MONTHS[OPENING].filter(line => !line.ours)

/** The page's name in a tab, a search result and a link preview: after the product's name. */
export const TITLE = `Transactional email API, ${each}`
/** The page's one heading. */
export const HEADING = `${productName}: a transactional email API at ${each}`
/** What it is and what it costs, in two sentences. */
export const LEAD = `${productName} is an email API on Amazon SES for transactional and marketing email. Sending costs ${each} after the first ${formatCount(nightmail.freeSent)} free every month: ${cost(10_000)} for ${formatCount(10_000)} emails a month, ${cost(100_000)} for ${formatCount(100_000)} and ${cost(1_000_000)} for ${formatCount(1_000_000)}.`
/** The same for a search result's snippet and a link preview, in their length. */
export const DESCRIPTION = `Email API on Amazon SES for transactional and marketing email. ${each} sent, first ${formatCount(nightmail.freeSent)} free a month: ${cost(100_000)} for ${formatCount(100_000)}, ${cost(1_000_000)} for ${formatCount(1_000_000)}.`

/** What people ask about the price, each answered from the billing code and the comparison. */
export const QUESTIONS: { question: string; answer: string }[] = [
  { question: `How much does ${productName} cost?`,
    answer: `${each}, sent or received, after ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month. Contacts and teammates are not charged for.` },
  { question: `What do ${formatCount(10_000)}, ${formatCount(100_000)} and ${formatCount(1_000_000)} emails a month cost on ${productName}?`,
    answer: `${cost(10_000)} for ${formatCount(10_000)} emails sent in a month, ${cost(50_000)} for ${formatCount(50_000)}, ${cost(100_000)} for ${formatCount(100_000)} and ${cost(1_000_000)} for ${formatCount(1_000_000)}: the first ${formatCount(nightmail.freeSent)} are free and the rest cost ${each}.` },
  { question: `Does ${productName} have a free tier?`,
    answer: `Yes. Every month ${formatCount(nightmail.freeSent)} emails sent and ${formatCount(nightmail.freeReceived)} emails received are free, with ${nightmail.freeStorageGb} GB of stored mail.` },
  { question: 'Is there a subscription or a monthly plan?',
    answer: `No. There are no plans: usage is paid from prepaid credit. Top-ups start at ${nightmail.minTopUp} and expire ${nightmail.expiresAfterMonths} months after purchase.` },
  { question: `How does ${productName}’s price compare with ${listOf(others.map(line => line.name))}?`,
    answer: `For ${formatCount(OPENING)} emails sent in a month ${productName} costs ${cost(OPENING)}; ${listOf(others.map(line => `${line.name} ${usd(line.dollars)}`))}. Each is the vendor’s cheapest plan that holds the volume, at list price, read on its own pricing page on ${listOf(CHECKED)}.` },
  { question: 'What does receiving email cost?',
    answer: `Received email costs the same ${each} after ${formatCount(nightmail.freeReceived)} free every month. Received mail is kept for ${nightmail.storageAfterDays} days at no charge; kept longer, it costs ${nightmail.storagePerGb} per GB a month after ${nightmail.freeStorageGb} GB free.` },
  { question: `How does an AI agent set up ${productName}?`,
    answer: `It reads ${publicOrigin}/index.md and follows its steps for agents: it gets its own API key, which the person approves, saves it in the project’s environment, and sends with the REST API or the TypeScript SDK. The API’s documentation in Markdown is at ${publicOrigin}/docs.md.` },
]
