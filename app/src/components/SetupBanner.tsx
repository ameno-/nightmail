import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Clock, TriangleAlert } from 'lucide-react'
import { Link, useLocation } from 'react-router'
import { useSession, useWorkspaceAccess } from '../data/context'
import { Button } from './ui'

// A member opens the dashboard before an owner or admin has set up sending (owners and admins go through onboarding
// first). The state comes with the session (GET /v1/me), so the banner is in place on the shell's first paint; it
// shares the standing banner's look.
export function SetupBanner() {
  const identity = useSession()?.identity
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const client = useQueryClient()
  const [checking, setChecking] = useState(false)
  const attention = identity?.connection?.state === 'ready' ? identity.connection.attention : null
  if (multiTenant && attention) return <ConnectionAttention message={attention} region={identity?.connection?.region} />
  if (!multiTenant || canAdminister || !identity || identity.connection?.state === 'ready') return null
  async function check() { setChecking(true); try { await client.refetchQueries({ queryKey: ['identity'], exact: true }) } finally { setChecking(false) } }
  return <div className="standing-banner setup-banner ui-tone--warning" role="status" data-setup="sending">
    <Clock className="standing-banner__icon" size={16} aria-hidden="true" />
    <div className="standing-banner__text">
      <p className="standing-banner__what">Sending isn’t set up yet.</p>
      <p className="standing-banner__did">An owner or admin sets it up. Until then, this workspace can’t send or receive mail.</p>
    </div>
    <Button className="standing-banner__fix" size="sm" loading={checking} onClick={() => void check()}>Check again</Button>
  </div>
}

// A connected AWS account's health check found something (GET /v1/me): one line, and where to look.
// On Settings → Sending itself the fix is in the account's SES console, not a link back to the same section.
function ConnectionAttention({ message, region }: { message: string; region?: string | null }) {
  const { pathname, hash } = useLocation()
  const here = pathname === '/settings' && hash === '#sending'
  return <div className="standing-banner setup-banner ui-tone--warning" role="status" data-setup="aws">
    <TriangleAlert className="standing-banner__icon" size={16} aria-hidden="true" />
    <div className="standing-banner__text"><p className="standing-banner__what">{message}</p></div>
    {here && region ? <a className="ui-button ui-button--secondary ui-button--sm standing-banner__fix" href={`https://${region}.console.aws.amazon.com/ses/home?region=${encodeURIComponent(region)}`} target="_blank" rel="noreferrer">Open SES console</a>
      : <Link className="ui-button ui-button--secondary ui-button--sm standing-banner__fix" to="/settings#sending">Sending settings</Link>}
  </div>
}
