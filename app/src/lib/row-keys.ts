import { useEffect } from 'react'

// J and K (or ↓ and ↑) move through a list's rows and Enter opens the one highlighted, in every DataTable whose rows open
// something (rowHref or onRowClick; components/ui/primitives.tsx marks those data-row-keys). The highlight is focus
// itself, on the row's link (or on the row, where it opens a dialog), so Enter, Tab and screen readers follow it, and it
// wears the selected-row fill (ui.css). One list answers at a time: the one holding focus, else the last one pointed at or
// focused, else the first on screen. Nothing happens while typing, in a dialog or a menu, or with a modifier. ↓ and ↑
// keep scrolling the page until focus is in a list, unless the page has only the one list (Logs, Domains, API keys…).
// Each page remembers its last row for this visit, so after opening one and coming back, J picks up there. With privacy
// mode on, the highlight reveals none of the row's addresses: ⇧ held while it is highlighted does (PrivateAddress).
const kept = new Map<string, string>()
const place = () => location.pathname + location.search
let recent: HTMLElement | null = null, keyed = false

const typing = (target: Element) => Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
// Controls whose arrows (or letters) are their own.
const owned = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="menubar"], [role="listbox"], [role="tablist"], [role="radiogroup"], [role="slider"], [role="grid"], [role="tree"], [role="combobox"]'
const listOf = (node: Element | null) => node?.closest<HTMLElement>('[data-row-keys]') ?? null
const rowsOf = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('[data-row-key][data-clickable]')]
const shown = (list: HTMLElement) => list.getClientRects().length > 0 && !list.closest('[inert], [hidden], [aria-hidden="true"]')
const lists = () => [...document.querySelectorAll<HTMLElement>('[data-row-keys]')].filter(list => shown(list) && rowsOf(list).length > 0)
// What takes focus: a linked row's link (its first cell, or a card's title), else the row itself.
const targetOf = (row: HTMLElement) => row.querySelector<HTMLElement>('.ui-row-link') ?? row

function onKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) return
  const step = event.key === 'j' || event.key === 'ArrowDown' ? 1 : event.key === 'k' || event.key === 'ArrowUp' ? -1 : 0
  if (!step) return
  const target = event.target instanceof Element ? event.target : document.body
  if (typing(target) || target.closest(owned)) return
  if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"], [role="menu"]')) return
  const open = lists()
  const list = open.find(item => item.contains(target)) ?? (recent && open.includes(recent) ? recent : open[0])
  if (!list) return
  const arrow = event.key.startsWith('Arrow')
  if (arrow && !list.contains(target) && !(open.length === 1 && (target === document.body || target.closest('#main-content') === target))) return
  const rows = rowsOf(list), at = rows.findIndex(row => row.contains(document.activeElement))
  let next = at + step
  if (at < 0) { const key = kept.get(place()), found = key ? rows.findIndex(row => row.dataset.rowKey === key) : -1; next = found >= 0 ? found : 0 }
  event.preventDefault()
  next = Math.min(rows.length - 1, Math.max(0, next))
  if (next === at) return
  list.dataset.keyboard = ''; keyed = true
  targetOf(rows[next]).focus({ preventScroll: true, focusVisible: true } as FocusOptions)
  rows[next].scrollIntoView({ block: 'nearest' })
}
// The list in use, and the row last highlighted on this page.
function onFocus(event: FocusEvent) {
  const node = event.target instanceof Element ? event.target : null, list = listOf(node)
  if (!list) return
  recent = list
  const key = node?.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey
  if (key) kept.set(place(), key)
}
function onPointer(event: PointerEvent) {
  const list = listOf(event.target instanceof Element ? event.target : null)
  if (list) recent = list
}
// The pointer takes over from the keys: the highlight's moves stop being instant (hover keeps its own fade).
function onMove() {
  if (!keyed) return
  keyed = false
  for (const list of document.querySelectorAll<HTMLElement>('[data-row-keys][data-keyboard]')) delete list.dataset.keyboard
}

/** Installs the row keys for the shell's lifetime (AppShell). */
export function useRowKeys() {
  useEffect(() => {
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('pointermove', onMove)
    }
  }, [])
}
