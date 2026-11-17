import { Navigate, useLocation, useParams } from 'react-router'

export { NewRecipeRoute, NewRitualPage, RitualRoute } from './recipes'

export { InboundPage } from './threads'
export { InboundAddressDetailPage } from './addresses'
export { ReceivingPage } from './receiving'
export { TracePage } from './trace'
export { InboundWebhookDetailPage } from './webhooks'

// Former /mailboxes links keep working: a mailbox is now an address filter on the thread-first inbox.
function LegacyRedirect({ to, address }: { to: string; address?: string }) {
  const location = useLocation()
  const search = new URLSearchParams(location.search)
  if (address) search.set('address', address)
  const query = search.toString()
  return <Navigate replace to={`${to}${query ? `?${query}` : ''}${location.hash}`} />
}
export const LegacyMailboxesRedirect = () => <LegacyRedirect to="/receiving" />
export function LegacyMailboxRedirect() { const { id = '' } = useParams(); return <LegacyRedirect to="/receiving/inbox" address={id} /> }
// Webhooks are endpoints: their list is Receiving's Endpoints tab, and an address's subscribers its address filter.
export function WebhooksListRedirect() {
  const address = new URLSearchParams(useLocation().search).get('address')
  return <Navigate replace to={`/receiving?tab=endpoints${address ? `&address=${encodeURIComponent(address)}` : ''}`} />
}
export const LegacyMailboxWebhooksRedirect = WebhooksListRedirect
export function LegacyMailboxWebhookRedirect() { const { id = '' } = useParams(); return <LegacyRedirect to={`/receiving/webhooks/${encodeURIComponent(id)}`} /> }

export { AgentInboxPage, AgentInboxesPage } from './inboxes'

// /receiving/rituals was the editor (?key= one ritual, ?new=1 a new one): its links land on the editor's own paths now,
// and the bare path on the Rituals tab.
export function RitualsRedirect() {
  const location = useLocation(), search = new URLSearchParams(location.search), key = search.get('key')
  const to = key ? `/receiving/rituals/${encodeURIComponent(key)}/code${location.hash}` : search.get('new') ? '/receiving/rituals/new' : '/receiving?tab=rituals'
  return <Navigate replace to={to} />
}
