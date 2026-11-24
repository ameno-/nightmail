import { useState, type FormEvent } from 'react'
import { ChevronRight, MoreHorizontal } from 'lucide-react'
import { useApiMutation } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import type { LogEntry } from '../../data/types'
import { Button, ConfirmDialog, Dialog, DropdownMenu, IconButton, MutationError, useToast, type Column } from '../../components/ui'
import { parseUtc, ScheduleField, scheduleError, utcLabel } from '../../components/ScheduleField'

// A sent email scheduled for later (POST /v1/emails/send with scheduledAt) can be canceled or moved until it goes. The
// Logs page puts both in the row's menu: its last column, which shows the row's chevron otherwise (rows.tsx).
const SCHEDULE_DAYS = 30
export const isScheduled = (row: LogEntry) => row.direction === 'sent' && row.status === 'scheduled' && Boolean(row.scheduledAt)

export function useScheduledActions() {
  const [canceling, setCanceling] = useState<LogEntry | null>(null)
  const [moving, setMoving] = useState<LogEntry | null>(null)
  const cancel = useApiMutation((api, id: string) => api.emails.cancel(id), 'Email canceled', false, invalidate.scheduledEmail)
  const menu = (row: LogEntry) => <DropdownMenu label={`Actions for the email scheduled for ${utcLabel(row.scheduledAt!)}`} title={`Sends ${utcLabel(row.scheduledAt!)}`}
    trigger={<IconButton size="sm" label={`Actions for the email scheduled for ${utcLabel(row.scheduledAt!)}`}><MoreHorizontal size={14} /></IconButton>}
    items={[{ label: 'Reschedule', onSelect: () => setMoving(row) }, { label: 'Cancel email', destructive: true, onSelect: () => setCanceling(row) }]} />
  const columns = <T extends Column<LogEntry>>(all: T[]): T[] => all.map(column => column.key === 'open' ? { ...column,
    render: (row: LogEntry) => isScheduled(row) ? menu(row) : <ChevronRight size={14} aria-hidden />,
    cardRender: (row: LogEntry) => isScheduled(row) ? menu(row) : null } : column)
  const dialogs = <>
    <ConfirmDialog open={canceling !== null} onOpenChange={open => { if (!open) setCanceling(null) }} danger title="Cancel this email?"
      description={canceling ? `It was scheduled for ${utcLabel(canceling.scheduledAt!)} and won’t be sent. You can’t undo this.` : ''} confirmLabel="Cancel email"
      onConfirm={async () => { await cancel.mutateAsync(canceling!.id) }} />
    {moving && <RescheduleEmailDialog row={moving} onClose={() => setMoving(null)} />}
  </>
  return { columns, dialogs }
}

function RescheduleEmailDialog({ row, onClose }: { row: LogEntry; onClose: () => void }) {
  const toast = useToast()
  const move = useApiMutation((api, at: string) => api.emails.reschedule(row.id, at), undefined, false, invalidate.scheduledEmail, row.id)
  const [value, setValue] = useState(() => row.scheduledAt!.slice(0, 16))
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    const problem = scheduleError(value, SCHEDULE_DAYS)
    if (problem) { setError(problem); return }
    const at = parseUtc(value)!.toISOString()
    try { await move.mutateAsync(at); toast(`Rescheduled for ${utcLabel(at)}`, 'success'); onClose() } catch { /* Shown below. */ }
  }
  return <Dialog open onOpenChange={open => { if (!open && !move.isPending) onClose() }} title="Reschedule email">
    <form className="stack" onSubmit={submit} noValidate>
      <ScheduleField id="email-reschedule" value={value} onChange={next => { setValue(next); setError('') }} error={error} disabled={move.isPending} />
      <MutationError error={move.error} />
      <div className="cluster logs-dialog-actions"><Button type="button" disabled={move.isPending} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" loading={move.isPending}>Reschedule</Button></div>
    </form>
  </Dialog>
}
