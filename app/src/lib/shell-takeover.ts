import { useEffect, useLayoutEffect, useRef } from 'react'

/** A page its own file paints before the app's code (app/painted-page.ts: the same page in a shell over #root, with its
 *  CSS) goes as the app's page is first drawn, in the same frame and at the same place, so nothing moves: the reader's
 *  scroll stays, their focus moves to the same control here, the rows they opened stay open, what they typed or slid is
 *  set here, and a button they pressed while the app loaded (home/shell/boot.js holds it) is pressed here.
 *  shell: the shell's id; page: the app's page under #root. Whether there was one. */
export function useShellTakeover(shellId: string, page: string) {
  const [painted] = useRef([typeof document !== 'undefined' && document.getElementById(shellId) !== null]).current
  const carried = useRef<{ typed: (string | null)[]; pressed: Place | null } | null>(null)
  useLayoutEffect(() => {
    const shell = document.getElementById(shellId)
    if (!shell) return
    const focused = placeOf(shell, document.activeElement), opened = [...shell.querySelectorAll('details')].map(row => row.open)
    const held = window as Window & { __nightmailShellPress?: Element }
    carried.current = { typed: [...shell.querySelectorAll('input')].map(input => input.value !== input.defaultValue ? input.value : null), pressed: placeOf(shell, held.__nightmailShellPress) }
    delete held.__nightmailShellPress
    shell.remove()
    document.querySelector('style[data-shell-css]')?.remove()
    // The rows the reader opened (a price page's questions, a legal page's contents) stay open, before the app's page is
    // first painted.
    document.querySelector(page)?.querySelectorAll('details').forEach((row, i) => { if (opened[i]) row.open = true })
    atPlace(document.querySelector(page), focused)?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    const was = carried.current, app = document.querySelector(page)
    if (!was || !app) return
    const inputs = [...app.querySelectorAll('input')], setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    was.typed.forEach((value, i) => { const input = inputs[i]; if (value !== null && input) { setValue.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) } })
    atPlace(app, was.pressed)?.click()
  }, [])
  return painted
}
// The controls a reader can see: a painted page may draw one in two forms and show the one for the theme (a legal page's
// theme switch, features/legal/prerender.tsx), where the app draws only that one.
const controls = (root: ParentNode | null) => [...root?.querySelectorAll<HTMLElement>('a[href], button, input') ?? []].filter(control => control.getClientRects().length > 0)
// A control's place, the same on the painted page and the app's: which of the controls with its class it is (Get started
// and the Open dashboard drawn in its place for someone signed in share theirs), or for one without a class, of those
// with its tag, address and words. Not its place among all controls: signed in, the app's page has no sign-in consent
// and its links, so every control after them would be another one, pressed or focused in the reader's place.
type Place = { key: string; nth: number }
const keyOf = (control: HTMLElement) => control.className ? `.${control.className}` : `${control.tagName}|${control.getAttribute('href') ?? ''}|${control.textContent?.trim() ?? ''}`
function placeOf(root: ParentNode | null, control: Element | null | undefined): Place | null {
  const all = controls(root), at = all.indexOf(control as HTMLElement)
  if (at < 0) return null
  const key = keyOf(all[at]!)
  return { key, nth: all.slice(0, at).filter(other => keyOf(other) === key).length }
}
const atPlace = (root: ParentNode | null, place: Place | null) => place ? controls(root).filter(control => keyOf(control) === place.key)[place.nth] : undefined
