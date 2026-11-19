import { Field, Input } from './ui'
import { date } from '../lib/format'

// A send time, for a campaign or a single email: entered and stored in UTC; every place that shows one also gives the
// viewer's local time.
export const utcLabel = (value: string) => `${date(value, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}, ${date(value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC`
export const localLabel = (value: string) => `${new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))} your time`
export const parseUtc = (value: string) => value ? new Date(`${value}:00Z`) : null
/** What's wrong with a send time, or ''. Campaigns schedule up to a year ahead, single emails up to 30 days. */
export function scheduleError(value: string, days = 365) {
  const parsed = parseUtc(value)
  if (!parsed || Number.isNaN(parsed.getTime())) return 'Date and time: choose when to send.'
  if (parsed.getTime() <= Date.now()) return `Date and time: that time has passed. It is now ${utcLabel(new Date().toISOString())}.`
  if (parsed.getTime() > Date.now() + days * 86_400_000) return days === 365 ? 'Date and time: pick a time within a year.' : `Date and time: pick a time within ${days} days.`
  return ''
}
export function ScheduleField({ value, onChange, error, disabled, id }: { value: string; onChange: (value: string) => void; error?: string; disabled?: boolean; id: string }) {
  return <Field label="Date and time (UTC)" htmlFor={id} error={error}><Input id={id} type="datetime-local" value={value} aria-invalid={Boolean(error) || undefined} onChange={event => onChange(event.target.value)} disabled={disabled} /></Field>
}
