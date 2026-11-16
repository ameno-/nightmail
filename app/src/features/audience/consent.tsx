import { useId, useState } from 'react'

// The API's contact states, in the order a marketer meets them.
export const statusOptions = [{ value: 'subscribed', label: 'Subscribed' }, { value: 'unknown', label: 'Unknown' }, { value: 'unsubscribed', label: 'Unsubscribed' }, { value: 'suppressed', label: 'Suppressed' }]
// A contacts or list filter on Unknown with nobody in it.
export const noUnknown = 'No one with unknown consent'
export const evidenceRequired = 'Say how they agreed, e.g. “Signed up on our website”.'
const legend: Record<string, string> = { subscribed: 'can receive campaigns', unknown: 'no recorded consent; campaigns skip them', unsubscribed: 'opted out', suppressed: 'bounced, complained or blocked; gets no email at all' }
export const consentTitle = (status: string) => `${statusOptions.find(option => option.value === status)?.label ?? status}: ${legend[status] ?? ''}`
// What each state means for a campaign, under the filters of every table that shows one: one line that opens the four.
export function ConsentLegend() {
  const [open, setOpen] = useState(false), id = useId()
  return <div className="audience-legend" data-open={open || undefined}>
    <button type="button" className="audience-legend__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>What each state means</button>
    <p id={id} className="audience-legend__terms">{statusOptions.map(option => <span key={option.value}><span className="audience-legend__term">{option.label}</span> {legend[option.value]}</span>)}</p>
  </div>
}
