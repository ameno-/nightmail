import { useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { Alert, Button, Checkbox, ConfirmDialog, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, ErrorText, PageHeader, Tabs, type Column } from '../../components/ui'
import { useSession } from '../../data/context'
import { ApiError } from '../../data/types'
import { supportAgentsApi, supportAgentsKey, type SupportAgentApproval, type SupportAgentConnection, type SupportAgentRequest } from '../../data/support-agents'
import { relativeTime, shortDateTime } from '../../lib/format'
import { agentColumnDefs, AgentsLead, GlassLink, operatorTabPath, StaffOnly, useOperatorTabs } from './skeletons'

// Operator → Agents (/operator/agents): the agents you approved to work the support inbox as you (api/src/support-agents.ts),
// and where an agent's link lands. An agent signed in over MCP asks first, with a code and /operator/agents?code=…; the
// dialog opens over the list once the request has loaded (so nothing moves), shows which of your connections asks and
// what approving lets it do, and approves or denies it. Only your own connections, from this staff session.
const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/
/** A code as linked, in its shown form (BCDF-GHJK), or null if it can't be one. */
function readCode(value: string | null) {
  const code = (value ?? '').toUpperCase().replace(/[\s-]/g, '')
  return CODE.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : null
}
const def = (key: string) => agentColumnDefs.find(column => column.key === key)!
const when = (value: string) => `${shortDateTime(value)} UTC`
const agentName = (agent: SupportAgentConnection) => `${agent.client ?? 'Unnamed client'}${agent.profile ? ` · ${agent.profile}` : ''}`
const minutesLeft = (at: string) => Math.max(1, Math.round((Date.parse(at) - Date.now()) / 60_000))
// What an approval never lets an agent do, beside what it does (the request's own list, from the API).
const never = 'Choose who a reply goes to, approve proposals, pause sending, or change limits and billing'

export function OperatorAgentsPage() {
  const role = useSession()?.identity?.operator ?? null, tabs = useOperatorTabs(), navigate = useNavigate(), client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const code = readCode(params.get('code'))
  const agents = useQuery({ queryKey: supportAgentsKey, enabled: Boolean(role), queryFn: ({ signal }) => supportAgentsApi.list(signal) })
  const [revoking, setRevoking] = useState<SupportAgentApproval | null>(null)
  const menu = useRef<HTMLElement | null>(null)
  if (!role) return <StaffOnly />
  const columns: Column<SupportAgentApproval>[] = [
    { ...def('agent'), render: row => <span className="op-ws" title={agentName(row.agent)}><span className="op-cell"><bdi>{agentName(row.agent)}</bdi></span><span className="op-muted-id">as the connection names itself</span></span>,
      cardRender: row => agentName(row.agent) },
    { ...def('approved'), render: row => <span className="nowrap" title={when(row.approvedAt)}>{relativeTime(row.approvedAt)}</span>, cardRender: row => `Approved ${relativeTime(row.approvedAt)}` },
    { ...def('expires'), render: row => <span className="nowrap" title={when(row.expiresAt)}>{relativeTime(row.expiresAt)}</span>, cardRender: row => `· expires ${relativeTime(row.expiresAt)}` },
    { ...def('used'), render: row => row.lastUsedAt ? <span className="nowrap" title={when(row.lastUsedAt)}>{relativeTime(row.lastUsedAt)}</span> : <span className="muted">Not yet</span>,
      cardRender: row => row.lastUsedAt ? `Last used ${relativeTime(row.lastUsedAt)}` : 'Not used yet' },
    { ...def('actions'), render: row => <DropdownMenu label="Agent actions" title={agentName(row.agent)} items={[{ label: 'Revoke…', destructive: true, onSelect: () => { menu.current = document.activeElement as HTMLElement | null; setRevoking(row) } }]} /> },
  ]
  const closeRequest = () => setParams(previous => { const next = new URLSearchParams(previous); next.delete('code'); return next }, { replace: true })
  return <>
    <PageHeader title="Operator" actions={<GlassLink />} />
    <div className="op-page">
      <Tabs value="agents" label="Operator views" items={tabs} onValueChange={value => { if (value !== 'agents') navigate(operatorTabPath(value)) }} />
      <AgentsLead />
      {agents.isError && !agents.data ? <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
        : <DataTable columns={columns} rows={agents.data?.data ?? []} rowKey={row => row.id} loading={agents.isPending} skeletonRows={3}
          empty={<EmptyState title="No agents approved" description="Ask your agent what’s waiting in support. It shows you a link that brings you here to approve it." />} />}
    </div>
    {code && <ApproveDialog key={code} code={code} onClose={closeRequest} onApproved={() => void client.invalidateQueries({ queryKey: supportAgentsKey })} />}
    <ConfirmDialog open={revoking !== null} onOpenChange={next => { if (!next) setRevoking(null) }} danger returnFocus={menu} confirmLabel="Revoke"
      title={`Revoke ${revoking ? agentName(revoking.agent) : 'this agent'}?`} description="Its next call to the support inbox is refused. It can ask again, and you approve it again here."
      onConfirm={async () => { await supportAgentsApi.revoke(revoking!.id); await client.invalidateQueries({ queryKey: supportAgentsKey }) }} />
  </>
}

/** The request behind a link's code, to approve or deny: it opens once loaded, and says what came of the decision. */
function ApproveDialog({ code, onClose, onApproved }: { code: string; onClose: () => void; onApproved: () => void }) {
  const request = useQuery({ queryKey: [...supportAgentsKey, 'request', code], retry: false, staleTime: Infinity, gcTime: 0, queryFn: ({ signal }) => supportAgentsApi.lookUp(code, signal) })
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null)
  if (request.isPending) return null
  const agent = request.data
  const pending = agent?.status === 'pending' && !decided
  async function decide(decision: 'approve' | 'deny') {
    if (busy) return
    setBusy(decision); setError(null)
    try {
      await (decision === 'approve' ? supportAgentsApi.approve(code) : supportAgentsApi.deny(code))
      setDecided(decision === 'approve' ? 'approved' : 'denied')
      if (decision === 'approve') onApproved()
    } catch (cause) { setError(cause) }
    finally { setBusy(null) }
  }
  const close = () => { if (!busy) onClose() }
  const title = decided === 'approved' ? 'Agent approved' : decided === 'denied' ? 'Agent denied' : pending ? 'Approve this agent?' : 'Support inbox agent'
  return <Dialog open onOpenChange={next => { if (!next) close() }} title={title} className="op-agent-dialog" analytics="Approve support agent"
    description={pending ? 'Approve only an agent you’re using right now that shows this code. It works the support inbox as you.' : undefined}
    footer={pending ? <>
      <Button disabled={Boolean(busy)} loading={busy === 'deny'} onClick={() => void decide('deny')}>Deny</Button>
      <Button variant="ghost" disabled={Boolean(busy)} onClick={close}>Not now</Button>
      <Button variant="primary" disabled={!confirmed || Boolean(busy)} loading={busy === 'approve'} onClick={() => void decide('approve')}>Approve</Button>
    </> : <Button variant={decided ? 'primary' : undefined} onClick={close}>{decided ? 'Done' : 'Close'}</Button>}>
    {!agent ? <p className="muted">{request.error instanceof ApiError && request.error.status === 404 ? 'No agent of yours is waiting with that code. Check the link, or ask your agent to try again for a new one.' : <ErrorText error={request.error} />}</p>
      : decided ? <p>{decided === 'approved' ? `Ask your agent to try again: it can work the support inbox for ${agent.days} days, until you revoke it here.` : 'It gets nothing. If it asks again, it shows a new code.'}</p>
      : !pending ? <Alert tone={agent.status === 'expired' ? 'warning' : 'info'} title={agent.userCode}>{agent.status === 'expired' ? 'This code expired. Ask your agent to try again for a new one.'
        : agent.status === 'approved' ? 'This code was already approved: the agent is listed here.' : 'This code was denied: the agent got nothing.'}</Alert>
      : <Review agent={agent} confirmed={confirmed} onConfirmed={setConfirmed} disabled={Boolean(busy)} />}
    {error ? <Alert tone="danger"><ErrorText error={error} /></Alert> : null}
  </Dialog>
}

function Review({ agent, confirmed, onConfirmed, disabled }: { agent: SupportAgentRequest; confirmed: boolean; onConfirmed: (value: boolean) => void; disabled: boolean }) {
  return <div className="op-agent-review">
    <dl className="op-agent-facts">
      <dt>Code</dt><dd><code>{agent.userCode}</code></dd>
      <dt>Agent</dt><dd>{agent.agent.client ? <><bdi>{agent.agent.client}</bdi><span className="muted"> · as it names itself</span></> : <span className="muted">Didn’t name itself</span>}</dd>
      {agent.agent.profile && <><dt>Profile</dt><dd><bdi>{agent.agent.profile}</bdi></dd></>}
      <dt>Signed in</dt><dd>{agent.agent.connectedAt ? `As you, ${relativeTime(agent.agent.connectedAt)}` : 'As you'}</dd>
      <dt>Expires</dt><dd>In {minutesLeft(agent.expiresAt)} min</dd>
    </dl>
    <section className="op-agent-grants" aria-label="What the agent can do">
      <h3>For {agent.days} days, it can:</h3>
      <ul>
        {agent.can.map(text => <li key={text} data-can><Check size={14} strokeWidth={2.5} aria-hidden /><span>{text}</span></li>)}
        <li><X size={14} strokeWidth={2.5} aria-hidden /><span>Never: {never.charAt(0).toLowerCase() + never.slice(1)}</span></li>
      </ul>
      <p className="muted">Everything it does is recorded as yours, via agent. Customers see its replies as yours.</p>
    </section>
    <Checkbox checked={confirmed} onCheckedChange={onConfirmed} disabled={disabled} label={`This is my agent, and it shows ${agent.userCode}`} />
  </div>
}
