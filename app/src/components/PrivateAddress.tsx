import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { PRIVATE_TITLE, maskedParts, nameParts } from '../lib/private-address'
import { reserveTextWidth } from '../lib/text-ruler'
import { useMasking, usePeek } from '../lib/privacy'

// Renders any address by the dashboard's one rule (lib/private-address.ts): a mailbox address is masked after its first
// two characters while privacy mode (lib/privacy.ts) is on; a domain or domain-only label renders as it is. With privacy
// mode off, the default, the visible address keeps the same reserved width.
//
// Revealing one is deliberate, so a shared screen never shows an address by accident: hold ⇧ and point at it (pointing
// alone, or moving across a list, reveals nothing); with a keyboard, focus the row or control that holds it; on a touch
// screen, tap an address that isn't part of a link. ⇧P turns privacy mode off and shows them all.
//
// Masked, the rest of the address is not in the page: the box holds the two characters and an empty, blurred run. The
// box is given the width of the whole address up front (measured without rendering it, lib/text-ruler.ts) and keeps it
// when the text arrives, so revealing never moves anything.

// What reveals a masked address besides ⇧ and the pointer on it: keyboard focus on a control or row that holds it.
// A row with a link (DataTable rowHref, or a card on a phone) is focused through that link.
const ROW = '.ui-table__linked, .ui-card', TABBABLE = 'a[href], button, [role="option"], [role="menuitem"], [tabindex]:not([tabindex="-1"]), .ui-table__clickable'
const focusHolds = (element: Element | null) => {
  const focused = document.activeElement
  // A dialog holds focus itself when it opens with nothing to type in: that reveals none of the addresses in it.
  if (!element || !focused || focused === document.body || focused === element || !focused.matches(':focus-visible') || focused.matches('[role=dialog], [role=alertdialog]')) return false
  return focused.contains(element) || focused.matches('.ui-row-link') && !!focused.closest(ROW)?.contains(element)
}
const focusListeners = new Set<() => void>()
// focusout runs before the next element has focus: look again once focus has landed (a task later, not a microtask, which
// still sees document.body focused). Un-revealing in between swaps the address's text while nothing has focus, and a Radix
// dialog's focus scope answers a DOM change with nothing focused by pulling focus back to the dialog: Tab would never leave.
const focusMoved = () => setTimeout(() => { for (const listener of focusListeners) listener() }, 0)
let listening = false
const subscribeFocus = (listener: () => void) => {
  if (!listening) { listening = true; document.addEventListener('focusin', focusMoved, true); document.addEventListener('focusout', focusMoved, true) }
  focusListeners.add(listener)
  return () => { focusListeners.delete(listener) }
}

/**
 * The state of one masked address: the props for its outer element and the ref for the box that holds its text.
 * `text` is everything the box shows once revealed. An address that no control or row can reveal for a keyboard or a
 * touch screen takes focus itself.
 */
export function useMasked(text: string) {
  const root = useRef<HTMLSpanElement>(null), box = useRef<HTMLSpanElement>(null)
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false), [alone, setAlone] = useState(false), [clipped, setClipped] = useState(false)
  const held = useSyncExternalStore(subscribeFocus, () => focusHolds(root.current))
  const blurred = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(blurred.current), [])
  const masking = useMasking()
  // Only the address under the pointer follows ⇧: the rest don't re-render when it is pressed.
  const peek = usePeek(on => on && hovered)
  const pointer = useRef('')
  const revealed = !masking || peek || focused || held
  useLayoutEffect(() => {
    const element = box.current
    if (element) return reserveTextWidth(element, text)
  }, [text])
  // Only a hovered or focused address needs a clipping tooltip. ResizeObserver
  // supplies its initial measurement after layout, as well as subsequent resizes.
  useLayoutEffect(() => {
    const element = box.current
    if (!revealed || !masking || !element) { setClipped(false); return }
    const check = () => setClipped(element.scrollWidth > element.clientWidth + 1)
    const observer = new ResizeObserver(check)
    observer.observe(element)
    return () => observer.disconnect()
  }, [revealed, masking, text])
  useEffect(() => {
    if (!hovered) return
    // Revealing replaces what is under the pointer, and some browsers then never report the pointer leaving.
    const check = () => { if (!root.current?.matches(':hover')) setHovered(false) }
    document.addEventListener('pointermove', check, true)
    return () => document.removeEventListener('pointermove', check, true)
  }, [hovered])
  useLayoutEffect(() => {
    if (!masking) return
    const parent = root.current?.parentElement
    setAlone(!parent?.closest(TABBABLE) && !parent?.closest(ROW)?.querySelector('.ui-row-link'))
  }, [masking])
  return {
    revealed, box: box as RefObject<HTMLSpanElement>,
    root: {
      ref: root as RefObject<HTMLSpanElement>, title: revealed ? clipped ? text : undefined : PRIVATE_TITLE, 'data-revealed': revealed || undefined, tabIndex: alone && masking ? 0 : undefined,
      // A mouse or pen reveals while ⇧ is held over it. A finger has no hover: it reveals an address that takes focus by
      // tapping it (not every browser moves focus on a tap, so the click does). A mouse click focuses it without revealing.
      onPointerEnter: (event: PointerEvent) => { if (event.pointerType !== 'touch') setHovered(true) },
      onPointerLeave: () => setHovered(false),
      onPointerDown: (event: PointerEvent) => { pointer.current = event.pointerType },
      onClick: alone && masking ? (event: MouseEvent<HTMLElement>) => { if (pointer.current === 'touch') event.currentTarget.focus() } : undefined,
      onFocus: (event: FocusEvent<HTMLElement>) => { if (event.target === event.currentTarget && (pointer.current === 'touch' || event.currentTarget.matches(':focus-visible'))) { clearTimeout(blurred.current); setFocused(true) } },
      onBlur: (event: FocusEvent) => { if (event.target === event.currentTarget) { clearTimeout(blurred.current); blurred.current = setTimeout(() => setFocused(false), 0) } },
    },
  }
}

export function PrivateAddress({ value, children, className }: { value: string; children?: ReactNode; className?: string }) {
  const parts = maskedParts(value)
  if (!parts) return <span className={className}>{value}{children}</span>
  return <Masked value={value} shown={parts.shown} className={className}>{children}</Masked>
}
function Masked({ value, shown, children, className }: { value: string; shown: string; children?: ReactNode; className?: string }) {
  const masked = useMasked(value)
  return <span {...masked.root} className={className ? `private-address ${className}` : 'private-address'}>
    <span ref={masked.box} className="private-address__value">{masked.revealed ? value : <>{shown}<span className="private-address__rest" aria-hidden="true" /></>}</span>
    {children}
  </span>
}
/** A sender-chosen display name (lib/private-address.ts nameParts): an address written inside it is masked like any other. */
export function NameText({ parts }: { parts: { text: string; address: boolean }[] }) {
  return <>{parts.map((part, i) => part.address ? <PrivateAddress key={i} value={part.text} /> : part.text)}</>
}
/** "Name <address>" with the address masked; the display name stays readable. A name that only repeats the address is left out. */
export function NamedAddress({ name, address }: { name?: string | null; address: string }) {
  const parts = nameParts(name, address)
  return parts ? <><NameText parts={parts} /> &lt;<PrivateAddress value={address} />&gt;</> : <PrivateAddress value={address} />
}
/**
 * A sender. On a detail page, the display name and then the address with its brackets, which wraps to its own line as
 * one piece. `nameOnly` (a list): the display name alone. Either way the masked address when there is no name, or the
 * name only repeats the address.
 */
export function Sender({ name, address, nameOnly = false }: { name?: string | null; address: string; nameOnly?: boolean }) {
  const parts = nameParts(name, address)
  if (!parts) return <PrivateAddress value={address} />
  if (nameOnly) return <NameText parts={parts} />
  return <span className="email-sender"><span><NameText parts={parts} /></span><span className="email-sender__address">&lt;<PrivateAddress value={address} />&gt;</span></span>
}
/** A list of addresses, each masked. */
export function AddressList({ values }: { values: string[] }) {
  return <>{values.map((value, i) => <span key={`${i}:${value}`}>{i > 0 && ', '}<PrivateAddress value={value} /></span>)}</>
}
