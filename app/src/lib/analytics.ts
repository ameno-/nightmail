// Dashboard usage analytics (docs/analytics.md): what people open, click and run into, for finding friction. Nothing is
// stored on the device: the session ID lives in this page's memory, and a signed-in page names its account and workspace
// (the IDs, never an address). Every value is scrubbed here and again by the API (api/src/analytics-events.ts). The
// tracker only reads the DOM (tags, attributes, short text); it never writes to it, so it can't move anything.
import { ANALYTICS_LIMITS, ANALYTICS_PATH, VALIDITY_REASONS, analyticsName, fieldName, operationTemplate, routeTemplate, scrubLabel, viewportClass, type AnalyticsEventType, type FunnelStep } from '../../../api/src/analytics-events.js'

const FLUSH_MS = 5_000, MAX_QUEUE = 200, REPEAT_MS = 30_000, BATCH_BYTES = 30 * 1024

export type AnalyticsEvent = { name?: string | null; role?: string | null; label?: string | null; field?: string | null; reason?: string | null; code?: string | null; op?: string | null; status?: number | null; ms?: number | null; step?: FunnelStep | null; ref?: string | null }
/** What the tracker reads of an element: its tag, attributes, parent and text. Never a form field's value. */
export type ElementLike = { tagName: string; parentElement: ElementLike | null; textContent: string | null; getAttribute(name: string): string | null }
type Listener = (event: any) => void
export type TrackerHost = {
  document: { addEventListener(type: string, listener: Listener, options?: boolean | AddEventListenerOptions): void; removeEventListener(type: string, listener: Listener, options?: boolean | EventListenerOptions): void; readonly visibilityState: string }
  /** Posts one immutable batch without blocking the page. */
  send(body: string): void
  now(): number
  width(): number
  id(): string
  sid?: string
  attribution?: () => { r: string | null; u: (string | null)[] }
  /** Do Not Track or Global Privacy Control. */
  optedOut(): boolean
  every(ms: number, run: () => void): () => void
}
type Context = { enabled: boolean; ws?: string | null; uid?: string | null; app?: string | null }
type Queued = Record<string, unknown> & { id: string; seq: number; t: number; type: AnalyticsEventType; route: string }

const INTERACTIVE = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'radio', 'switch', 'combobox', 'slider', 'textbox', 'searchbox', 'treeitem'])
// Roles whose own text is a control's label (button copy). Links, options and pickers show data (a domain, a list, a
// contact), so they are named by their attributes or their destination instead.
const TEXT = new Set(['button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch', 'label'])
const tag = (el: ElementLike) => el.tagName.toLowerCase()
function roleOf(el: ElementLike) {
  const role = el.getAttribute('role')
  if (role && /^[a-z]{1,16}$/.test(role)) return role
  switch (tag(el)) {
    case 'a': return 'link'
    case 'button': case 'summary': return 'button'
    case 'select': return 'combobox'
    case 'textarea': return 'textbox'
    case 'label': return 'label'
    case 'input': { const type = el.getAttribute('type'); return type === 'checkbox' || type === 'radio' ? type : ['button', 'submit', 'reset'].includes(type ?? '') ? 'button' : type === 'range' ? 'slider' : 'textbox' }
    default: return 'element'
  }
}
const interactive = (el: ElementLike) => {
  const name = tag(el), role = el.getAttribute('role')
  return (name === 'a' && el.getAttribute('href') !== null) || ['button', 'input', 'select', 'textarea', 'summary', 'label'].includes(name) || (role !== null && INTERACTIVE.has(role)) || el.getAttribute('data-analytics') !== null
}
function closest(el: ElementLike | null, test: (el: ElementLike) => boolean) {
  for (let node = el, depth = 0; node && depth < 25; node = node.parentElement, depth++) if (test(node)) return node
  return null
}
// Where text is data, not interface: table cells and rows, phone cards, masked addresses, editors, code, and anything
// marked data-private (the account switcher). An element there is named by data-analytics and its role alone.
const privateZone = (el: ElementLike) => !!closest(el, node => {
  const name = tag(node), role = node.getAttribute('role'), editable = node.getAttribute('contenteditable')
  return ['td', 'tbody', 'textarea', 'pre', 'code', 'iframe'].includes(name) || role === 'cell' || role === 'gridcell' || role === 'row' || role === 'listbox' || role === 'textbox'
    || node.getAttribute('data-private') !== null || (editable !== null && editable !== 'false') || /(?:^|\s)(?:private-address|ui-card|cm-editor)(?:\s|$)/.test(node.getAttribute('class') ?? '')
})
function labelOf(el: ElementLike, role: string) {
  if (privateZone(el)) return null
  const aria = el.getAttribute('aria-label')
  if (aria) return aria
  if (role === 'link') { const href = el.getAttribute('href'); return href?.startsWith('/') ? routeTemplate(href) : null }
  if (TEXT.has(role)) return (el.textContent ?? '').slice(0, 200)
  if (role === 'textbox' || role === 'searchbox') return el.getAttribute('placeholder')
  return el.getAttribute('title')
}
const nameOf = (el: ElementLike | null) => el ? analyticsName(el.getAttribute('data-analytics')) : null

export type Tracker = ReturnType<typeof createTracker>
export function createTracker(host: TrackerHost) {
  const sid = host.sid ?? host.id()
  let context: Context = { enabled: false }, on = false, decided = false, seq = 0, stop: (() => void) | null = null
  let publicView = false
  let queue: Queued[] = [], route = '', visible = 0, since = host.now()
  // Before the page knows whether analytics are on (the API answers /v1/me or /health), events wait here.
  let early: Queued[] = []
  const repeats = new Map<string, number>(), seen = new Set<string>()
  const push = (type: AnalyticsEventType, event: AnalyticsEvent = {}) => {
    if (!on && decided) return
    const name = analyticsName(event.name)
    const item: Queued = { id: host.id(), seq: seq++, t: host.now(), type, route: route || '/', ...event,
      name, label: name ? null : scrubLabel(event.label), ref: routeTemplate(event.ref), op: operationTemplate(event.op), field: fieldName(event.field) }
    for (const key of Object.keys(item)) if (item[key] === null || item[key] === undefined) delete item[key]
    const target = on ? queue : early
    target.push(item)
    if (target.length > MAX_QUEUE) target.splice(0, target.length - MAX_QUEUE)
  }
  function flush() {
    if (!on) return
    while (queue.length) {
      const envelope = { v: 1, sid, ...host.attribution?.(), ws: context.ws ?? null, uid: context.uid ?? null, app: context.app ?? null, vp: viewportClass(host.width()) }
      let count = Math.min(queue.length, ANALYTICS_LIMITS.events), body = JSON.stringify({ ...envelope, events: queue.slice(0, count) })
      while (count > 1 && body.length > BATCH_BYTES) { count = Math.ceil(count / 2); body = JSON.stringify({ ...envelope, events: queue.slice(0, count) }) }
      queue = queue.slice(count)
      try { host.send(body) } catch { /* Analytics never blocks the page. */ }
    }
  }
  const visibleMs = () => visible + (host.document.visibilityState === 'visible' ? host.now() - since : 0)
  const onClick: Listener = event => {
    if (publicView) return
    const element = event.target as ElementLike | null
    if (!element || typeof element.getAttribute !== 'function') return
    const control = closest(element, interactive)
    if (!control) { push('click', { role: 'none' }); return }
    const role = roleOf(control)
    push('click', { name: nameOf(control), role, label: labelOf(control, role) })
  }
  const onSubmit: Listener = event => {
    const form = event.target as ElementLike | null, submitter = event.submitter as ElementLike | null | undefined
    if (!form || typeof form.getAttribute !== 'function') return
    push('form_submit', { name: nameOf(form), role: 'form', label: privateZone(form) ? null : form.getAttribute('aria-label') ?? (submitter ? labelOf(submitter, roleOf(submitter)) : null) })
  }
  // The browser's own validation: which field and which rule, never what was typed.
  const onInvalid: Listener = event => {
    const field = event.target as (ElementLike & { validity?: Partial<Record<string, boolean>> }) | null
    if (!field || typeof field.getAttribute !== 'function') return
    push('form_invalid', { name: nameOf(closest(field, node => tag(node) === 'form')), role: 'field', field: field.getAttribute('name') ?? field.getAttribute('id') ?? field.getAttribute('type'), reason: VALIDITY_REASONS.find(key => field.validity?.[key]) ?? null })
  }
  const onVisibility: Listener = () => {
    if (host.document.visibilityState === 'visible') { since = host.now(); return }
    visible += host.now() - since
    push('page_hide', { ms: visible })
    flush()
  }
  return {
    /** This page's session, for the sign-in return URL while analytics are on (ANALYTICS_SESSION_PARAM). */
    signInSession: () => on ? sid : null,
    /** Whether analytics are on, and the signed-in account and workspace. Signed out, ws and uid are null. */
    configure(next: Context) {
      const enabled = next.enabled && !host.optedOut()
      if (on && (next.ws !== context.ws || next.uid !== context.uid)) flush()
      context = { ...next, enabled }
      decided = true
      if (enabled && !on) {
        on = true
        queue = early; early = []
        host.document.addEventListener('click', onClick, { capture: true, passive: true })
        host.document.addEventListener('submit', onSubmit, true)
        host.document.addEventListener('invalid', onInvalid, true)
        host.document.addEventListener('visibilitychange', onVisibility)
        stop = host.every(FLUSH_MS, flush)
      } else if (!enabled) {
        if (on) { host.document.removeEventListener('click', onClick, { capture: true }); host.document.removeEventListener('submit', onSubmit, true); host.document.removeEventListener('invalid', onInvalid, true); host.document.removeEventListener('visibilitychange', onVisibility); stop?.() }
        on = false; queue = []; early = []
      }
    },
    /** A route change, as its template (/domains/:id). The previous route's visible time goes with it. */
    route(template: string, collectedByPublicHook = false) {
      publicView = collectedByPublicHook
      const next = routeTemplate(template) ?? '/'
      const ms = route ? visibleMs() : null, ref = route || null
      route = next; visible = 0; since = host.now()
      if (!publicView) push('page_view', { ref, ms })
    },
    dialog(open: boolean, title: unknown, name?: string, ms?: number) { push(open ? 'dialog_open' : 'dialog_close', { name, role: 'dialog', label: typeof title === 'string' ? title : null, ms }) },
    /** A field showing a validation error the dashboard wrote (components/ui Field). */
    fieldError(label: unknown, field?: string) { push('form_invalid', { role: 'field', label: typeof label === 'string' ? label : null, field, reason: 'customError' }) },
    /** A failed API request. The same error from the same request is reported once every 30 seconds. */
    apiError(method: string, path: string, status: number | undefined, code: string, field?: string) {
      // /v1/me answering 401 is how a signed-out page learns it is signed out, not an error anyone sees.
      if (status === 401 && path.split('?', 1)[0] === '/v1/me') return
      const op = operationTemplate(method.toUpperCase() + ' ' + path), key = code + ' ' + op, now = host.now()
      if ((repeats.get(key) ?? -Infinity) > now - REPEAT_MS) return
      repeats.set(key, now)
      push('api_error', { code, op, status: status && status >= 100 && status <= 599 ? status : null, field })
    },
    /** Funnel steps the API's answers prove (track() for the ones only the dashboard sees). */
    apiResult(method: string, path: string, data: unknown) {
      const p = path.split(/[?#]/, 1)[0]!, body = (data ?? {}) as Record<string, any>, ws = context.ws ?? ''
      // Observed states repeat on every read: report each once per page and workspace; the first one over time counts.
      const once = (step: FunnelStep) => { if (!seen.has(ws + step)) { seen.add(ws + step); push('track', { step }) } }
      if (method === 'POST') {
        if (p === '/v1/domains') push('track', { step: 'domain_added' })
        else if (p === '/v1/api-keys') push('track', { step: 'key_created' })
        else if (p === '/v1/inboxes') push('track', { step: 'inbox_created' })
        else if (/^\/v1\/campaigns\/[^/]+\/(?:send|schedule)$/.test(p)) push('track', { step: 'campaign_sent' })
        else if (/^\/v1\/domains\/[^/]+\/verify$/.test(p) && body.ready === true) once('domain_verified')
      } else if (method === 'GET') {
        if (p === '/v1/me' && body.multiTenant === true && body.connection === null) once('signed_up')
        else if (p === '/v1/me' && body.connection?.kind === 'byo' && body.connection?.state === 'ready') once('byo_connected')
        else if (p === '/v1/overview/setup' && body.emails?.any === true) once('first_send')
        else if (/^\/v1\/domains\/[^/]+$/.test(p) && body.ready === true) once('domain_verified')
      }
    },
    track(step: FunnelStep) { push('track', { step }) },
    flush,
  }
}

// The page's one tracker, made on first use so this module loads anywhere (the acceptance suite imports createTracker).
let shared: Tracker | undefined
export function analytics(): Tracker {
  return shared ??= createTracker({
    document, sid: (window as Window & { nmSid?: string }).nmSid,
    attribution: () => {
      const host = document.referrer ? new URL(document.referrer).hostname : '', query = new URLSearchParams(location.search)
      return { r: /^[\w.-]+\.[a-z]+$/i.test(host) ? host : null, u: ['source','medium','campaign'].map(key => {
        const value = query.get('utm_'+key); return value && /^[\w-]{1,48}$/.test(value) ? value : null
      }) }
    },
    send: body => {
      void fetch(ANALYTICS_PATH, { method: 'POST', mode: 'same-origin', keepalive: true, body }).then(response => {
        const retry = response.status === 503 && response.headers.get('NM-R')
        if (retry) setTimeout(() => navigator.sendBeacon(ANALYTICS_PATH + retry, body), 500 * Math.random())
      }).catch(() => { /* No receipt: don't replay an unknown outcome. */ })
    },
    now: () => Date.now(), width: () => window.innerWidth, id: () => crypto.randomUUID().replaceAll('-', ''),
    optedOut: () => navigator.doNotTrack === '1' || (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true,
    every: (ms, run) => { const timer = window.setInterval(run, ms); return () => window.clearInterval(timer) },
  })
}
