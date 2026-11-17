// Connecting an AI agent over MCP, in one place: Docs, API keys, Receiving's agent inboxes and each inbox show the
// same config, built by api/src/mcp-clients.ts (which createInboxConnection uses too).
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Alert, Button, Checkbox, Dialog, Field, Select, Tabs } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useApiQuery, usePublicOrigin, useSession, useWorkspaceAccess } from '../../data/context'
import { requestedScopes } from '../../../../api/src/brand'
import { request } from '../../data/live'
import { errorText } from '../../data/types'
import { mcpClientNames, mcpClients, mcpClientSteps, mcpServerUrl, mcpSnippet, type McpClient } from '../../../../api/src/mcp-clients'
import './developer.css'
import { useSingleFlight } from '../../lib/single-flight'

/** What an agent signed in with OAuth asks for. Only OpenCode lets the config choose; other clients ask for read. The
 *  docs explain each level (agent-setup.tsx); in the dashboard the labels say it. */
export const mcpAccess = [
  { value: 'read', label: 'Read only', grants: 1 },
  { value: 'send', label: 'Read and send', grants: 2 },
  { value: 'manage', label: 'Full access', grants: 3 },
] as const
export type McpAccess = typeof mcpAccess[number]['value']
/** The scope OpenCode asks for: this installation's scope names (read, send, manage) up to the chosen access. */
export function useMcpScope(access: McpAccess) {
  const scopes = useSession()?.identity?.mcpScopes ?? requestedScopes({})
  return [...scopes.slice(0, mcpAccess.find(option => option.value === access)!.grants), 'offline_access'].join(' ')
}
const clientTabs = mcpClients.map(value => ({ value, label: mcpClientNames[value] }))

/** The hosted MCP URL on this installation's canonical address, or null until that is known. */
export function useMcpUrl() { const origin = usePublicOrigin(); return origin ? mcpServerUrl(origin) : null }


/** Client tabs, the snippet with its copy button and the steps after it. Every tab shares one cell, so the height holds. */
export function McpClientSetup({ client, onClient, url, auth, label = 'MCP client' }: { client: McpClient; onClient: (client: McpClient) => void; url: string | null; auth: { bearer: string } | { scope?: string }; label?: string }) {
  const kind = 'bearer' in auth ? 'key' : 'oauth'
  if (!url) return <p className="muted developer-copy" role="status">Loading this installation’s address…</p>
  return <div className="stack">
    <Tabs label={label} value={client} onValueChange={value => onClient(value as McpClient)} items={clientTabs} />
    <div className="developer-client-panels" data-sensitive={kind === 'key' || undefined}>{mcpClients.map(value => {
      const snippet = mcpSnippet(value, url, auth)
      return <div key={value} className="stack developer-client-panel" data-active={value === client || undefined} inert={value !== client}>
        <div className="developer-snippet">
          <pre className={snippet.startsWith('claude ') ? 'developer-code developer-code--wrap' : 'developer-code'} tabIndex={0} aria-label={`${mcpClientNames[value]} setup`}><code>{snippet}</code></pre>
          <CopyAction key={`${value}:${snippet.length}`} value={snippet} label={`Copy ${mcpClientNames[value]} setup`} variant="ghost" size="sm" compact className="developer-copy-icon developer-snippet__copy" />
        </div>
        <ol className="developer-steps">{mcpClientSteps(value, kind).map(step => <li key={step}>{step}</li>)}</ol>
      </div>
    })}</div>
  </div>
}

/** A key just shown once (an API key of any access), already set up for each MCP client: no second secret to mint. */
export function McpKeySetup({ bearer }: { bearer: string }) {
  const [client, setClient] = useState<McpClient>('opencode')
  return <div className="stack"><strong className="connect-agent__title">Use it with an agent</strong><McpClientSetup client={client} onClient={setClient} url={useMcpUrl()} auth={{ bearer }} label="Agent" /></div>
}

type Inbox = { id: string; address: string; name: string | null; status: string; type: 'ephemeral' | 'sandbox' }
type Connection = { id: string | null; config: object; nextStep: string; key: string | null; client: McpClient }

/**
 * Connect an agent: as you over OAuth (it gets the access you approve in the browser, and you can narrow it to chosen
 * inboxes there), with a workspace API key (exactly that key's access, no browser), or to one agent inbox with an API
 * key for that inbox that can't reach anything else. Opened from an inbox, that inbox is chosen. Every open starts
 * fresh. `onCreateKey` opens Create key in place (the API keys page); elsewhere the option links there.
 */
export function ConnectAgentDialog({ open, onOpenChange, inboxId, onCreateKey }: { open: boolean; onOpenChange: (open: boolean) => void; inboxId?: string; onCreateKey?: () => void }) {
  const { canAdminister } = useWorkspaceAccess()
  const url = useMcpUrl()
  const [client, setClient] = useState<McpClient>('opencode')
  const [mode, setMode] = useState<'oauth' | 'apiKey' | 'key'>('oauth')
  const [access, setAccess] = useState<McpAccess>('read')
  const [inbox, setInbox] = useState('')
  const [reply, setReply] = useState(false)
  const [result, setResult] = useState<Connection | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inboxes = useApiQuery(['agent-inboxes', 'connect'], (_api, signal) => request<{ data: Inbox[] }>('/v1/inboxes?status=active&limit=100', { signal }).then(r => r.data), { enabled: open && canAdminister })
  useEffect(() => {
    if (!open) return
    setClient('opencode'); setMode(inboxId && canAdminister ? 'key' : 'oauth'); setAccess('read'); setInbox(inboxId ?? ''); setReply(false); setResult(null); setError('')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const active = (inboxes.data ?? []).filter(box => box.status === 'active')
  const chosen = inbox || active[0]?.id || ''
  const label = (box: Inbox) => <>{box.name ? `${box.name} · ` : null}<PrivateAddress value={box.address} /></>
  // Single flight: each call makes a new idempotency key, so a second click before the first answers would make a second key.
  const create = useSingleFlight('inbox-connections.create', async () => {
    if (!chosen) return
    setBusy(true); setError('')
    try {
      const made = await request<{ id: string | null; config: object; nextStep: string }>('/v1/inbox-connections', { method: 'POST', body: { inboxes: [chosen], client, auth: 'key', reply }, idempotencyKey: crypto.randomUUID() })
      // The key is inside the config, shown once; the snippet for every client is rebuilt from it.
      const bearer = JSON.stringify(made.config).match(/Bearer ((?:nm|bane)_mbx_[A-Za-z0-9_-]+)/)?.[1] ?? null // bane_: remove after rename cleanup
      setResult({ ...made, key: bearer, client })
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }, chosen)
  const scope = useMcpScope(access)
  const close = () => { if (!busy) onOpenChange(false) }
  // The options say what the agent gets; a client other than OpenCode asks for read, so its access shows Read only.
  return <Dialog open={open} onOpenChange={next => { if (!next) close() }} title="Connect an agent" className="connect-agent-dialog"
    footer={mode === 'key' && !result ? <><Button disabled={busy} onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={!chosen} onClick={() => void create()}>Create API key</Button></>
      : mode === 'apiKey' ? <><Button onClick={close}>Cancel</Button>{onCreateKey ? <Button variant="primary" onClick={() => { onOpenChange(false); onCreateKey() }}>Create API key</Button>
        : <Link className="ui-button ui-button--primary ui-button--md" to="/api-keys?create=read_send" onClick={close}>Create API key</Link>}</> : <Button variant="primary" onClick={close}>Done</Button>}>
    <div className="stack">
      {!result && <>
        <Field label="What it can reach">
          <Select value={mode} onValueChange={value => { setMode(value as typeof mode); setError('') }} options={[{ value: 'oauth', label: 'Sign in as me' }, ...(canAdminister ? [{ value: 'apiKey', label: 'This workspace, with an API key' }, { value: 'key', label: 'One agent inbox, with its own key' }] : [])]} />
        </Field>
        {mode === 'apiKey' ? null : mode === 'oauth' ? <Field label="Access it asks for">
          <Select value={client === 'opencode' ? access : 'read'} onValueChange={value => setAccess(value as McpAccess)} disabled={client !== 'opencode'} options={mcpAccess.map(({ value, label }) => ({ value, label }))} />
        </Field> : <>
          {inboxes.isPending || active.length ? <Field label="Inbox">
            <Select mask value={chosen} onValueChange={setInbox} disabled={inboxes.isPending} placeholder="Loading inboxes…" options={active.map(box => ({ value: box.id, label: label(box) }))} />
          </Field> : <div className="connect-agent__empty"><span>No active agent inboxes</span><Link className="ui-button ui-button--secondary ui-button--sm" to="/receiving/inboxes" onClick={close}>Create an agent inbox</Link></div>}
          <Checkbox checked={reply} onCheckedChange={setReply} label="Let it reply to senders (the inbox needs replies on)" />
          {/* Before the key exists: only the client, so the config made with the key is for the right one. */}
          <Field label="MCP client"><Select value={client} onValueChange={value => setClient(value as McpClient)} options={clientTabs} /></Field>
        </>}
      </>}
      {result && <Alert tone="success" title="API key created">Copy the setup now: the key is shown only once.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      {(mode === 'oauth' || result) && <McpClientSetup client={client} onClient={setClient} url={url} auth={result?.key ? { bearer: result.key } : { scope }} />}
    </div>
  </Dialog>
}

/** The button that opens it, wherever an agent might be connected from. */
export function ConnectAgentButton({ inboxId, variant = 'secondary', size = 'md', initiallyOpen = false }: { inboxId?: string; variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm' | 'md'; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  return <><Button variant={variant} size={size} onClick={() => setOpen(true)}>Connect an agent</Button><ConnectAgentDialog open={open} onOpenChange={setOpen} inboxId={inboxId} /></>
}
