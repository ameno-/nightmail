// What saving a webhook's form sends: only the fields the person changed since the webhook was last read, so a rename
// never writes back an event list or region scope another editor has saved since. No imports, so the acceptance suite
// runs the same code against the API.
export type WebhookFields = { name: string; url: string; regionIds?: string[] | 'all'; events: string[] }

// Event lists and regions are sets: the same choices in another order are no change.
const same = (a: unknown, b: unknown) => Array.isArray(a) && Array.isArray(b) ? a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n') : a === b

/** The fields of the form that differ from the webhook as read. The URL field starts empty: left empty, the URL stays. */
export function webhookEdits(form: WebhookFields, saved: WebhookFields): Partial<WebhookFields> {
  const edits: Partial<WebhookFields> = {}
  if (!same(form.name, saved.name)) edits.name = form.name
  if (form.url.trim()) edits.url = form.url
  if (!same(form.regionIds, saved.regionIds)) edits.regionIds = form.regionIds
  if (!same(form.events, saved.events)) edits.events = form.events
  return edits
}

/** PATCH /v1/webhooks/{id} for those edits (and headers, when they changed). */
export function webhookPatchBody(edits: Partial<WebhookFields>, headers?: unknown[]): Record<string, unknown> {
  return {
    ...edits.name !== undefined && { description: edits.name.trim() },
    ...edits.url?.trim() && { url: edits.url.trim() },
    ...edits.regionIds !== undefined && { regions: edits.regionIds === 'all' ? null : edits.regionIds },
    ...edits.events !== undefined && { eventTypes: edits.events },
    ...headers !== undefined && { headers },
  }
}
