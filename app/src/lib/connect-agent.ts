import { useSyncExternalStore } from 'react'

// Opens Connect your agent from the shell (the sidebar's row, More on a phone or tablet, ⌘K), with one dialog the
// shell mounts once it is first opened. Kept outside the dialog's chunk so callers stay small.
let open = false
const listeners = new Set<() => void>()
const set = (next: boolean) => { open = next; listeners.forEach(listener => listener()) }
export const openConnectAgent = () => set(true)
export const closeConnectAgent = () => set(false)
export function useConnectAgentOpen() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => open)
}
