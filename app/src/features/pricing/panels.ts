import type { WorkspaceFocus } from '../../../../api/src/workspace-focus.ts'
import { nightmail, type PanelId } from './prices.ts'

/** "Also in the box", under a comparison's board: each panel's words, which features.tsx sets under its display and the
 *  comparison's Markdown twin lists (price-pages.ts). Every claim is the product's as shipped. */
export const PANELS: Record<PanelId, { title: string; line: string }> = {
  send: { title: 'Send from your app.', line: 'One API call each, and a signed webhook for every event.' },
  campaign: { title: 'Email your whole list.', line: `Campaigns and newsletters, at the same ${nightmail.perThousand} per 1,000.` },
  contacts: { title: 'No charge per contact.', line: 'You pay for the email, never for the list.' },
  team: { title: 'Bring the whole team.', line: 'No charge per seat. Members edit campaigns; admins send them.' },
  free: { title: 'Free every month.', line: 'Sent and received each have their own allowance.' },
  receive: { title: 'Receive mail, and reply.', line: 'Inboxes at no charge, with IMAP and SMTP for mail apps.' },
  agent: { title: 'Inboxes for your agents.', line: 'Agents read and answer email over MCP.' },
  route: { title: 'Route it. Keep the record.', line: 'Rules forward mail to Slack, Discord or a webhook.' },
  domain: { title: 'A domain from day one.', line: 'Start on a nightmail.email domain, then add yours, each record checked.' },
  ready: { title: 'Ready before it sends.', line: 'Each campaign’s review checks the domain and the list. Big first sends ramp.' },
  hygiene: { title: 'A cleaner list.', line: 'Typos, temporary and dead addresses are flagged, and campaigns skip them.' },
}
export const PANEL_IDS = Object.keys(PANELS) as PanelId[]

/** A comparison's first step for its reader, by its focus (prices.ts, Entry.focus), under its last Get started: only what
 *  a new workspace has or does as shipped (a Hosted workspace's built-in domain and its inbox: api/src/builtin-domain.ts;
 *  contact import: features/audience/import.tsx). */
export const FIRST_STEP: Record<WorkspaceFocus, string> = {
  agents: 'Every workspace comes with an inbox at its own nightmail.email address.',
  developer: 'Every workspace comes with a nightmail.email domain that sends to your own team at once, with no DNS to set up.',
  newsletter: 'Start by importing your list.',
  marketing: 'Start by importing your contacts.',
  personal: 'Every workspace comes with an inbox at its own nightmail.email address; add your own domain any time.',
}
