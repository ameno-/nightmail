// "Ask your agent": the add screen's one quiet way to have an agent write a ritual. The dialog holds the setup for a
// client that isn't connected yet (the same one Connect an agent shows, asking for full access) and prompts written for
// the workspace's first address.
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Button, Dialog, Disclosure } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useApiDef, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { Agent } from '../../data/types'
import type { McpClient } from '../../../../api/src/mcp-clients'
import { McpClientSetup, useMcpScope, useMcpUrl } from '../docs/connect-agent'
import { guides } from './concepts'
import { connectionTitle } from '../settings/key-labels'
import '../docs/developer.css'
import { productName } from '../../../../api/src/brand'

/** A prompt shown with its address masked; the copy holds the real address. */
type Prompt = { text: string; shown: ReactNode }
// With several workspaces the prompt names this one: the agent's calls act in the workspace they name, else its default.
function prompts(address: string | null, workspace: string | null): Prompt[] {
  const at = address ?? 'my support address', shown = address ? <PrivateAddress value={address} /> : at
  const mine = workspace ? `my ${productName} workspace '${workspace}'` : productName, shownMine = workspace ? <>my {productName} workspace ‘{workspace}’</> : productName
  return [
    { text: `In ${mine}, add a ritual on ${at} that labels refund requests and posts them to Slack.`, shown: <>In {shownMine}, add a ritual on {shown} that labels refund requests and posts them to Slack.</> },
    { text: `In ${mine}, list my rituals and explain what each one does to mail at ${at}.`, shown: <>In {shownMine}, list my rituals and explain what each one does to mail at {shown}.</> },
    { text: `In ${mine}, write a ritual for ${at} and try it on the last 5 emails before you save it.`, shown: <>In {shownMine}, write a ritual for {shown} and try it on the last 5 emails before you save it.</> },
  ]
}

/** A connected agent that can edit rituals here: active with full access (manage), for an owner or admin of this
 * workspace. Its calls name the workspace they act in, so any of the account's agents can work in this one. */
const canEdit = (app: Agent, admin: boolean) => app.status === 'active' && admin && app.permissions.includes('manage')

export function AskAgentLink({ address }: { address: string | null }) {
  const [open, setOpen] = useState(false)
  return <>
    <Button variant="ghost" size="sm" className="recipe-agent-link" onClick={() => setOpen(true)}>Ask your agent</Button>
    <Dialog open={open} onOpenChange={setOpen} className="ritual-agent-dialog" title="Ask your agent"
      footer={<><Link className="ui-button ui-button--ghost ui-button--md" to={guides.mcp}>How MCP works</Link><Button onClick={() => setOpen(false)}>Done</Button></>}>
      {open && <AgentSetup address={address} />}
    </Dialog>
  </>
}

function AgentSetup({ address }: { address: string | null }) {
  const [client, setClient] = useState<McpClient>('opencode')
  const identity = useSession()?.identity
  const admin = useWorkspaceAccess().canAdminister
  const several = (identity?.workspaces?.length ?? 0) > 1
  const workspace = several ? identity?.workspaces?.find(w => w.id === identity.workspaceId)?.name ?? null : null
  const apps = useApiDef(queries.agents(true))
  const url = useMcpUrl()
  const scope = useMcpScope('manage')
  const active = (apps.data ?? []).filter(app => app.own && app.status === 'active')
  const connected = active.find(app => canEdit(app, admin))
  // Connected but not able to edit rituals here: read or send access only, or a member of this workspace.
  const limited = !connected ? active[0] ?? null : null
  const status = apps.isPending ? 'Looking for a connected agent…'
    : connected ? <>Connected as <strong>{connectionTitle(connected)}</strong>.</>
    : limited ? <><strong>{connectionTitle(limited)}</strong> is connected but can’t change rituals in this workspace yet.</>
    : 'No agent is connected yet.'
  return <div className="stack ritual-agent__content">
    <p className="ritual-agent__status muted"><span className="ritual-agent__mark" data-connected={connected ? true : undefined} aria-hidden="true" />{status}</p>
    {limited && <p className="ritual-agent__note">{admin ? <>Connect it again and approve full access, or <Link to={`/settings/mcp/${encodeURIComponent(limited.id)}`}>revoke it in Settings</Link> first.</> : 'Rituals need an owner or admin of this workspace.'}</p>}
    {/* The setup opens from its heading, so the prompts stay in view under it. */}
    {!connected && <Disclosure className="ritual-agent__setup" title="Connect it, with full access">
      <McpClientSetup client={client} onClient={setClient} url={url} auth={{ scope }} />
    </Disclosure>}
    <div className="stack ritual-agent__step">
      <h3 className="ritual-agent__heading">Ask it</h3>
      <ul className="ritual-agent__prompts">{prompts(address, workspace).map(p => <li key={p.text} className="ritual-agent__prompt">
        <span>{p.shown}</span>
        <CopyAction value={p.text} label="Copy prompt" variant="ghost" size="sm" compact />
      </li>)}</ul>
    </div>
  </div>
}
