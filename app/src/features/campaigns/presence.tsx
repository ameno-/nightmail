import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Bot } from 'lucide-react'
import { Tooltip } from '../../components/ui'
import { useSession } from '../../data/context'
import { initials } from '../../data/accounts'
import { socketUrl } from '../../data/live'
import { usePhone } from '../../lib/media'
import './presence.css'

// Who else has this campaign open, from its room (api/src/campaign-room.ts): people with its Write or Review page open,
// and agents that read or saved it in the last two minutes. One socket per page, which the room answers only when
// someone joins or leaves; alone, it is a hibernated connection and a ping every 30 s the runtime answers for it.
type Person = { kind: 'person'; slot: number; id: string; name: string; view: 'write' | 'review' }
type Agent = { kind: 'agent'; id: string; name: string; at: number; ago?: number }
export type Present = { id: string; kind: 'person' | 'agent'; name: string; view?: Person['view']; color: number }
const AGENT_MS = 120_000, PING_MS = 30_000
// A tab that leaves and comes straight back (Write to Review) stays on screen instead of blinking out.
const LEAVE_MS = 1500
/** A person's colour, the same in every browser: one of the eight in presence.css. */
export const presenceColor = (id: string) => { let hash = 0; for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return hash % 8 }

export function useCampaignPresence(campaignId: string | null | undefined, view: Person['view']): Present[] {
  const identity = useSession()?.identity
  const enabled = Boolean(campaignId && identity?.presence)
  // By slot. A slot is reused once free, so a delayed leave removes only the person who left (the same object).
  const people = useRef(new Map<number, Person>()), [version, changed] = useReducer((n: number) => n + 1, 0)
  const [agents, setAgents] = useState<ReadonlyMap<string, Agent>>(new Map())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled || !campaignId) return
    let socket: WebSocket | null = null, stopped = false, failures = 0
    let retry: ReturnType<typeof setTimeout> | undefined, ping: ReturnType<typeof setInterval> | undefined
    const leaving = new Set<ReturnType<typeof setTimeout>>()
    const connect = () => {
      const ws = socket = new WebSocket(socketUrl(`/v1/campaigns/${encodeURIComponent(campaignId)}/room`, { view }))
      ws.onopen = () => { failures = 0; ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping') }, PING_MS) }
      ws.onmessage = ({ data }) => {
        if (typeof data !== 'string' || data === 'pong') return
        let message: { type?: string; peers?: (Person | Agent)[]; peer?: Person | Agent; slot?: number }
        try { message = JSON.parse(data) } catch { return }
        const { peer } = message
        if (message.type === 'hello') {
          people.current = new Map((message.peers ?? []).filter((item): item is Person => item.kind === 'person').map(item => [item.slot, item])); changed()
          setAgents(new Map((message.peers ?? []).filter((item): item is Agent => item.kind === 'agent').map(item => [item.id, { ...item, at: Date.now() - Math.max(0, item.ago ?? 0) }])))
        } else if (message.type === 'join' && peer?.kind === 'person') { people.current.set(peer.slot, peer); changed() }
        else if (message.type === 'agent' && peer?.kind === 'agent') { setAgents(map => new Map(map).set(peer.id, { ...peer, at: Date.now() })); setNow(Date.now()) }
        else if (message.type === 'leave' && typeof message.slot === 'number') {
          const slot = message.slot, gone = people.current.get(slot)
          const timer = setTimeout(() => { leaving.delete(timer); if (gone && people.current.get(slot) === gone) { people.current.delete(slot); changed() } }, LEAVE_MS)
          leaving.add(timer)
        }
      }
      ws.onclose = () => {
        clearInterval(ping)
        if (stopped) return
        people.current = new Map(); changed()
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** failures++))
      }
    }
    connect()
    return () => {
      stopped = true; clearTimeout(retry); clearInterval(ping); leaving.forEach(clearTimeout)
      socket?.close(1000)
      people.current = new Map(); changed(); setAgents(new Map())
    }
  }, [enabled, campaignId, view])
  // An agent drops out two minutes after its last read or save.
  useEffect(() => {
    const next = Math.min(...[...agents.values()].map(agent => agent.at + AGENT_MS))
    if (!Number.isFinite(next)) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [agents, now])
  const self = identity?.id
  // In the order they arrived, so a face that arrives goes at the end and none of the others moves.
  const arrival = useRef(new Map<string, number>()), next = useRef(0)
  return useMemo(() => {
    const byPerson = new Map<string, Present>()
    for (const person of people.current.values()) {
      if (person.id === self) continue
      const seen = byPerson.get(person.id)
      // One face per person, however many tabs; on Write if any of them is.
      if (!seen || person.view === 'write') byPerson.set(person.id, { id: person.id, kind: 'person', name: person.name, view: person.view, color: presenceColor(person.id) })
    }
    const present = [...agents.values()].filter(agent => now - agent.at < AGENT_MS).map(agent => ({ id: agent.id, kind: 'agent' as const, name: agent.name, color: 0 }))
    const all = [...byPerson.values(), ...present], here = new Set(all.map(item => item.kind + item.id))
    for (const key of arrival.current.keys()) if (!here.has(key)) arrival.current.delete(key)
    for (const key of here) if (!arrival.current.has(key)) arrival.current.set(key, next.current++)
    return all.sort((a, b) => arrival.current.get(a.kind + a.id)! - arrival.current.get(b.kind + b.id)!)
  }, [version, agents, now, self])
}

/** Faces of the people and agents also in this campaign: three at most on a computer, then a count. A phone's bar has room
 *  for one face, which counts everyone else in its corner. */
export function CampaignPresence({ present }: { present: Present[] }) {
  const phone = usePhone()
  if (!present.length) return null
  const describe = (item: Present) => item.kind === 'agent' ? `${item.name} · agent` : item.view === 'review' ? `${item.name} · on Review` : item.name
  const face = (item: Present, others = 0) => <Tooltip key={item.kind + item.id} content={others ? present.map(describe).join(', ') : describe(item)}>
    <span className="campaign-presence__face" data-kind={item.kind} data-color={item.color} aria-hidden="true">{item.kind === 'agent' ? <Bot size={14} strokeWidth={2.25} /> : initials(item.name)}{others > 0 && <span className="campaign-presence__count">+{others}</span>}</span>
  </Tooltip>
  const shown = present.slice(0, 3), rest = present.length - shown.length
  return <div className="campaign-presence" role="group" aria-label={`Also here: ${present.map(describe).join(', ')}`}>
    {phone ? face(present[0]!, present.length - 1) : <>
      {shown.map(item => face(item))}
      {rest > 0 && <Tooltip content={present.slice(shown.length).map(describe).join(', ')}><span className="campaign-presence__face campaign-presence__more" aria-hidden="true">+{rest}</span></Tooltip>}
    </>}
  </div>
}
