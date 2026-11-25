import { useEffect, useRef, useState, type CSSProperties, type UIEvent } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { Button, CopyButton, ErrorText, SecretCode, Tabs } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { useApiMutation, usePublicOrigin, useSession, useWorkspaceAccess } from '../../data/context'
import { invalidate, resourceOf } from '../../data/invalidation'
import { usePrefetchRoute } from '../../data/prefetch'
import type { ApiKeyInput } from '../../data/types'
import { analytics } from '../../lib/analytics'
import { number } from '../../lib/format'
import { AgentSetupStatus, MaskedText, agentPrompt, useAgentSetup } from '../docs/agent-setup'
import { TestSend, sendLanguages, sendSnippets } from '../docs/first-send'
import { useDomain } from '../settings/domain-records'
import { BUILTIN_CAPS } from '../../../../api/src/builtin-limits'
import { Kbd, useStepKeys } from './keys'
import '../docs/developer.css'

const rise = (index: number) => ({ '--i': index }) as CSSProperties
type Tab = 'agent' | 'hand'
const tabs: { value: Tab; label: string }[] = [{ value: 'agent', label: 'Agent' }, { value: 'hand', label: 'By hand' }]

// Overview opens after Get started: its code and first reads load while the screen is up. A test sent here changes them,
// so they are read again then (returned: call it after the send, and again once it is delivered).
function useWarmOverview() {
  const prefetch = usePrefetchRoute('active'), client = useQueryClient()
  useEffect(() => { const timer = setTimeout(() => void prefetch('/overview'), 500); return () => clearTimeout(timer) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return () => {
    void client.invalidateQueries({ queryKey: ['identity'], exact: true }).catch(() => {})
    void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && ['overview', 'overview-setup', 'logs', 'emails', 'sender-score', 'sending-limit'].includes(resourceOf(query.queryKey)) })
      .then(() => prefetch('/overview')).catch(() => {})
  }
}

/**
 * Get started: working credentials on one screen, with no choice to make first. Agent (the default) is the agent prompt,
 * whose copy gives a coding agent its own key; By hand is an API key and a send example that runs as it is. Under both, an
 * optional test email to yourself, so Overview opens with an email in it. `domainId` is the domain the first sends go
 * from: Hosted's built-in domain (null while the account is still being set up) or a domain of your own just verified.
 * Every part is laid out from the first frame, so the domain landing moves nothing.
 */
export function GetStarted({ domainId, onFinish }: { domainId: string | null; onFinish: () => void }) {
  const identity = useSession()?.identity
  const origin = usePublicOrigin()
  const builtin = identity?.connection?.builtinDomain
  const domain = useDomain(domainId ?? '', 0, Boolean(domainId))
  const { canAdminister } = useWorkspaceAccess()
  const setup = useAgentSetup(Boolean(identity) && canAdminister)
  const rewarm = useWarmOverview()
  const [tab, setTab] = useState<Tab>('agent')
  // Which side the shown panel comes in from: none on the first paint, then the side of the tab it belongs to.
  const [enter, setEnter] = useState<'left' | 'right' | null>(null)
  // The test email's round trip through the API, measured here; its line keeps its place from the first frame.
  const [sentMs, setSentMs] = useState<number | null>(null)
  const shown = useRef(false)
  useEffect(() => { if (!shown.current) { shown.current = true; analytics().track('onboarding', 'start/shown') } }, [])
  useStepKeys({ enter: onFinish })

  // Hosted sends from its built-in domain, which /v1/me describes before the domain itself is read.
  const onBuiltin = !domainId || builtin?.id === domainId
  const name = onBuiltin ? builtin?.name ?? null : domain.data?.name ?? null
  const testDomain = onBuiltin ? builtin?.id && builtin.name ? { id: builtin.id, name: builtin.name, builtIn: true, status: 'verified' as const } : null : domain.data ?? null
  const testReady = onBuiltin ? builtin?.sending === 'ready' : undefined
  // Members only (the built-in domain's scope until 25 Dec 2026): the line says so before the domain is read, in the same
  // words, so it never re-wraps.
  const scope = builtin?.scope ?? 'members', perDay = builtin?.perDay ?? BUILTIN_CAPS[scope].perDay

  // The prompt as shown carries the setup token's placeholder; each copy carries a fresh token (useAgentSetup).
  const promptReady = Boolean(origin) && (domain.data !== undefined || domain.isError)
  const promptFor = (setupToken: string | null | undefined) => agentPrompt({ origin: origin!, domain: domain.data, email: identity?.email ?? null, multiTenant: identity?.multiTenant === true, setupToken })
  const preview = promptReady ? promptFor(setup ? null : undefined) : ''

  function pick(next: string) {
    if (next === tab) return
    setEnter(tabs.findIndex(item => item.value === next) > tabs.findIndex(item => item.value === tab) ? 'right' : 'left')
    setTab(next as Tab)
  }
  const panel = (value: Tab) => ({ role: 'tabpanel', 'aria-label': tabs.find(item => item.value === value)!.label, 'data-active': tab === value || undefined, 'data-enter': tab === value && enter ? enter : undefined, inert: tab !== value })

  return <div className="onboarding onboarding--narrow onb-get-started">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <h1 className="onboarding-title">Get started</h1>
      {onBuiltin && <p className="muted onboarding-builtin-copy onb-start-line" data-pending={!builtin || undefined}>
        Your built-in domain sends {scope === 'members' ? 'only to your own address' : 'to anyone'}, up to {number(perDay)}{scope === 'members' ? '' : ' recipients'} a day, until you <Link to="/domains?add" onClick={onFinish} data-analytics="onboarding/start/domain">add a domain</Link>.
      </p>}
    </div>
    <div className="onb-start onb-rise" style={rise(1)}>
      <Tabs label="How to start" value={tab} onValueChange={pick} items={tabs} />
      {/* Both panels share one cell: the taller sets its height, so switching moves nothing below them. */}
      <div className="onb-panels">
        <section className="onb-panel onb-panel--agent" {...panel('agent')}>
          <div className="onb-panel__actions" data-pending={!promptReady || undefined} inert={!promptReady}>
            <CopyAction value={promptReady ? setup ? setup.copy(promptFor) : promptFor(undefined) : ''} label="Copy agent prompt" text="Copy agent prompt" variant="primary" />
          </div>
          {setup ? <AgentSetupStatus setup={setup} idle="Paste it into your coding agent; it gets its own key." /> : <p className="muted onb-panel__line">Paste it into your coding agent: it connects with a device code.</p>}
          <Prompt text={preview} />
        </section>
        <section className="onb-panel" {...panel('hand')}>
          <ByHand from={name} />
        </section>
      </div>
    </div>
    <section className="onb-start-test onb-rise" style={rise(2)} aria-label="Test email">
      <TestSend domain={testDomain} ready={testReady} label="Send a test email" onLeave={onFinish} onSent={(_id, ms) => { setSentMs(ms); rewarm() }} onSettled={rewarm} />
      <p className="muted onb-start-time" data-shown={sentMs !== null || undefined} aria-hidden={sentMs === null || undefined}>Sent through the API in <strong className="onb-num">{`${Math.max(0, Math.round(sentMs ?? 0)).toLocaleString('en-US')} ms`}</strong></p>
    </section>
    <div className="onboarding-actions"><Button onClick={onFinish} data-analytics="onboarding/finish">Go to dashboard<Kbd>↵</Kbd></Button></div>
  </div>
}

// The prompt as the agent will read it, in a box that fills the panel and scrolls; its edges fade where it runs on.
function Prompt({ text }: { text: string }) {
  const ref = useRef<HTMLElement>(null)
  const fade = (node: HTMLElement) => {
    node.style.setProperty('--fade-top', `${Math.min(24, node.scrollTop)}px`)
    node.style.setProperty('--fade-bottom', `${Math.min(24, node.scrollHeight - node.clientHeight - node.scrollTop)}px`)
  }
  useEffect(() => { if (ref.current) fade(ref.current) }, [text])
  return <pre className="developer-code developer-code--prompt onb-prompt"><code ref={ref} tabIndex={0} aria-label="Agent prompt" onScroll={(event: UIEvent<HTMLElement>) => fade(event.currentTarget)}><MaskedText text={text} /></code></pre>
}

// By hand: a key that sends (shown once, here), then the first send with it from the domain, and the docs.
function ByHand({ from }: { from: string | null }) {
  const identity = useSession()?.identity, origin = usePublicOrigin()
  const create = useApiMutation((api, input: ApiKeyInput) => api.keys.create(input), undefined, false, invalidate.apiKeys)
  const [language, setLanguage] = useState('curl')
  const secret = create.data?.secret ?? null
  const ready = Boolean(origin && from)
  // Laid out with stand-ins until the domain is known, so the example keeps its height.
  const snippets = sendSnippets({ origin: origin ?? 'https://example.com', apiKey: secret, from: `hello@${from ?? 'example.com'}`, to: identity?.email ?? 'you@example.com' })
  return <>
    <div className="onb-key">
      <div className="onboarding-slot onb-key__slot">
        <span data-active={!secret || undefined} aria-hidden={secret ? true : undefined}>
          <Button variant="primary" loading={create.isPending} tabIndex={secret ? -1 : undefined} data-analytics="onboarding/start/key" onClick={() => create.mutate({ name: 'First API key', permissions: ['send'], domains: [] })}>Create API key</Button>
        </span>
        <span className="ui-secret onb-key__secret" data-active={secret ? true : undefined} aria-hidden={secret ? undefined : true}>
          <SecretCode>{secret ?? ''}</SecretCode>{secret && <CopyButton value={secret} label="Copy API key" />}
        </span>
      </div>
      <p className="muted onb-panel__line">{create.error ? <span className="onboarding-error"><ErrorText error={create.error} /></span> : secret ? 'Shown once: copy it now. It sends email; revoke it under API keys.' : 'A key for your server that sends email.'}</p>
    </div>
    <div className="onb-send">
      <div className="developer-client-bar">
        <Tabs label="Example language" value={language} onValueChange={setLanguage} items={sendLanguages} />
        <span data-pending={!ready || undefined} inert={!ready} className="onb-send__copy"><CopyAction key={language} value={snippets[language as 'curl' | 'sdk']} label={`Copy ${language === 'curl' ? 'cURL' : 'TypeScript'} example`} variant="ghost" size="sm" compact className="developer-copy-icon" /></span>
      </div>
      <div className="developer-client-panels developer-client-panels--fit" data-pending={!ready || undefined} data-sensitive={secret ? true : undefined}>{sendLanguages.map(item => <pre key={item.value} className="developer-code developer-client-panel" tabIndex={item.value === language ? 0 : -1} aria-label={`${item.label} example`} data-active={item.value === language || undefined} inert={item.value !== language}><code><MaskedText text={snippets[item.value as 'curl' | 'sdk']} /></code></pre>)}</div>
    </div>
    <a className="ui-button ui-button--ghost ui-button--md onb-docs" href="/docs#quickstart" target="_blank" rel="noopener" data-analytics="onboarding/start/docs">Read the docs<ArrowUpRight size={16} aria-hidden /></a>
  </>
}
