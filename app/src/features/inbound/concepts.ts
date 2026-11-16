// The words Receiving uses, in one place. Names follow the API: routes, rituals, endpoints, catch-all (catchAll), store.
// What each one means is said once, in the Docs guides (docs/guides.tsx and docs/receiving.md), not on the screens.

export const concepts = {
  routes: { title: 'Routes' },
  rituals: { title: 'Rituals', adminOnly: 'Owners and admins manage rituals' },
  endpoints: { title: 'Endpoints' },
  trace: { title: 'Trace' },
} as const

// Where each concept is explained in full: the guides in Docs.
export const guides = {
  receiving: '/docs/receiving',
  rituals: '/docs/rituals',
  endpoints: '/docs/endpoints',
  inboxes: '/docs/inboxes',
  mcp: '/docs/mcp',
  keys: '/docs/keys',
} as const

export type KindFilter = 'all' | 'address' | 'pattern' | 'catch_all' | 'inbox' | 'auto'
export const kinds: Record<KindFilter, { label: string }> = {
  all: { label: 'All' },
  address: { label: 'Addresses' },
  pattern: { label: 'Patterns' },
  catch_all: { label: 'Catch-alls' },
  inbox: { label: 'Agent inboxes' },
  auto: { label: 'Auto-created' },
}

// What a row is, in a few words, under its address.
export const kindNote = {
  route: 'No inbox of its own',
  pattern: 'Pattern',
  catch_all: 'Catch-all',
  inbox: 'Agent inbox',
  auto: 'Created by the catch-all',
} as const

export const outcomes = {
  store: 'Stored, no inbox',
  drop: 'Dropped',
  create_address: 'New address per recipient',
} as const

// The three steps on an address's page.
export const steps = {
  route: { title: 'Route' },
  rituals: { title: 'Rituals', empty: 'No ritual yet' },
  goesTo: { title: 'Goes to' },
} as const

export const catchAllSetting = {
  title: 'Catch-all',
  line: 'What happens to mail for an address that doesn’t exist on this domain.',
  options: { store: 'Store it, no inbox', create_address: 'Create an address' },
} as const
