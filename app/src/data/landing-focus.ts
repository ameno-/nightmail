import { WORKSPACE_FOCUS, type WorkspaceFocus } from '../../../api/src/workspace-focus.js'

// Why a visitor came, from a landing link: a comparison page's Get started opens /overview?focus=<focus> (WORKSPACE_FOCUS;
// a public page's own ?focus= works too, as a sign-in from it returns to /overview with its query). Noted from whatever
// address it lands on, on boot and as the app moves (no request), and kept in this browser so it outlives the sign-in page,
// the account service, the callback and a stay on the waitlist, until onboarding saves it as the workspace's focus or the
// workspace turns out to need none. The address keeps ?focus= until then, so a sign-in started there returns with it.
const key = 'nightmail.landing-focus', LIFETIME_MS = 30 * 24 * 60 * 60_000
/** focus: what the link asked for; from: the comparison page it came from (its slug), if known. */
export type LandingFocus = { focus: WorkspaceFocus; from: string | null; at: number }
// Where storage is off, this page load's copy: the callback's return URL brings the query back to the dashboard.
let memory: LandingFocus | null = null
let noted: string | null = null, lastPath: string | null = null

const comparison = (path: string | null | undefined) => path ? /^\/compare\/([a-z0-9-]{1,32})\/?$/.exec(path)?.[1] ?? null : null
const valid = (value: unknown): value is LandingFocus => {
  const v = value as LandingFocus | null
  return !!v && (WORKSPACE_FOCUS as readonly unknown[]).includes(v.focus) && (v.from === null || comparison('/compare/' + v.from) === v.from)
    && typeof v.at === 'number' && Date.now() - v.at < LIFETIME_MS
}
function referrerPath() {
  try { const from = new URL(document.referrer); return from.origin === window.location.origin ? from.pathname : null } catch { return null }
}

/** Notes ?focus= from an address the app opened or moved to (unknown values are ignored), and which comparison page it
 *  came from: this one, the one the app was on before, or the one that linked here. Cheap to call on every render. */
export function noteLandingLocation(pathname: string, search: string) {
  if (pathname + search === noted) return
  const before = lastPath
  noted = pathname + search; lastPath = pathname
  const focus = new URLSearchParams(search).get('focus')
  if (focus === null || !(WORKSPACE_FOCUS as readonly string[]).includes(focus)) return
  const kept = readLandingFocus()
  keep(focus as WorkspaceFocus, comparison(pathname) ?? comparison(before) ?? (before === null ? comparison(referrerPath()) : null) ?? (kept?.focus === focus ? kept.from : null))
}
/** A comparison page's Get started (data/context.tsx startLogin): its focus and page, kept before the browser leaves for
 *  the account service. Its ?focus= rides only in the sign-in's return URL, which a sign-in that ends on the waitlist never
 *  opens, and which comes back from another site, so it can't say which page sent it. */
export function rememberLandingFocus(focus: WorkspaceFocus, pathname: string) { keep(focus, comparison(pathname)) }
function keep(focus: WorkspaceFocus, from: string | null) {
  memory = { focus, from, at: Date.now() }
  try { localStorage.setItem(key, JSON.stringify(memory)) } catch { /* This page load keeps it. */ }
}
export function readLandingFocus(): LandingFocus | null {
  try { const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null'); if (valid(stored)) return stored } catch { /* Storage is off. */ }
  return valid(memory) ? memory : null
}
/** Done with it (used, or nothing left for it to answer): forgotten, and gone from the address. */
export function clearLandingFocus() {
  memory = null
  try { localStorage.removeItem(key) } catch { /* Storage is off. */ }
  const url = new URL(window.location.href)
  if (!url.searchParams.has('focus') || url.pathname.startsWith('/compare/')) return
  url.searchParams.delete('focus')
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
}
