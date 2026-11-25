import { dayOf, fact, formatCount, listOf, readOn, type Entry, type Offer } from '../prices.ts'

// Nightmail vs Agent Identity (/compare/agent-identity): a comparison's whole entry (prices.ts, Entry). Every figure was
// read on Agent Identity's own pages on CHECKED. Its pages disagree on how many identities a plan holds (pricing: 15 on
// Builder and 120 on Team; the changelog: 10 and 100), so the page offers only sizes where both give the same plan.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const AI = 'https://www.agent-identity.dev/pricing'
const LLMS = 'https://www.agent-identity.dev/llms.txt'
// Each plan's identities, an inbox each. Received mail isn't capped or charged, and its daily send caps are far above
// these sizes' sends.
const offer: Offer = {
  id: 'agent-identity', vendor: 'Agent Identity', name: 'Agent Identity', pricing: AI, checked: CHECKED, unit: 'inboxes', ladder: 'complete',
  counts: 'agent identities, an inbox each',
  beyond: { text: 'Enterprise, custom pricing', source: read(AI, 'Enterprise is for custom limits, international calling and dedicated support. Book a 15-minute call .') },
  plans: [
    { name: 'Free', tiers: [{ size: 5, cents: 0, source: read(AI, 'Yes. The Free plan has no time limit and includes 5 agent identities, each with its own inbox') }] },
    { name: 'Builder', tiers: [{ size: 15, cents: 1_900, source: read(LLMS, 'Builder: $19. 15 agent identities, 1 dedicated phone number, 4 GiB per mailbox, 15 custom email domains, no email footer watermark, 2,000 outbound emails a day.') }] },
    { name: 'Team', tiers: [{ size: 120, cents: 14_900, source: read(LLMS, 'Team: $149. 120 agent identities, 5 dedicated phone numbers, 6 GiB per mailbox, 150 custom email domains, 20,000 outbound emails a day.') }] },
  ],
}

const sizes: Entry['sizes'] = [10, 25, 100]
export const agentIdentity: Entry = {
  slug: 'agent-identity',
  vendor: 'Agent Identity',
  focus: 'agents',
  offer,
  model: { per: 'inbox', receivedPerInbox: 100, sentPerInbox: 50 },
  sizes,
  // 10 (Builder) and 25 to 100 (Team), where its pricing page and changelog agree on the plan.
  steps: [10, 25, 50, 100],
  lead: 'Agent Identity sells agent identities, an inbox each, in plans. Nightmail charges for each email, not each inbox.',
  assume: 'Each inbox receives 100 emails and sends 50 a month. Agent Identity’s cheapest plan that holds the identities. List prices before tax.',
  rows: [
    fact('IMAP and SMTP', 'IMAP and SMTP for mail apps.', 'Agent Identity’s IMAP and SMTP access isn’t available yet.', read(AI, 'SMS, iMessage and IMAP/SMTP access are not available yet.')),
    fact('No branding in your mail', 'No Nightmail branding in your mail, free allowance included.', 'Agent Identity’s free plan adds a footer watermark.', read(AI, 'Email footer watermark Yes Removed Removed Removed')),
  ],
  // Its readers first see the agents' inboxes, receiving and the domain.
  panels: ['agent', 'receive', 'domain', 'free', 'send', 'route', 'team'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} agent inboxes, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
