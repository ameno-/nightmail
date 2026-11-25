import type { ClientMessage, ServerMessage, SupportTransport, TransportEvent } from './protocol'
import type { SupportAction, SupportActionKind } from '../../data/support'
import { ApiError } from '../../data/types'
import { productName } from '../../../../api/src/brand'

// The demo transport: a scripted conversation over the same protocol messages as the support Worker, with no network.
// The panel opens with its own line; then a deliverability investigation (Outlook bounces after an import → advice → a consent card, which ends the
// answer as the protocol does → a content tip and a ticket offer); then the person drops a screenshot of the failing
// re-import, the agent reads it and files a bug report with it. Whatever the person types moves the script on; a message
// about a webhook instead finds a failed delivery and proposes retrying it (an action card, §4.4), and goes on once the
// person decides. The
// timings are the point: the panel is reviewed and screenshotted against them, so steps take a beat and text streams in
// uneven chunks. Uploads are simulated with progress.
//
// In demo mode, window.__baneSupportDemo can drop the connection (offline), fail the next turn or fail the next read of
// a proposed change, for the error states.

type Step =
  | { tool: string; running: string; done: string; ms: number; ok?: boolean }
  | { say: string }
  | { consent: string; allow: Step[]; deny: Step[] }
  | { ticket: string; category?: string }
  | { pause: number }
  | { action: SupportActionKind; template: string; labels: Record<string, string>; done: Step[]; declined: Step[] }

const investigate: Step[] = [
  { pause: 300 },
  { tool: 'bounce_reasons', running: 'Checking your Outlook bounces for the last 7 days…', done: 'Checked your Outlook bounces for the last 7 days', ms: 1200 },
  { tool: 'imports', running: 'Looking at Monday’s import…', done: 'Looked at Monday’s import: 2,140 contacts', ms: 900 },
  { tool: 'standing', running: 'Checking acme.com with Microsoft…', done: 'Checked acme.com with Microsoft', ms: 1000 },
  { say: `Found it. Since Monday, **186 of 212** hard bounces are Outlook and Hotmail addresses from that import, almost all \`550 5.5.0 mailbox unavailable\`. That usually means an old list.\n\n${productName} already suppressed them. Before your next send:\n\n1. Don’t re-import the bounced addresses.\n2. Send that import only to people who opened in the last 90 days.\n\nOutlook weighs content too, so I’d like to look at the email itself.` },
  { consent: 'To check November product update for what Outlook’s filters penalize, I need to read its HTML.',
    allow: [
      { tool: 'campaign_content', running: 'Reading November product update…', done: 'Read November product update', ms: 1100 },
      { say: `One content tip: **November product update** is one 1.2 MB image with 14 words of text, linked through a URL shortener. Outlook reads both as spam signals: add a few lines of real text and link straight to acme.com.\n\nIf Outlook still refuses after that, I can pass this to the ${productName} team to check acme.com with Microsoft. Want me to?` },
    ],
    deny: [{ say: `No problem. Without the content I can only go on the bounces, so start with the two steps above. If Outlook keeps refusing, I can pass this to the ${productName} team. Want me to?` }] },
]
// The person answers the offer with a screenshot of the failing re-import (the real Import contacts dialog).
const screenshot: Step[] = [
  { pause: 300 },
  { tool: 'read_image', running: 'Reading your screenshot…', done: 'Read your screenshot', ms: 1100 },
  { say: 'Thanks, that helps. Your screenshot shows **38 rows** skipped for “a different number of columns than the header”. Those rows end in an empty column, which spreadsheet exports often add, and the importer should ignore it. That’s a bug on our side, not your list.' },
  { tool: 'file_ticket', running: 'Filing a bug report…', done: 'Filed a bug report with your screenshot', ms: 1000 },
  { say: 'It has your screenshot and the bounce findings, so the team has both. Until it’s fixed, removing the trailing comma lets those rows import.' },
  { ticket: 'bug' },
]
const file: Step[] = [
  { pause: 300 },
  { tool: 'file_ticket', running: 'Filing a ticket with what we found…', done: 'Filed a ticket with what we found', ms: 1000 },
  { say: `Done. I’ve passed this to the ${productName} team with everything we found, so you won’t need to explain it again.` },
  { ticket: 'deliverability' },
]
const webhook = (workspace: string): Step[] => [
  { pause: 300 },
  { tool: 'webhook_deliveries', running: 'Checking your webhook deliveries…', done: 'Checked your webhook deliveries for the last 24 hours', ms: 1100 },
  { say: 'Your endpoint ending **/hooks/nightmail** answered `503` three times to the **email.bounced** delivery from 09:14, then the retries ran out. It has answered `200` to everything since 09:40, so it’s back up.\n\nI can retry that delivery now. It goes out once you confirm.' },
  { action: 'retry_webhook_delivery', template: 'Retry the email.bounced delivery from Nov 21, 09:14 UTC to your sending webhook {webhook} at {site}, in the workspace {workspace}. It failed after 3 attempts.',
    labels: { webhook: 'Bounce events', site: 'acme.com', workspace },
    done: [{ tool: 'webhook_delivery', running: 'Checking the retry…', done: 'Checked the retry', ms: 900 }, { say: 'Done. Your endpoint answered `200` this time, so that bounce has reached your system.' }],
    declined: [{ say: 'Okay, nothing was retried. If you want it later, ask me again.' }] },
]
const later: Step[] = [{ pause: 500 }, { say: 'I’ve added that to the ticket, so the team sees it when they pick it up. Anything else I can check while you wait?' }]

const random = (seed: number) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }

export function createDemoTransport({ firstName, workspace }: { firstName: string; workspace: { id: string; name: string } }): SupportTransport {
  const listeners = new Set<(event: TransportEvent) => void>()
  const emit = (event: TransportEvent) => { for (const listener of listeners) listener(event) }
  let seq = 0, conversation = 0, turn = 0, online = true, failNext = false, failRead = false, filed = false, cancelled = false
  let busy = false, queue: { text: string; attachments: number }[] = [], consent: { requestId: string; allow: Step[]; deny: Step[] } | null = null, proposed = false
  // The proposals, as Nightmail would keep them, with what the agent says once each is decided.
  const actions = new Map<string, { action: SupportAction; done: Step[]; declined: Step[] }>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const server = (message: Record<string, unknown>) => { if (online) emit({ type: 'server', message: { v: 1, seq: seq++, ...message } as ServerMessage }) }
  const wait = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve() }, ms); timers.add(timer) })
  const clear = () => { for (const timer of timers) clearTimeout(timer); timers.clear() }

  // Text arrives in uneven chunks, with a breath after sentences, as a model's tokens do.
  async function stream(messageId: string, text: string, id: number) {
    const next = random(text.length + 7)
    let sent = ''
    for (let i = 0; i < text.length;) {
      if (id !== conversation || cancelled) return sent
      const size = 2 + Math.floor(next() * 6)
      const chunk = text.slice(i, i + size)
      i += size; sent += chunk
      server({ type: 'text.delta', messageId, delta: chunk })
      await wait(/[.?!:]\s*$/.test(chunk) ? 120 + next() * 120 : 16 + next() * 22)
    }
    return sent
  }
  async function run(steps: Step[], messageId: string, id: number): Promise<string> {
    let text = ''
    for (const step of steps) {
      if (id !== conversation || cancelled) break
      if ('pause' in step) await wait(step.pause)
      else if ('tool' in step) {
        const toolCallId = `call_${seq}`
        server({ type: 'tool.start', messageId, toolCallId, tool: step.tool, label: step.running })
        await wait(step.ms)
        server({ type: 'tool.end', toolCallId, ok: step.ok ?? true, label: step.done })
        await wait(160)
      } else if ('say' in step) {
        const said = await stream(messageId, (text ? '\n\n' : '') + step.say, id)
        text += said
      } else if ('consent' in step) {
        // The answer ends by asking; the agent carries on in a new message once the person decides (§4.3).
        const requestId = `cns_${seq}`
        server({ type: 'consent.request', requestId, workspace, why: step.consent })
        consent = { requestId, allow: step.allow, deny: step.deny }
        break
      } else if ('action' in step) {
        // The answer ends by proposing; the agent carries on once the person decides (action.resolved).
        const actionId = `sac_demo${String(seq).padStart(4, '0')}`, at = new Date()
        const summary = step.template.replace(/\{([a-z]+)\}/g, (_, name: string) => JSON.stringify(step.labels[name] ?? ''))
        actions.set(actionId, { done: step.done, declined: step.declined, action: { id: actionId, kind: step.action, status: 'proposed', summary, parts: { template: step.template, labels: step.labels }, workspaceId: workspace.id,
          target: {}, url: `/support/actions/${actionId}`, result: null, error: null, delivery: null, createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + 86_400_000).toISOString(), resolvedAt: null } })
        proposed = true
        server({ type: 'action.request', actionId, kind: step.action, summary })
        break
      } else if ('ticket' in step) {
        filed = true
        server({ type: 'ticket.filed', ticketId: 'tkt_8F2KQ', ticketType: step.ticket, category: step.category ?? step.ticket, replyTo: `${firstName.slice(0, 1).toLowerCase()}…@acme.com`, expect: 'usually within one business day' })
      }
    }
    return text.trim()
  }
  async function answer(pick: () => Step[], kind: 'reply' | 'notice') {
    const id = conversation
    busy = true; cancelled = false
    server({ type: 'status', busy: true })
    if (kind === 'reply' && failNext) {
      failNext = false
      await wait(900)
      server({ type: 'error', code: 'TURN_FAILED', message: 'Couldn’t finish that answer.', retryable: true })
      server({ type: 'status', busy: false })
      busy = false
      return
    }
    const messageId = `msg_${seq}`
    server({ type: 'message.start', messageId, kind })
    const text = await run(pick(), messageId, id)
    if (id !== conversation) return
    server({ type: 'message.end', messageId, text, redacted: false })
    server({ type: 'status', busy: false })
    busy = false
    // Messages sent while a turn ran are answered in order, as the server does.
    if (queue.length) reply()
  }
  function reply() {
    if (busy) return
    const message = queue.shift()
    void answer(() => !proposed && /webhook/i.test(message?.text ?? '') ? webhook(workspace.name) : filed ? later : turn++ === 0 ? investigate : message?.attachments ? screenshot : file, 'reply')
  }
  async function start() {
    const id = ++conversation
    clear(); turn = 0; filed = false; busy = false; queue = []; consent = null; proposed = false; actions.clear()
    emit({ type: 'connection', state: 'connecting' })
    await wait(450)
    if (id !== conversation) return
    emit({ type: 'connection', state: 'open' })
    server({ type: 'hello', conversationId: `conv_demo${id}`, channel: 'chat', status: 'open', agent: { name: `${productName} Support`, ai: true }, customer: { firstName }, workspace, contentAccess: false, busy: false })
    server({ type: 'history', messages: [], pending: { consent: null, ticket: null } })
  }

  const transport: SupportTransport = {
    kind: 'demo',
    uploads: true,
    connect() { if (!seq) void start(); else if (!online) { online = true; emit({ type: 'connection', state: 'open' }) } },
    send(message: ClientMessage) {
      if (!online) return false
      if (message.type === 'user.message') { queue.push({ text: message.text, attachments: message.attachments?.length ?? 0 }); if (!busy) reply() }
      else if (message.type === 'consent.respond' && consent?.requestId === message.requestId) {
        const pending = consent
        consent = null
        server({ type: 'consent.resolved', requestId: message.requestId, decision: message.decision })
        void wait(350).then(() => answer(() => message.decision === 'allow' ? pending.allow : pending.deny, 'reply'))
      }
      else if (message.type === 'action.resolved') {
        const entry = actions.get(message.actionId)
        if (entry && entry.action.status !== 'proposed') void wait(350).then(() => answer(() => entry.action.status === 'declined' ? entry.declined : entry.done, 'reply'))
      }
      else if (message.type === 'cancel') cancelled = true
      else if (message.type === 'human.request' && !filed) void answer(() => file.slice(1), 'reply')
      else if (message.type === 'end') { clear(); conversation++; server({ type: 'closed', reason: 'ended' }); server({ type: 'status', busy: false }) }
      return true
    },
    async allowContent(requestId) { await wait(500); transport.send({ type: 'consent.respond', requestId, decision: 'allow' }) },
    async readAction(actionId) {
      await wait(120)
      if (failRead) { failRead = false; throw new ApiError('The service is unavailable. Try again shortly.', 'UNAVAILABLE', {}, undefined, 503) }
      const entry = actions.get(actionId)
      if (!entry) throw new ApiError('Support action was not found.', 'NOT_FOUND', {}, undefined, 404)
      return entry.action
    },
    async decideAction(actionId, decision) {
      const entry = actions.get(actionId)
      if (!entry) throw new ApiError('Support action was not found.', 'NOT_FOUND', {}, undefined, 404)
      await wait(decision === 'confirm' ? 800 : 300)
      if (entry.action.status === 'proposed') entry.action = { ...entry.action, status: decision === 'confirm' ? 'done' : 'declined', result: decision === 'confirm' ? { status: 'pending' } : null, resolvedAt: new Date().toISOString(),
        delivery: decision === 'confirm' ? { status: 'pending', attempts: 3, statusCode: 503 } : null }
      // The retry is queued first; the endpoint accepts it a moment later, and the card's next read says so.
      if (decision === 'confirm') { const timer = setTimeout(() => { timers.delete(timer); entry.action = { ...entry.action, delivery: { status: 'delivered', attempts: 4, statusCode: 200 } } }, 1800); timers.add(timer) }
      transport.send({ type: 'action.resolved', actionId })
      return entry.action
    },
    // Progress in uneven steps over about a second, as a small screenshot on a good connection.
    upload(_file, onProgress, signal) {
      return new Promise((resolve, reject) => {
        const steps = [.12, .34, .58, .79, .93, 1]
        let i = 0
        const abort = () => { clearTimeout(timer); reject(new DOMException('The upload was cancelled.', 'AbortError')) }
        let timer = setTimeout(function tick() {
          onProgress(steps[i])
          if (++i < steps.length) timer = setTimeout(tick, 120 + (i % 3) * 70)
          else { signal.removeEventListener('abort', abort); resolve({ id: `att_demo${seq}${i}` }) }
        }, 150)
        signal.addEventListener('abort', abort, { once: true })
      })
    },
    restart() { seq = 0; void start() },
    dispose() { clear(); conversation++; listeners.clear(); if (debug.transport === transport) delete (window as { __baneSupportDemo?: unknown }).__baneSupportDemo },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const debug = {
    transport,
    /** Drops the connection, as a lost network would. */
    offline() { online = false; emit({ type: 'connection', state: 'offline', retryAt: Date.now() + 8000 }) },
    online() { online = true; emit({ type: 'connection', state: 'open' }) },
    /** The next reply fails with TURN_FAILED. */
    failNextTurn() { failNext = true },
    /** The next read of a proposed change fails with a 503. */
    failNextRead() { failRead = true },
  };
  (window as { __baneSupportDemo?: typeof debug }).__baneSupportDemo = debug
  return transport
}
