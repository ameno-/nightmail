// (With extensions: the build's config imports this file, site-pages.ts.)
import { productName } from '../../../../api/src/brand.ts'
import { agentSetupGuide } from '../../../../api/src/agent-setup-guide.ts'
import { builtinDomainGuide } from '../../../../api/src/builtin-limits.ts'
import { webhookSignatureGuide } from '../../../../api/src/webhook-signature-guide.ts'

/** Each guide's address (/docs/<id>), title and summary, in the docs' order: guides.tsx gives each its body, and the
 *  build writes each its page (app/site-pages.ts) from these without loading the dashboard. */
export const GUIDE_NAMES: { id: string; title: string; summary: string }[] = [
  { id: 'receiving', title: 'Receiving', summary: 'How mail reaches your domain and where it goes: addresses, routes, rules and endpoints.' },
  { id: 'rules', title: 'Rules and AI decisions', summary: `Ready-made or scripted rules that post, forward, junk and label mail, and the questions they can ask ${productName}’s AI.` },
  { id: 'topics', title: 'Topics and unsubscribes', summary: 'Let people stop one kind of marketing email, such as events or product news, and keep the rest.' },
  { id: 'endpoints', title: 'Endpoints and routes', summary: 'Where mail can go besides the Inbox, and the difference between a route and a rule.' },
  { id: 'inboxes', title: 'Agent inboxes', summary: 'Expiring addresses that agents and end-to-end tests create, wait on and read.' },
  { id: 'mcp', title: 'Connect an agent (MCP)', summary: `Let OpenCode, Claude Code, Codex, Cursor, ChatGPT and other agents work with ${productName}: as you, with an API key, or with one inbox.` },
  { id: 'keys', title: 'Keys and tokens', summary: 'API keys, SMTP logins, agent tokens and app passwords.' },
  { id: agentSetupGuide.id, title: agentSetupGuide.title, summary: agentSetupGuide.summary },
  { id: builtinDomainGuide.id, title: builtinDomainGuide.title, summary: builtinDomainGuide.summary },
  { id: webhookSignatureGuide.id, title: webhookSignatureGuide.title, summary: webhookSignatureGuide.summary },
]
