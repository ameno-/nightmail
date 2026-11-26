// (With extensions: the build's config imports this file, through comparison.ts and hub.ts.)
import { formatCount, nightmail } from '../prices.ts'
import { PANELS } from '../panels.ts'
import type { Section } from './shape.ts'

// "Nightmail does this, this and this": the short list of facts under a price page's table (page.tsx draws it as a
// list). The facts true on every page are written here once, from the billing code (prices.ts, nightmail) and the
// product's own list (panels.ts), and every page that lists facts reuses them: the comparisons (comparison.ts, after
// their own), /compare (hub.ts), and any page made in the same shape (shape.ts). A page's own facts come first; a shared
// one whose subject a page's own already covers is left out; eight at most.

/** The facts every page can say, each with the subject that makes it a repeat of a page's own. */
export const SHARED_FACTS: { text: string; covers: RegExp }[] = [
  { text: `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month`, covers: /free (?:every|a) month/i },
  { text: 'Sends and receives on your own domains', covers: /own domain/i },
  { text: 'No charge for contacts', covers: /contact/i },
  { text: 'No charge for teammates', covers: /teammate/i },
  { text: `Campaigns and newsletters at the same ${nightmail.perThousand} per 1,000`, covers: /campaign|newsletter/i },
  { text: PANELS.agent.line.replace(/\.$/, ''), covers: /\bMCP\b|agent/i },
]
export const MAX_FACTS = 8

/** A page's list of facts: its own (each one line, without its full stop), then the shared ones it doesn't repeat. */
export function factsFor(own: string[]): string[] {
  const mine = [...new Set(own.map(text => text.trim().replace(/\.$/, '')))]
  return [...mine, ...SHARED_FACTS.filter(fact => !mine.some(text => fact.covers.test(text))).map(fact => fact.text)].slice(0, MAX_FACTS)
}
/** The facts as a page's section: a list under a small label. */
export const factsSection = (own: string[] = []): Section => ({ id: 'facts', title: 'With Nightmail', blocks: [{ kind: 'list', items: factsFor(own).map(text => [text]) }] })
