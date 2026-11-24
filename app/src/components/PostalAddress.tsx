import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Dialog, Field, MutationError, Textarea, fieldError } from './ui'
import { useApiMutation } from '../data/context'
import { invalidate } from '../data/invalidation'
import { queries } from '../data/queries'
import type { WorkspaceSettings } from '../data/types'

// The API's rule (api/src/outbound-content.ts PostalAddress), checked as typed: plain text, 300 characters, 6 lines.
const LIMIT = { chars: 300, lines: 6 }
const lines = (value: string) => value.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean)
export function postalAddressError(value: string) {
  if (value.trim().length > LIMIT.chars) return `Use at most ${LIMIT.chars} characters.`
  if (lines(value).length > LIMIT.lines) return `Use at most ${LIMIT.lines} lines.`
  if (/[<>]/.test(value)) return 'Use plain text, without < or >.'
  return ''
}
/** One line, as a settings row shows it. */
export const postalAddressLine = (value: string) => lines(value).join(', ')

/**
 * Asks for the workspace's postal address and saves it (PATCH /v1/settings/workspace). Settings opens it to change the
 * address; a campaign's Send and Schedule open it when the address is missing, then carry on with `onSaved`.
 */
export function PostalAddressDialog({ open, onOpenChange, initial, title, submitLabel, required = false, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; initial: string | null; title: string; submitLabel: string; required?: boolean
  onSaved?: (settings: WorkspaceSettings) => void
}) {
  const [value, setValue] = useState(initial ?? '')
  const [problem, setProblem] = useState('')
  const client = useQueryClient()
  // Settings confirms the save; Send goes straight on to its own confirmation.
  const save = useApiMutation((api, postalAddress: string | null) => api.workspace.updateSettings({ postalAddress }), onSaved ? undefined : 'Saved', false, invalidate.postalAddress)
  async function submit(event: FormEvent) {
    event.preventDefault()
    const text = lines(value).join('\n'), invalid = text ? postalAddressError(value) : required ? 'Enter the postal address.' : ''
    if (invalid) { setProblem(invalid); return }
    try {
      const settings = await save.mutateAsync(text || null)
      client.setQueryData(['nightmail', ...queries.workspaceSettings().key], settings)
      onOpenChange(false)
      onSaved?.(settings)
    } catch { /* shown in the dialog */ }
  }
  const error = problem || fieldError(save.error, 'postalAddress')
  return <Dialog open={open} onOpenChange={next => { if (!save.isPending) onOpenChange(next) }} title={title} analytics="settings/postal-address"
    description="US law requires it in the footer of every marketing email."
    footer={<><Button disabled={save.isPending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={save.isPending} type="submit" form="postal-address">{submitLabel}</Button></>}>
    <form id="postal-address" className="stack" onSubmit={submit} noValidate>
      {!error && <MutationError error={save.error} />}
      <Field label="Postal address" htmlFor="postal-address-input" error={error}>
        <Textarea id="postal-address-input" rows={4} maxLength={LIMIT.chars + 40} autoComplete="street-address"
          value={value} onChange={event => { setValue(event.target.value); setProblem(''); if (save.error) save.reset() }} disabled={save.isPending} />
      </Field>
    </form>
  </Dialog>
}
