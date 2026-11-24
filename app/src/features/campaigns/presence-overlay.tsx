import { useEffect, useRef } from 'react'
import { PRESENCE_COLORS, type Room } from './presence'
import './presence-overlay.css'

// The other people in the Write page, drawn over it: their pointer, the field they're in, and the block they're in with
// their text selection, each in their colour (api/src/campaign-room.ts carries the frames). Only while someone else is
// here: alone, nothing is sent and nothing runs. Pointers travel as at most 30 frames a second, sent only when they
// move, and are drawn 50 ms behind, between the last two, so they glide at the screen's own frame rate. A touch screen
// sends no pointer and shows none; fields and selections show everywhere.
const TICK_MS = 33, BEHIND_MS = 50, NONE = 0xffff, OFFSET = 32768, X_UNIT = 16384
const SHEET = '.campaign-compose-sheet', WORKSPACE = '.campaign-compose-workspace', EDITOR = '.composer-canvas [contenteditable="true"]', TOOLBAR = '.composer-toolbar'
const BLOCKS = 'p, h1, h2, h3, h4, li, pre, blockquote'
// The fields someone can be in, by number: the same list in every browser.
const FIELDS = ['campaign-name', 'campaign-from-email', 'campaign-reply-to', 'campaign-subject', 'campaign-preview']
const POINTER = '<svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true"><path d="M1.5 1.5 L1.5 15.5 L5.2 12.1 L7.8 18.1 L10.3 17 L7.8 11.2 L13 11.2 Z" fill="currentColor" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>'
// What is drawn for a slot, and whose it is: a slot is handed to whoever joins next, so marks go when its person changes.
type Remote = { id: string; samples: [number, number, number][]; selection: [number, number, number] | null; field: string | null; pointer: HTMLDivElement; marks: HTMLDivElement; drawn: string; bar: HTMLDivElement; drawnBar: string }

function frame(kind: number, ...words: number[]) {
  const bytes = new Uint8Array(1 + words.length * 2)
  bytes[0] = kind
  words.forEach((word, i) => { bytes[1 + i * 2] = word >> 8; bytes[2 + i * 2] = word & 255 })
  return bytes
}
const word = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!
const clampWord = (value: number) => Math.max(0, Math.min(NONE - 1, Math.round(value)))
const escape = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
function blockOf(root: Element, node: Node | null) {
  const element = node && (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest(BLOCKS)
  return element && root.contains(element) ? element : null
}
function offsetIn(block: Element, node: Node, offset: number) {
  if (node.nodeType !== Node.TEXT_NODE) { const range = document.createRange(); range.setStart(block, 0); range.setEnd(node, offset); return range.toString().length }
  const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let text: Node | null, total = 0
  while ((text = walk.nextNode())) { if (text === node) return total + offset; total += (text as Text).length }
  return total
}
function rangeIn(block: Element, from: number, to: number) {
  const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT), range = document.createRange()
  let text: Text | null, total = 0, started = false
  while ((text = walk.nextNode() as Text | null)) {
    if (!started && from <= total + text.length) { range.setStart(text, from - total); started = true }
    if (started && to <= total + text.length) { range.setEnd(text, to - total); return range }
    total += text.length
  }
  if (!started) { range.selectNodeContents(block); range.collapse(false) } else range.setEnd(block, block.childNodes.length)
  return range
}

export function PresenceOverlay({ room }: { room: Room }) {
  const layer = useRef<HTMLDivElement>(null)
  const live = useRef(room)
  live.current = room
  const others = room.people.size
  useEffect(() => {
    const host = layer.current
    if (!others || !host) return
    const touch = matchMedia('(pointer: coarse)').matches
    // The sheet's area, clipped so nothing is drawn over the bar, and the bar, for someone renaming the campaign.
    const clip = document.createElement('div'), free = document.createElement('div')
    clip.className = 'presence-layer__clip'; host.append(clip, free)
    let joins = live.current.joins
    const remotes = new Map<number, Remote>()
    let pointer: [number, number] | null = null, selection: [number, number, number] | null = null, field = NONE
    let sentPointer: string | null = null, sentSelection: string | null = null, sentField: number | null = null
    const sheet = () => document.querySelector<HTMLElement>(SHEET)
    const editor = () => document.querySelector<HTMLElement>(EDITOR)
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const box = sheet()?.getBoundingClientRect(), area = document.querySelector(WORKSPACE)?.getBoundingClientRect()
      if (!box?.width || !area) return
      const inside = event.clientX >= area.left && event.clientX <= area.right && event.clientY >= area.top && event.clientY <= area.bottom
      pointer = inside ? [(event.clientX - box.left) / box.width, event.clientY - box.top] : null
    }
    const away = () => { pointer = null }
    const selected = () => {
      const root = editor(), current = getSelection()
      const block = root && current?.rangeCount ? blockOf(root, current.anchorNode) : null
      if (!root || !block || !current?.anchorNode || !current.focusNode) { selection = null; return }
      const index = [...root.querySelectorAll(BLOCKS)].indexOf(block)
      const anchor = offsetIn(block, current.anchorNode, current.anchorOffset)
      const focus = blockOf(root, current.focusNode) === block ? offsetIn(block, current.focusNode, current.focusOffset) : (block.textContent ?? '').length
      selection = [index, Math.min(anchor, focus), Math.max(anchor, focus)]
    }
    const focused = () => { const id = (document.activeElement as HTMLElement | null)?.id ?? ''; field = FIELDS.includes(id) ? FIELDS.indexOf(id) : NONE }
    document.addEventListener('pointermove', move, { passive: true })
    document.documentElement.addEventListener('pointerleave', away)
    window.addEventListener('blur', away)
    document.addEventListener('selectionchange', selected)
    const blurred = () => setTimeout(focused, 0)
    document.addEventListener('focusin', focused); document.addEventListener('focusout', blurred)
    focused(); selected()
    // Changes only, at most once a tick. A pointer that stops sends nothing until it moves again.
    const tick = setInterval(() => {
      const room = live.current
      // Someone joined: they get where everyone already is.
      if (room.joins !== joins) { joins = room.joins; sentPointer = sentSelection = 'again'; sentField = null }
      const at = pointer && !touch ? `${clampWord(pointer[0] * X_UNIT + OFFSET)},${clampWord(pointer[1] + OFFSET)}` : null
      if (at !== sentPointer) { room.send(at ? frame(1, ...at.split(',').map(Number)) : frame(4)); sentPointer = at }
      const range = selection ? selection.join(',') : ''
      if (range !== sentSelection) { room.send(selection ? frame(2, ...selection.map(clampWord)) : frame(2, NONE, 0, 0)); sentSelection = range }
      if (field !== sentField) { room.send(frame(3, field)); sentField = field }
    }, TICK_MS)
    const forget = (slot: number, item: Remote) => { item.pointer.remove(); item.marks.remove(); item.bar.remove(); remotes.delete(slot) }
    const remote = (slot: number) => {
      const person = live.current.people.get(slot)
      let item = remotes.get(slot)
      if (item && item.id !== person?.id) { forget(slot, item); item = undefined }
      if (!item) {
        const color = PRESENCE_COLORS[person?.color ?? 0], name = escape(person?.name ?? '')
        const marks = document.createElement('div'), pointerEl = document.createElement('div')
        pointerEl.className = 'presence-pointer'; pointerEl.style.color = color
        pointerEl.innerHTML = `${POINTER}<span style="background:${color}">${name}</span>`
        const bar = document.createElement('div')
        clip.append(marks, pointerEl); free.append(bar)
        item = { id: person?.id ?? '', samples: [], selection: null, field: null, pointer: pointerEl, marks, drawn: '', bar, drawnBar: '' }
        remotes.set(slot, item)
      }
      return item
    }
    const stop = live.current.listen(bytes => {
      const slot = bytes[0]!, kind = bytes[1]
      if (!live.current.people.has(slot)) return
      const item = remote(slot), now = performance.now()
      if (kind === 1 && bytes.length >= 6) { item.samples.push([now, (word(bytes, 2) - OFFSET) / X_UNIT, word(bytes, 4) - OFFSET]); if (item.samples.length > 12) item.samples.shift() }
      else if (kind === 4) item.samples = []
      else if (kind === 2 && bytes.length >= 8) item.selection = word(bytes, 2) === NONE ? null : [word(bytes, 2), word(bytes, 4), word(bytes, 6)]
      else if (kind === 3 && bytes.length >= 4) item.field = FIELDS[word(bytes, 2)] ?? null
    })
    let frameId = 0, clipped = ''
    const draw = () => {
      frameId = requestAnimationFrame(draw)
      const area = document.querySelector(WORKSPACE)?.getBoundingClientRect(), box = sheet()?.getBoundingClientRect(), root = editor()
      if (!area || !box) return
      Object.assign(clip.style, { left: `${area.left}px`, top: `${area.top}px`, width: `${area.width}px`, height: `${area.height}px` })
      // Nothing of anyone else's covers this person's own formatting toolbar, which the message scrolls beneath: its
      // rectangle is cut out of the layer.
      const own = document.querySelector(TOOLBAR)?.getBoundingClientRect(), cut = own && own.bottom > area.top && own.top < area.bottom && own.width
        ? (() => { const [l, t, r, b] = [own.left - area.left, own.top - area.top, own.right - area.left, own.bottom - area.top].map(n => `${Math.round(n)}px`); return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${l} ${t}, ${r} ${t}, ${r} ${b}, ${l} ${b}, ${l} ${t})` })()
        : ''
      if (cut !== clipped) { clip.style.clipPath = cut; clipped = cut }
      const at = performance.now() - BEHIND_MS, blocks = root ? root.querySelectorAll(BLOCKS) : null
      for (const [slot, item] of remotes) {
        const person = live.current.people.get(slot)
        if (!person || person.id !== item.id) { forget(slot, item); continue }
        const samples = item.samples
        if (samples.length && !touch) {
          const next = samples.findIndex(sample => sample[0] > at)
          let [, x, y] = samples[next === -1 ? samples.length - 1 : Math.max(0, next)]!
          if (next > 0) { const [t0, x0, y0] = samples[next - 1]!, [t1, x1, y1] = samples[next]!, k = (at - t0) / (t1 - t0); x = x0 + (x1 - x0) * k; y = y0 + (y1 - y0) * k }
          item.pointer.style.opacity = '1'
          item.pointer.style.transform = `translate(${box.left - area.left + x * box.width}px, ${box.top - area.top + y}px)`
        } else item.pointer.style.opacity = '0'
        const color = PRESENCE_COLORS[person.color], name = escape(person.name), marks: string[] = [], barMarks: string[] = []
        const local = (rect: DOMRect, inBar = false) => ({ left: rect.left - (inBar ? 0 : area.left), top: rect.top - (inBar ? 0 : area.top), width: rect.width, height: rect.height })
        const block = item.selection && blocks ? blocks[item.selection[0]] : null
        if (block && item.selection) {
          const b = local(block.getBoundingClientRect())
          marks.push(`<div class="presence-block" style="left:${b.left - 6}px;top:${b.top - 3}px;width:${b.width + 12}px;height:${b.height + 6}px;box-shadow:0 0 0 1.5px ${color}"></div>`)
          const [, from, to] = item.selection, range = rangeIn(block, from, to)
          if (to > from) for (const rect of range.getClientRects()) { const r = local(rect); marks.push(`<div class="presence-selection" style="left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:${color}"></div>`) }
          const end = local(rangeIn(block, to, to).getBoundingClientRect())
          if (end.height) marks.push(`<div class="presence-caret" style="left:${end.left - 1}px;top:${end.top}px;height:${end.height}px;background:${color}"></div><div class="presence-tag" style="left:${end.left - 1}px;top:${end.top - 16}px;background:${color}">${name}</div>`)
        }
        const input = item.field ? document.getElementById(item.field) : null, f = input?.getBoundingClientRect()
        const inBar = Boolean(f && f.bottom <= area.top)
        if (f?.width) { const r = local(f, inBar); (inBar ? barMarks : marks).push(`<div class="presence-field" style="left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;box-shadow:0 0 0 2px ${color}"></div><div class="presence-tag presence-tag--field" style="left:${r.left + r.width}px;top:${r.top - 12}px;background:${color}">${name}</div>`) }
        const html = marks.join('')
        if (html !== item.drawn) { item.marks.innerHTML = html; item.drawn = html }
        const barHtml = barMarks.join('')
        if (barHtml !== item.drawnBar) { item.bar.innerHTML = barHtml; item.drawnBar = barHtml }
      }
    }
    frameId = requestAnimationFrame(draw)
    return () => {
      clearInterval(tick); cancelAnimationFrame(frameId); stop()
      document.removeEventListener('pointermove', move); document.documentElement.removeEventListener('pointerleave', away); window.removeEventListener('blur', away)
      document.removeEventListener('selectionchange', selected); document.removeEventListener('focusin', focused); document.removeEventListener('focusout', blurred)
      host.replaceChildren()
    }
  }, [others > 0])
  return <div ref={layer} className="presence-layer" aria-hidden="true" />
}
