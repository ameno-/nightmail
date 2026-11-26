// (With extensions: the build's config imports this file, through readable.ts.)
import { dayOf, formatCount, listOf, money, nightmail, nightmailBill, theirPrice, ucOf, type Comparison, type Usage } from './prices.ts'

// The questions a comparison's page answers, made from its data alone: the one source for every page that shows them
// (board.tsx's Questions, the Markdown twin and the FAQPage: readable.ts), and for any other page about the same
// vendor. Every figure is the board's own (theirPrice and nightmailBill at the entry's sizes), with the day and the page
// the vendor's prices were read on; Nightmail's terms come from the billing code. No opinion and no superlative, and
// nothing about a provider the page doesn't compare (Ryan, A294).

/** One question and its answer. id says which question it is, so a page can pick or order them; question and answer are
 *  the text the page shows and its structured data carries, word for word. */
export type Question = { id: 'price' | 'less' | 'charges' | 'has' | 'lacks'; question: string; answer: string }

/** A comparison's questions, in reading order: what the vendor costs at the page's opening size; whether Nightmail
 *  costs less at its large size (only where the data says so); how each charges; what Nightmail has that the vendor
 *  charges for or lacks; and what the vendor has that Nightmail doesn't (where the entry names some). */
export function comparisonQuestions(c: Comparison): Question[] {
  const { vendor, model: m } = c
  const read = `${vendor}’s prices checked ${dayOf(c.offer.checked)} on ${host(c.offer.pricing)}`
  // The size the question names, then what it means in mail: the assumption first, so no figure needs working out.
  const asked = (u: Usage) => m.per === 'contact' ? `${formatCount(u.contacts)} contacts` : m.per === 'inbox' ? `${formatCount(u.inboxes ?? 0)} agent inboxes`
    : m.per === 'received' ? `${formatCount(u.received)} emails received a month` : `${formatCount(u.sent)} emails a month`
  const usage = (u: Usage) => m.per === 'contact' ? `${formatCount(u.contacts)} contacts sent ${m.sendsPerContact} emails each (${formatCount(u.sent)} emails a month)${m.seats > 1 ? `, with ${m.seats} teammates` : ''}`
    : m.per === 'inbox' ? `${formatCount(u.inboxes ?? 0)} agent inboxes, each receiving ${m.receivedPerInbox} and sending ${m.sentPerInbox} emails a month (${formatCount(u.received)} received and ${formatCount(u.sent)} sent)`
      : m.per === 'received' ? `${formatCount(u.received)} emails received a month` : `${formatCount(u.sent)} emails a month`
  const at = (u: Usage) => ({ theirs: theirPrice(c.offer, u)!, ours: nightmailBill(u.sent, u.received) })
  // A $0 bill says why beside it.
  const free = `inside its free ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received a month`
  const open = at(c.sizes[1]!), large = at(c.sizes[2]!)
  const cited = c.rows.flatMap(row => row.source ? [row.source] : [])
  return [
    { id: 'price', question: `What does ${vendor} cost for ${asked(c.sizes[1]!)}?`,
      answer: `For ${usage(c.sizes[1]!)}: ${money(open.theirs.cents)} a month on ${vendor} ${open.theirs.plan}, the least ${vendor} lists for that, before tax (${read}). The same mail costs ${open.ours.text} on Nightmail${open.ours.uc === 0n ? `: ${free}` : ''}.` },
    ...large.ours.uc < ucOf(large.theirs.cents) ? [{ id: 'less' as const, question: `Does Nightmail cost less than ${vendor} at ${asked(c.sizes[2]!)}?`,
      answer: `Yes. For ${usage(c.sizes[2]!)}, ${vendor} costs ${money(large.theirs.cents)} a month (${large.theirs.plan}) and Nightmail ${large.ours.text}${large.ours.uc === 0n ? `, ${free}` : ''} (${read}).` }] : [],
    { id: 'charges', question: `How does ${vendor} charge, and how does Nightmail?`,
      answer: `${c.lead} Nightmail’s price: ${nightmail.perThousand} per 1,000 emails, sent or received, after ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month; contacts and teammates are free.` },
    { id: 'has', question: `What does Nightmail have that ${vendor} charges for or lacks?`,
      answer: c.rows.map(row => row.text).join(' ') + (cited.length ? ` (Read on ${listOf([...new Set(cited.map(source => host(source.url)))])}, ${dayOf(cited.map(source => source.checked).sort().at(-1)!)}.)` : '') },
    ...c.without?.length ? [{ id: 'lacks' as const, question: `What does ${vendor} have that Nightmail doesn’t?`, answer: `${capital(listOf(c.without))}: Nightmail doesn’t have them.` }] : [],
  ]
}

/** A page's FAQPage for schema.org: its questions word for word as the page shows them. One per page. */
export const faqPage = (pageUrl: string, questions: Question[]) => ({
  '@type': 'FAQPage', '@id': `${pageUrl}#questions`,
  mainEntity: questions.map(item => ({ '@type': 'Question', name: item.question, acceptedAnswer: { '@type': 'Answer', text: item.answer } })),
})

const host = (page: string) => new URL(page).hostname.replace(/^www\./, '')
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
