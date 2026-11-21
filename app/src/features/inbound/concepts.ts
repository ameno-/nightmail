// The words Receiving uses, in one place. One model on every screen, in this order: an address is where mail is
// received, a rule is where it is processed, a destination is where it is delivered. The API keeps its own names
// (routes, rules, endpoints, catchAll, store); only the dashboard's words are these. What each one means is said once,
// in the Docs guides (docs/guides.tsx and docs/receiving.md), not on the screens.

export const concepts = {
  addresses: { title: 'Addresses' },
  rules: { title: 'Rules', adminOnly: 'Owners and admins manage rules' },
  destinations: { title: 'Destinations' },
} as const

// Where each concept is explained in full: the guides in Docs.
export const guides = {
  receiving: '/docs/receiving',
  rules: '/docs/rules',
  endpoints: '/docs/endpoints',
  inboxes: '/docs/inboxes',
  mcp: '/docs/mcp',
  keys: '/docs/keys',
} as const

export type KindFilter = 'all' | 'address' | 'pattern' | 'catch_all' | 'inbox' | 'auto'
// Exact, not Addresses: the tab is Addresses, and counts every kind.
export const kinds: Record<KindFilter, { label: string; empty: string }> = {
  all: { label: 'All', empty: 'No addresses yet' },
  address: { label: 'Exact', empty: 'No addresses yet' },
  pattern: { label: 'Wildcards', empty: 'No wildcards yet' },
  catch_all: { label: 'Catch-alls', empty: 'No catch-alls yet' },
  inbox: { label: 'Agent inboxes', empty: 'No agent inboxes yet' },
  auto: { label: 'Auto-created', empty: 'No auto-created addresses yet' },
}

// What a row is, in a few words, under its address.
export const kindNote = {
  route: 'No inbox of its own',
  pattern: 'Wildcard',
  catch_all: 'Catch-all',
  inbox: 'Agent inbox',
  auto: 'Created by the catch-all',
} as const

export const outcomes = {
  store: 'Stored, no inbox',
  drop: 'Dropped',
  create_address: 'New address per recipient',
} as const

// The three steps every flow is drawn in, named as the tabs are: one name per step on every screen.
export const steps = {
  receive: { title: 'Address' },
  process: { title: 'Rules', empty: 'No rule' },
  deliver: { title: 'Destinations' },
} as const

export const catchAllSetting = {
  title: 'Catch-all',
  options: { store: 'Store it, no inbox', create_address: 'Create an address' },
} as const
