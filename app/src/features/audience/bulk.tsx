import { useEffect, useRef, useState } from 'react'
import { useApiMutation, useApiQuery } from '../../data/context'
import { Button, Checkbox, Dialog, Field, Input, LoadingRegion, SkeletonText, Alert, useToast, MutationError } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { aqlString, evidenceRequired, number } from './shared'

// "Mark as subscribed…" for contacts with no consent decision (Unknown), on one list or in the whole audience. AudienceQL
// plans the change first (count, sample, warnings); the person attests consent and says how it was given; apply then
// changes exactly the planned contacts and stores that evidence on each consent record. Opt-outs and suppressions stay.
const BATCH_LIMIT = 10_000
export function BulkSubscribeDialog({ listId, listName, unknownCount, searchIgnored = false, onClose }: { listId?: string; listName?: string; unknownCount?: number; searchIgnored?: boolean; onClose: () => void }) {
  const toast = useToast()
  const list = useApiQuery(['lists', listId ?? ''], (api, signal) => api.lists.get(listId!, signal), { enabled: Boolean(listId) && !listName })
  const name = listName ?? list.data?.name
  const statement = `UPDATE contacts SET consent = 'subscribed' WHERE consent = 'unknown' AND suppressed = FALSE${listId ? ` AND list = ${aqlString(listId)}` : ''} LIMIT ${BATCH_LIMIT}`
  const plan = useApiMutation((api, value: string) => api.audienceQuery.plan(value), undefined, false, false)
  const apply = useApiMutation((api, input: { planId: string; evidence: string; confirmResubscribe: boolean }) => api.audienceQuery.apply(input))
  const [evidence, setEvidence] = useState(''), [attested, setAttested] = useState(false), [resubscribe, setResubscribe] = useState(false), [checked, setChecked] = useState(false)
  // `mutate` is a new function each render, so the effect waits on the statement alone: depending on it re-counted forever.
  const count = useRef(plan.mutate)
  count.current = plan.mutate
  useEffect(() => { count.current(statement) }, [statement])
  const ready = plan.data && plan.data.matched > 0
  const missingEvidence = checked && !evidence.trim(), missingAttestation = checked && !attested, missingResubscribe = checked && Boolean(plan.data?.requiresResubscribeConfirmation) && !resubscribe
  function recount() { apply.reset(); setChecked(false); count.current(statement) }
  async function submit() {
    setChecked(true)
    if (!plan.data || !evidence.trim() || !attested || (plan.data.requiresResubscribeConfirmation && !resubscribe)) return
    try {
      const result = await apply.mutateAsync({ planId: plan.data.id, evidence: evidence.trim(), confirmResubscribe: resubscribe })
      toast(`${number(result.affected)} contact${result.affected === 1 ? '' : 's'} marked subscribed`, 'success'); onClose()
    } catch { /* Shown in the dialog. */ }
  }
  const matched = plan.data?.matched ?? 0, batched = matched >= BATCH_LIMIT || (unknownCount ?? 0) > BATCH_LIMIT, people = `${number(matched)} ${matched === 1 ? 'person' : 'people'}`
  const busy = plan.isPending || apply.isPending
  // The count line says the whole scope: the contacts with unknown consent on the list or in the audience ("All" when a
  // search narrowed the table behind the dialog, which doesn't apply here). Opt-outs and suppressions aren't in it.
  const scope = listId ? <> on <strong>{name ?? 'this list'}</strong></> : ' in your audience'
  return <Dialog open onOpenChange={open => { if (!open && !apply.isPending) onClose() }} title="Mark as subscribed" footer={<><Button disabled={apply.isPending} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="bulk-subscribe" loading={apply.isPending} disabled={!ready || plan.isPending}>Mark as subscribed</Button></>}>
    <form id="bulk-subscribe" className="stack" onSubmit={event => { event.preventDefault(); void submit() }}>
      <div className="audience-plan" aria-live="polite">
        {plan.isPending || plan.isIdle ? <LoadingRegion label="Counting contacts"><SkeletonText width={260} />{[78, 64, 72].map(width => <SkeletonText key={width} width={`${width}%`} />)}</LoadingRegion>
          : plan.isError ? <><MutationError error={plan.error} /><div><Button onClick={recount}>Count again</Button></div></>
          : !matched ? <p className="muted">No contacts with unknown consent</p>
          : <><p><strong>{matched === 1 ? 'The 1 person' : `${searchIgnored && !batched ? 'All ' : ''}${people}`}</strong> with unknown consent{scope} will be marked subscribed{matched > plan.data.sample.length ? `, including:` : ':'}</p>
            {batched && <p className="muted">Up to {number(BATCH_LIMIT)} contacts per batch. Run again for the rest.</p>}
            <ul className="audience-sample">{plan.data.sample.slice(0, 5).map(row => <li key={row.id}><PrivateAddress value={row.email} />{row.name && <span className="muted"> · {row.name}</span>}</li>)}</ul>
            {plan.data.warnings.map(warning => <Alert key={warning} tone="warning">{warning}</Alert>)}</>}
      </div>
      <Field label="How did they agree?" htmlFor="bulk-evidence" error={missingEvidence ? evidenceRequired : undefined}><Input id="bulk-evidence" maxLength={2000} placeholder="Newsletter box at checkout" disabled={busy || !ready} value={evidence} onChange={event => setEvidence(event.target.value)} /></Field>
      <div><Checkbox checked={attested} disabled={busy || !ready} onCheckedChange={setAttested} label={ready ? `These ${people} agreed to receive marketing email from us.` : 'These people agreed to receive marketing email from us.'} aria-invalid={missingAttestation || undefined} />{missingAttestation && <div className="ui-field__hint ui-field__error" role="alert">Confirm they agreed before marking them subscribed.</div>}</div>
      {plan.data?.requiresResubscribeConfirmation && <div><Checkbox checked={resubscribe} disabled={busy} onCheckedChange={setResubscribe} label="Some opted out before and have subscribed again." aria-invalid={missingResubscribe || undefined} />{missingResubscribe && <div className="ui-field__hint ui-field__error" role="alert">Confirm they subscribed again.</div>}</div>}
      {apply.error ? <><MutationError error={apply.error} /><div><Button onClick={recount}>Count again</Button></div></> : null}
    </form>
  </Dialog>
}
