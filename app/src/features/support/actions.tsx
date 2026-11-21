import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Dialog, ErrorText, StatusDot } from '../../components/ui'
import { supportActionsApi, type SupportAction } from '../../data/support'
import { ApiError } from '../../data/types'
import { relativeTime } from '../../lib/format'
import { actionOutcome, actionTitle } from './store'
import { productName } from '../../../../api/src/brand'
import './support.css'

/** Nightmail's sentence for a proposed change, from its own records, with each name a person typed (a workspace, a
 *  campaign, the end of a webhook URL) put in as text and set apart. Never Markdown or HTML. */
export function ActionSummary({ action }: { action: SupportAction }) {
  const { template, labels } = action.parts
  return <>{template.split(/(\{[a-z]+\})/g).map((piece, i) => {
    const name = /^\{([a-z]+)\}$/.exec(piece)?.[1]
    return name && Object.hasOwn(labels, name) ? <span key={i} className="support-action__name">“{labels[name]}”</span> : piece
  })}</>
}
export const actionTone = (action: SupportAction) => action.status === 'done' ? 'success' : action.status === 'failed' ? 'danger' : action.status === 'running' ? 'info' : 'neutral'

// /support/actions/<id>: the link in an emailed answer, for a change support proposed. Only the person it was proposed to
// sees it (anyone else gets "not available"), and deciding runs with their own session: Nightmail makes the change exactly as
// its own route does, once, and the dialog says what came of it from Nightmail's answer. The dialog opens once the
// proposal has loaded, so it never grows under the reader; its status line is the expiry while it waits and the outcome after.
export function SupportActionDialog() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const key = ['support-action', id]
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => supportActionsApi.get(id, signal), staleTime: 0,
    retry: (count, error) => !(error instanceof ApiError && error.status !== undefined && error.status < 500) && count < 2,
    refetchInterval: current => current.state.data?.status === 'running' ? 2000 : false })
  const [deciding, setDeciding] = useState<'confirm' | 'decline' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const action = query.data
  const open = action?.status === 'proposed'
  async function decide(decision: 'confirm' | 'decline') {
    if (deciding) return
    setDeciding(decision); setError(null)
    try { client.setQueryData(key, await supportActionsApi[decision](id)) }
    catch (cause) { setError(cause); void query.refetch() }
    finally { setDeciding(null) }
  }
  const close = () => { if (!deciding) navigate('/overview', { replace: true }) }
  const missing = query.isError
  if (!action && !missing) return null
  return <Dialog open onOpenChange={next => { if (!next) close() }} title={action ? actionTitle(action.kind) : 'Change not available'} className="support-action-dialog"
    footer={open ? <>
      <Button disabled={Boolean(deciding)} loading={deciding === 'decline'} onClick={() => void decide('decline')}>Not now</Button>
      <Button variant="primary" disabled={Boolean(deciding)} loading={deciding === 'confirm'} onClick={() => void decide('confirm')}>Confirm</Button>
    </> : <Button onClick={close}>Close</Button>}>
    {!action ? <p className="muted">{query.error instanceof ApiError && query.error.status === 404
        ? `${productName} support proposed this to another account, or it no longer exists. Open the link signed in to the account you use with support.`
        : <ErrorText error={query.error} />}</p>
      : <>
        <p className="support-action-dialog__summary"><ActionSummary action={action} /></p>
        <p className="support-action-dialog__status">{open
          ? <span className="muted">Proposed by {productName} support · expires {relativeTime(action.expiresAt)}</span>
          : <StatusDot tone={actionTone(action)}>{actionOutcome(action)}</StatusDot>}</p>
        {error ? <Alert tone="danger"><ErrorText error={error} /></Alert> : null}
      </>}
  </Dialog>
}
