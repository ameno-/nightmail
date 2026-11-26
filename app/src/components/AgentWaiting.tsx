import { Link, useLocation } from 'react-router'
import { useApiQuery, useSession } from '../data/context'
import { request } from '../data/live'

type Waiting = { data: { userCode: string; clientName: string | null; createdAt: string; expiresAt: string }[] }

const minutesLeft = (at: string) => Math.max(1, Math.round((Date.parse(at) - Date.now()) / 60_000))

/**
 * An agent waiting for this person's approval (api/src/agent-setup.ts GET /v1/agent/device/waiting): one that held a
 * setup token they copied here, spent by the time it was used, and asked with a device code instead. Production agents
 * waited out their fifteen minutes while the person, in the dashboard, never saw the link the agent showed somewhere
 * else. Over the page, never in its flow, so nothing moves when it appears; one button opens /connect, where approving
 * is as it always is. Owners and admins only, who can approve.
 */
export function AgentWaiting() {
  const identity = useSession()?.identity
  const { pathname } = useLocation()
  const admin = identity?.role === 'owner' || identity?.role === 'admin'
  const waiting = useApiQuery(['agent-device-waiting', identity?.workspaceId ?? ''], (_api, signal) => request<Waiting>('/v1/agent/device/waiting', { signal }),
    { enabled: admin, interval: 15_000 })
  const agent = waiting.data?.data[0]
  if (!admin || !agent || pathname === '/connect' || Date.parse(agent.expiresAt) <= Date.now()) return null
  return <aside className="agent-waiting" aria-label="Agent waiting for approval">
    <span className="agent-waiting__pulse" aria-hidden="true" />
    <div className="agent-waiting__text" role="status">
      <p className="agent-waiting__what"><bdi>{agent.clientName ?? 'Your agent'}</bdi> is waiting for your approval</p>
      <p className="agent-waiting__when">Code {agent.userCode} · {minutesLeft(agent.expiresAt)} min left</p>
    </div>
    <Link className="ui-button ui-button--primary ui-button--sm agent-waiting__review" to={`/connect?code=${agent.userCode}`} data-analytics="agent-waiting/review">Review</Link>
  </aside>
}
