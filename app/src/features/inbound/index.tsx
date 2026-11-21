import { Navigate, useLocation, useParams } from 'react-router'
import { rulePath } from './shared'

export { NewRecipeRoute, NewRulePage } from './recipes'

export { InboundPage } from './threads'
export { InboundAddressDetailPage } from './addresses'
export { ReceivingPage } from './receiving'
export { TracePage } from './trace'
export { InboundWebhookDetailPage } from './webhooks'

// Former /mailboxes links keep working: a mailbox's mail is its address's Mail tab.
function LegacyRedirect({ to, address }: { to: string; address?: string }) {
  const location = useLocation()
  const search = new URLSearchParams(location.search)
  if (address) search.set('address', address)
  const query = search.toString()
  return <Navigate replace to={`${to}${query ? `?${query}` : ''}${location.hash}`} />
}
export const LegacyMailboxesRedirect = () => <LegacyRedirect to="/receiving" />
export function LegacyMailboxRedirect() { const { id = '' } = useParams(); return <LegacyRedirect to="/receiving/inbox" address={id} /> } // InboundPage forwards it on.
// Webhooks are destinations: their list is Receiving's Destinations tab, and an address's subscribers its address filter.
export function WebhooksListRedirect() {
  const address = new URLSearchParams(useLocation().search).get('address')
  return <Navigate replace to={`/receiving?tab=destinations${address ? `&address=${encodeURIComponent(address)}` : ''}`} />
}
export const LegacyMailboxWebhooksRedirect = WebhooksListRedirect
export function LegacyMailboxWebhookRedirect() { const { id = '' } = useParams(); return <LegacyRedirect to={`/receiving/webhooks/${encodeURIComponent(id)}`} /> }

export { AgentInboxPage, AgentInboxesPage } from './inboxes'

// Rules were called rituals. /receiving/rituals was first the editor (?key= one rule, ?new=1 a new one), then the rules'
// own paths under it: each old link lands on the same page under /receiving/rules, with its query and hash. A rule has
// one page, its code: the former form page's path is that page's, and /code under it comes here (App.tsx).
export function RitualsRedirect() {
  const location = useLocation(), search = new URLSearchParams(location.search), key = search.get('key'), rest = location.pathname.replace(/^\/receiving\/rituals\/?/, '')
  const to = rest ? `/receiving/rules/${rest}${location.search}${location.hash}`
    : key ? `${rulePath(key)}${location.hash}` : search.get('new') ? '/receiving/rules/new' : '/receiving?tab=rules'
  return <Navigate replace to={to} />
}
