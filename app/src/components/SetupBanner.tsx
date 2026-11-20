import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Clock } from 'lucide-react'
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
