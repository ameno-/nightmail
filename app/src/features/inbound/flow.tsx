// The flow every receiving screen draws, top to bottom: Receive (the address) → Process (its rules) → Deliver (its
// destinations). The address panel and an address's page show it, and a test marks the path one email took: what it
// took is ticked, the rest goes quiet. Neutral throughout: the accent is for buttons and charts.
import { useState, type FormEvent, type ReactNode } from 'react'
import { AtSign, Check, Send, Workflow, type LucideIcon } from 'lucide-react'
import { Alert, Field, Input, LoadingRegion, StatusDot, Textarea } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { request } from '../../data/live'
import { errorText, type InboundAddress } from '../../data/types'
import { kindNote, outcomes, steps } from './concepts'
import { expiresIn, type Overview, type RouteEntry, type Target } from './overview'
import { Match, TargetIcon, targetName } from './parts'
import { RuleLine } from './recipes'
import { endpointStatusLabel, endpointStatusTone } from './ritual-connections'
import { receivingStatus } from './status'
import type { DryRun, TraceRecipient, TraceRow } from './trace'

export type StageKind = 'receive' | 'process' | 'deliver'
const stageIcons: Record<StageKind, LucideIcon> = { receive: AtSign, process: Workflow, deliver: Send }
/** The three stages' icons, the same on every screen: an address receives, a rule processes, a destination delivers. */
export function StageIcon({ kind, size = 14 }: { kind: StageKind; size?: number }) {
  const Icon = stageIcons[kind]
  return <Icon className="rcv-icon" size={size} aria-hidden="true" />
}

/** A test's verdict on one step: taken (true), passed by (false), or no test yet (undefined). */
export type Hit = boolean | undefined
const hitOf = (hit: Hit) => hit === undefined ? undefined : hit ? 'yes' : 'no'

export function Flow({ label, tested, children }: { label: string; tested?: boolean; children: ReactNode }) {
  return <ol className="flow" aria-label={label} data-tested={tested || undefined}>{children}</ol>
}
export function FlowStage({ kind, title = steps[kind].title, children }: { kind: StageKind; title?: ReactNode; children: ReactNode }) {
  return <li className="flow-stage" data-kind={kind}>
    <div className="flow-stage__head"><StageIcon kind={kind} /><span className="flow-stage__title">{title}</span></div>
    <div className="flow-stage__body">{children}</div>
  </li>
}
/** One line in a stage: an icon, what it is (a quieter note under it), and its status at the end, or a tick once a test took it. */
export function FlowItem({ icon, children, note, aside, hit }: { icon?: ReactNode; children: ReactNode; note?: ReactNode; aside?: ReactNode; hit?: Hit }) {
  return <div className="flow-item" data-hit={hitOf(hit)}>
    {icon ? <span className="flow-item__icon">{icon}</span> : null}
    <span className="flow-item__text"><span className="flow-item__main">{children}</span>{note ? <span className="flow-item__note">{note}</span> : null}</span>
    {hit ? <span className="flow-item__aside"><Check className="flow-item__tick" size={14} aria-label="Taken" /></span> : aside ? <span className="flow-item__aside">{aside}</span> : null}
  </div>
}

// ---------------------------------------------------------------- what a flow says, from the overview's one read

/** A destination's health, when it has one: ready, waiting for its recipient, paused or declined. */
export function Health({ status }: { status: Target['status'] }) {
  if (!status) return null
  return <StatusDot tone={endpointStatusTone[status]} muted={status === 'ready'}>{endpointStatusLabel[status]}</StatusDot>
}
const local = (value: string) => value.slice(0, value.indexOf('@') + 1)
/** What a row receives besides its own address, in a few words. */
function receiveNote(entry: RouteEntry): ReactNode {
  const a = entry.address
  if (entry.kind === 'catch_all') return 'Catch-all · any address without its own'
  if (entry.kind === 'pattern') return a ? <>Wildcard for <PrivateAddress value={a.address} /></> : kindNote.pattern
  if (entry.kind === 'route') return kindNote.route
  if (entry.kind === 'inbox') return [kindNote.inbox, expiresIn(a?.expiresAt)].filter(Boolean).join(' · ')
  if (a?.origin === 'auto') return kindNote.auto
  // Aliases and wildcards by their part before the @, as the list writes them: an address stays masked until revealed.
  const also = [...(a?.aliases ?? []), ...(a?.rules ?? [])].map(local)
  return [a?.displayName, a?.expiresAt ? expiresIn(a.expiresAt) : null, also.length ? `also ${also.join(', ')}` : null].filter(Boolean).join(' · ') || null
}

/** What one test run did for one recipient: where its mail went and which rules acted. */
export type TestOutcome = { recipient: TraceRecipient | null; rows: TraceRow[] }
export const outcomeOf = (result: DryRun, address: string): TestOutcome => ({
  recipient: result.recipients.find(r => r.address === address) ?? result.recipients[0] ?? null,
  rows: result.trace.filter(row => row.recipient === address),
})
const reached = (t: Target, r: TraceRecipient) => t.type === 'inbox' ? !!t.id && (r.inboxes ?? []).includes(t.id)
  : t.type === 'drop' ? !!r.dropped
  : t.type === 'store' || t.type === 'create_address' ? !r.dropped && !(r.inboxes ?? []).length && !(r.webhooks ?? []).length
  : !!t.id && (r.webhooks ?? []).includes(t.id)

/** The flow of one address, catch-all or wildcard, from the overview's row; a test outcome marks the path taken. */
export function EntryFlow({ entry, overview, outcome }: { entry: RouteEntry; overview: Overview; outcome?: TestOutcome | null }) {
  const rules = new Map(overview.rules.map(r => [r.key, r]))
  const domain = overview.domains.find(d => d.name === entry.host)
  const r = outcome?.recipient ?? null, tested = !!r
  const acted = new Set((outcome?.rows ?? []).filter(row => row.actions.length > 0).map(row => row.key))
  const failed = new Map((outcome?.rows ?? []).filter(row => row.error).map(row => [row.key, row.error!]))
  return <Flow label="Mail flow" tested={tested}>
    <FlowStage kind="receive">
      <FlowItem note={receiveNote(entry)} hit={tested || undefined}
        aside={domain && domain.status !== 'active' ? <StatusDot tone={receivingStatus[domain.status].tone}>{receivingStatus[domain.status].label}</StatusDot> : undefined}>
        <Match value={entry.match} />
      </FlowItem>
    </FlowStage>
    <FlowStage kind="process">
      {entry.rules.length ? entry.rules.map(key => {
        const rule = rules.get(key)
        return <FlowItem key={key} hit={tested ? acted.has(key) : undefined} note={failed.get(key)} aside={rule && !rule.enabled ? <StatusDot tone="neutral" muted>Off</StatusDot> : undefined}>
          <RuleLine rule={rule} keyName={key} />
        </FlowItem>
      }) : <FlowItem><span className="muted">{steps.process.empty}</span></FlowItem>}
    </FlowStage>
    <FlowStage kind="deliver">
      {entry.to.map(t => <FlowItem key={`${t.type}:${t.id}`} icon={<TargetIcon type={t.type} />} hit={r ? reached(t, r) : undefined}
        aside={<Health status={t.status} />}>
        {t.type === 'inbox' && t.id !== entry.address?.id ? <><PrivateAddress value={t.name} /> inbox</> : t.type === 'inbox' ? 'Its inbox' : <PrivateAddress value={targetName(t, entry.address?.id)} />}
        {/* A rule's destination gets only the mail that rule sends it. */}
        {t.via && <span className="flow-via">via a rule</span>}
      </FlowItem>)}
      {entry.toTruncated && <FlowItem><span className="muted">+{entry.toTotal - entry.to.length} more webhooks</span></FlowItem>}
    </FlowStage>
  </Flow>
}

const glob = (pattern: string) => new RegExp('^' + pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, c => '\\' + c)).join('.*') + '$')
/** How a recipient was matched, in a few words: its own address, a wildcard, the catch-all. */
function matchedBy(r: TraceRecipient, overview: Overview, addresses: Pick<InboundAddress, 'address' | 'rules'>[]): ReactNode {
  const routeRow = r.route ? overview.routes.data.find(e => e.route?.id === r.route) : undefined
  const wildcard = routeRow?.match ?? addresses.flatMap(a => a.rules).find(rule => glob(rule).test(r.address))
  if (r.tier === 'pattern') return wildcard ? <>Caught by the wildcard <Match value={wildcard} /></> : 'Caught by a wildcard'
  if (r.tier === 'subaddress') return 'Caught by its address without the +tag'
  if (r.tier === 'catchall') return 'Caught by the catch-all'
  if (r.tier === 'default') return r.domainDefault === 'create_address' ? 'No address yet · the catch-all creates it' : 'No address yet · the catch-all keeps it'
  return 'Its own address'
}
/** The path one email took, from a test: where it was received and how, the rules that ran (ticked when they acted),
 *  and where it was delivered. Until the test answers it is one loading block, replaced whole (a stage that grew as
 *  its rules arrived would push the next one down); the caller says what failed. */
export function OutcomeFlow({ address, overview, outcome, error, addresses = [] }: { address: string; overview: Overview; outcome: TestOutcome | null; error: string | null; addresses?: InboundAddress[] }) {
  const r = outcome?.recipient ?? null
  if (!r && !error) return <LoadingRegion label="Testing"><div className="flow-skeleton" aria-hidden="true"><span /><span /><span /></div></LoadingRegion>
  return <Flow label="Mail flow" tested={!!r}>
    <FlowStage kind="receive"><FlowItem hit={r ? true : undefined} note={r ? matchedBy(r, overview, addresses) : undefined}><Match value={r?.address ?? address} /></FlowItem></FlowStage>
    <FlowStage kind="process">{!r ? <FlowItem><span className="muted">—</span></FlowItem> : outcome!.rows.length ? outcome!.rows.map(row => <FlowItem key={row.key} hit={row.actions.length > 0} note={row.error ?? undefined}><RuleLine rule={overview.rules.find(x => x.key === row.key)} keyName={row.key} /></FlowItem>)
      : <FlowItem><span className="muted">{steps.process.empty}</span></FlowItem>}</FlowStage>
    <FlowStage kind="deliver">{!r ? <FlowItem><span className="muted">—</span></FlowItem> : <Delivered recipient={r} overview={overview} addresses={addresses} />}</FlowStage>
  </Flow>
}

/** Where a test's mail went, by name: inboxes, destinations, or stored or dropped. */
export function Delivered({ recipient: r, overview, addresses = [] }: { recipient: TraceRecipient; overview: Overview; addresses?: InboundAddress[] }) {
  const inboxes = new Map([...overview.routes.data.flatMap(e => e.address ? [e.address] : []), ...addresses].map(a => [a.id, a]))
  const ends = overview.endpoints
  if (r.dropped) return <FlowItem icon={<TargetIcon type="drop" />} hit>{outcomes.drop}</FlowItem>
  const items = [
    ...(r.inboxes ?? []).map(id => <FlowItem key={id} icon={<TargetIcon type="inbox" />} hit>{(box => !box ? 'An inbox' : box.displayName ? `${box.displayName} inbox` : <><PrivateAddress value={box.address} /> inbox</>)(inboxes.get(id))}</FlowItem>),
    ...(r.webhooks ?? []).map(id => { const e = ends.find(x => x.id === id); return <FlowItem key={id} icon={<TargetIcon type={e?.type ?? 'webhook'} />} hit>{e?.name ?? 'A destination'}</FlowItem> }),
  ]
  return <>{items.length ? items : <FlowItem icon={<TargetIcon type="store" />} hit>{outcomes.store}</FlowItem>}
    {!!r.labels?.length && <FlowItem><span className="muted">Labeled {r.labels.join(', ')}</span></FlowItem>}
    {r.junk && <FlowItem><span className="muted">Kept as junk</span></FlowItem>}</>
}

// ---------------------------------------------------------------- test: send a sample and see where it goes

export type Sample = { from: string; subject: string; text: string }
export const defaultSample: Sample = { from: 'dana@example.net', subject: 'Refund for order 4821', text: 'Hi, the blender arrived broken. Could I get a refund? Order 4821.' }
const mimeOf = (to: string, s: Sample) => ['From: ' + s.from, 'To: ' + to, 'Subject: ' + s.subject.replace(/[\r\n]+/g, ' '), 'Message-ID: <sample@example.net>', 'Content-Type: text/plain; charset=utf-8', '', s.text].join('\r\n')
/** The address a test sends to for a row: its own, or one its wildcard or catch-all would catch. */
export const testAddress = (match: string) => match.startsWith('*@') ? 'someone' + match.slice(1) : match.replace(/\*/g, 'test')

/** Runs the dry run (testRules) for one address with a sample email: nothing is sent or saved, and the AI isn't asked. */
export function useFlowTest() {
  const [state, setState] = useState<{ address: string; outcome: TestOutcome | null; error: string | null; pending: boolean } | null>(null)
  async function run(address: string, sample: Sample) {
    setState({ address, outcome: null, error: null, pending: true })
    try {
      const result = await request<DryRun>('/v1/rules/test', { method: 'POST', body: { mime: mimeOf(address, sample) } })
      setState({ address, outcome: outcomeOf(result, address), error: null, pending: false })
    } catch (error) { setState({ address, outcome: null, error: errorText(error), pending: false }) }
  }
  return { address: state?.address ?? null, outcome: state?.outcome ?? null, error: state?.error ?? null, pending: state?.pending ?? false, run, clear: () => setState(null) }
}
export type FlowTest = ReturnType<typeof useFlowTest>
/** The sample a test sends: a refund request unless changed. One line until opened. */
export function SampleFields({ sample, onChange, disabled }: { sample: Sample; onChange: (next: Sample) => void; disabled?: boolean }) {
  return <details className="flow-sample">
    <summary>Sample: <span className="flow-sample__subject">{sample.subject || '(no subject)'}</span></summary>
    <div className="stack flow-sample__fields">
      <Field label="From" htmlFor="flow-sample-from"><Input id="flow-sample-from" value={sample.from} disabled={disabled} onChange={e => onChange({ ...sample, from: e.target.value })} autoComplete="off" /></Field>
      <Field label="Subject" htmlFor="flow-sample-subject"><Input id="flow-sample-subject" value={sample.subject} disabled={disabled} onChange={e => onChange({ ...sample, subject: e.target.value })} autoComplete="off" /></Field>
      <Field label="Text" htmlFor="flow-sample-text"><Textarea id="flow-sample-text" rows={3} value={sample.text} disabled={disabled} onChange={e => onChange({ ...sample, text: e.target.value })} /></Field>
    </div>
  </details>
}
/** Test: the sample it sends, and what went wrong when it didn't run. The Test button sits with the panel's actions. */
export function TestBar({ address, test, sample, onSample }: { address: string; test: FlowTest; sample: Sample; onSample: (next: Sample) => void }) {
  const submit = (event: FormEvent) => { event.preventDefault(); void test.run(address, sample) }
  return <form className="flow-test" id="flow-test" onSubmit={submit}>
    <SampleFields sample={sample} onChange={next => { onSample(next); test.clear() }} disabled={test.pending} />
    {test.error && test.address === address && <Alert tone="danger">{test.error}</Alert>}
  </form>
}
