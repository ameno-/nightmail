import { fact, readOn, type Entry, type Offer } from '../prices.ts'

// Nightmail vs Nylas (/compare/nylas): a comparison's whole entry (prices.ts, Entry), of Nylas's Agent Accounts, its
// inboxes for AI agents (not its email and calendar sync API). Every figure was read on Nylas's own pages on CHECKED.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const NYLAS = 'https://www.nylas.com/pricing/'
const LIMITS = 'https://developer.nylas.com/docs/v3/agent-accounts/send-limits.md'
// Each plan's accounts and sent emails a month. Received mail isn't counted ("The send count tracks outbound messages
// only", LIMITS), so a plan here caps only what's sent. Pro sells more accounts at $0.40 each; its storage and bandwidth
// past 50 GB each, which depend on the size of the mail, aren't in these prices.
const offer: Offer = {
  id: 'nylas', vendor: 'Nylas', name: 'Nylas', pricing: NYLAS, checked: CHECKED, unit: 'inboxes', ladder: 'complete',
  counts: 'agent accounts, sent emails, storage and bandwidth',
  beyond: { text: 'Enterprise, custom pricing', source: read(NYLAS, 'Enterprise For when you\'re ready to scale. Custom Let\'s talk! Includes Volume band pricing') },
  plans: [
    { name: 'Free', tiers: [{ size: 3, cents: 0, sends: 3_000, source: read(NYLAS, 'Free For proving it works. $0 /month … AGENT ACCOUNTS 3 Accounts 3K emails/month, 3 GB storage & bandwidth') }] },
    { name: 'Essentials', tiers: [{ size: 10, cents: 1_500, sends: 10_000, source: read(NYLAS, 'Essentials For your first users. $15 /month … AGENT ACCOUNTS 10 Agent Accounts 10K emails/month, 10 GB storage & bandwidth 1 custom sending domain') }] },
    { name: 'Pro', tiers: [{
      size: 50, cents: 4_900, sends: 50_000, source: read(NYLAS, 'Pro … Monthly Annual For unpredictable volume. $49 /month $43 /month … 50 Agent accounts 50K emails/month 50 GB storage 50 GB bandwidth 10 custom sending domains'),
      extra: { per: 1, cents: 40, name: 'accounts', source: read(NYLAS, 'Agent accounts 3 Agent Accounts 10 Agent Accounts Monthly: 50 Agent Accounts +$0.40/additional account') },
    }] },
  ],
}

const sizes: Entry['sizes'] = [10, 100, 1_000]
export const nylas: Entry = {
  slug: 'nylas',
  vendor: 'Nylas',
  focus: 'agents',
  offer,
  model: { per: 'inbox', receivedPerInbox: 100, sentPerInbox: 50 },
  sizes,
  // From 10 inboxes (Essentials) to 1,000, where Pro's 50,000 sent emails a month are all used.
  steps: [10, 25, 50, 100, 250, 500, 1_000],
  lead: 'Nylas sells agent accounts in plans, and more at $0.40 each on Pro. Nightmail charges for each email, not each inbox.',
  assume: 'Each inbox receives 100 emails and sends 50 a month. Nylas’s cheapest plan, with more accounts on Pro where it needs them; storage and bandwidth past Pro’s 50 GB each not included. List prices before tax.',
  rows: [
    fact('Inboxes at no charge', 'No charge per inbox.', 'Nylas Pro includes 50 agent accounts and charges $0.40 a month for each one after that.', offer.plans[2]!.tiers[0]!.extra!.source),
    fact('No bandwidth charge', 'No charge for bandwidth.', 'Nylas Pro includes 50 GB a month, counting mail in both directions, and charges $0.80 per GB after that.', read(NYLAS, 'Agent bandwidth (GB/month) 3 GB/month 10 GB/month Monthly: 50 GB/month +$0.80/additional GB')),
    fact('IMAP and SMTP on every inbox', 'IMAP and SMTP for mail apps on every inbox.', 'Nylas includes them from Essentials, not on Free.', read(NYLAS, 'IMAP access & SMTP submission Access mailboxes over IMAP and send via SMTP. Not included Included Monthly: Included'), 'Every inbox works in mail apps, over IMAP and SMTP'),
  ],
  // Nylas's readers first see the agents' inboxes, receiving and the domain.
  panels: ['agent', 'receive', 'domain', 'free', 'send', 'team', 'route'],
}
