import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { onSoundChange, play, setSoundOn, soundOn, type Sound } from './sound'

// The comparison pages' small surprises (board.tsx, features.tsx), and the switch for their sounds. Every one is
// decorative: hidden from assistive technology, out of the tab order (the typed word is the keyboard's way in), never
// in the way of the board, the fader or a button, and never moving the layout: each is a transform, an opacity or a
// colour on something already in its place. With reduced motion nothing swings, flips or falls: what changes state
// still does (a bolt's slot, the lamp's light), at once. The list for whoever wants to find them is in the plan's
// easter-eggs.md.

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** A value that flips between 'a' and 'b' each time it is replayed: an animation keyed to it starts over. */
export function useReplay() {
  const [key, setKey] = useState<'a' | 'b' | undefined>(undefined)
  return [key, () => setKey(now => now === 'a' ? 'b' : 'a')] as const
}

/** A bolt, a quarter turn a click, with its sound. `at`: which corner of what it holds (board.css places it). */
export function Bolt({ at, onTurn }: { at: 'tl' | 'tr' | 'bl' | 'br'; onTurn?: () => void }) {
  const [turns, setTurns] = useState(0)
  return <i className="cb-bolt" data-at={at} style={{ '--turn': `${turns * 90}deg` } as CSSProperties}
    onClick={event => { event.stopPropagation(); setTurns(n => n + 1); play('bolt'); onTurn?.() }}><i /></i>
}
/** Four bolts, one at each corner. */
export const Bolts = ({ onTurn }: { onTurn?: (corner: number) => void }) =>
  <span className="cb-bolts" aria-hidden="true">{(['tl', 'tr', 'bl', 'br'] as const).map((at, k) => <Bolt key={at} at={at} onTurn={() => onTurn?.(k)} />)}</span>

/** A typed word, anywhere but in a field: `word` calls back. */
export function useTypedWord(word: string, then: () => void) {
  const latest = useRef(then)
  latest.current = then
  useEffect(() => {
    let typed = ''
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest('input, textarea, select, [contenteditable]')) return
      if (event.key.length !== 1) return
      typed = (typed + event.key.toLowerCase()).slice(-word.length)
      if (typed === word) { typed = ''; latest.current() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [word])
}

/** Play a sound on a press of the page's keys (a pointer or Enter and Space), once a press. */
export function keySound(event: { type: string; key?: string; target: EventTarget | null }, sound: Sound = 'key') {
  const key = (event.target as HTMLElement | null)?.closest('.cb-key')
  if (!key || (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ')) return
  play(sound)
}

/** The switch for the page's sounds: a speaker in the scene's top corner, remembered between visits. */
export function SoundSwitch() {
  const [on, setOn] = useState(soundOn)
  useEffect(() => onSoundChange(setOn), [])
  return <button type="button" className="cb-sound" aria-pressed={on} aria-label="Sound effects" title={on ? 'Sound on' : 'Sound off'}
    onClick={() => { setSoundOn(!on); if (!on) window.setTimeout(() => play('tick'), 0) }}>
    {on ? <Volume2 size={18} strokeWidth={1.8} aria-hidden="true" /> : <VolumeX size={18} strokeWidth={1.8} aria-hidden="true" />}<span aria-hidden="true">Sound</span>
  </button>
}
