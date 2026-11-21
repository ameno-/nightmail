// The flow panel: one address's Receive → Process → Deliver beside the list (a sheet on smaller screens), the same
// diagram an address's page shows. Test sends a sample through the saved rules and marks the path it took; it replaces
// Trace. An address typed in the search that has no row of its own shows where its mail would go, and creates it.
import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router'
import { Button } from '../../components/ui'
import { useApiDef } from '../../data/context'
import { queries } from '../../data/queries'
import { defaultSample, EntryFlow, OutcomeFlow, TestBar, testAddress, useFlowTest, type Sample } from './flow'
import type { Overview, RouteEntry } from './overview'

/** Where a row's mail is read: its address's page (Mail) or its agent inbox's. */
export const mailOf = (entry: RouteEntry) => !entry.address || entry.kind === 'pattern' ? null : entry.kind === 'inbox' ? `/receiving/inboxes/${entry.address.id}` : `/receiving/addresses/${entry.address.id}`

export function FlowPanel({ entry, lookup, overview, onEdit, onCreate, mailLink = true }: { entry?: RouteEntry; lookup?: string; overview: Overview; onEdit: (entry: RouteEntry) => void; onCreate?: (address: string) => void; mailLink?: boolean }) {
  const test = useFlowTest()
  // Every address by its ID, for the names a lookup's path reaches (the list may be filtered to one).
  const addresses = useApiDef(queries.inboundAddressOptions())
  const formId = useId()
  const [sample, setSample] = useState<Sample>(defaultSample)
  const address = entry ? testAddress(entry.match) : lookup ?? ''
  // A typed address with no row of its own is looked up at once: where its mail would go is a test.
  useEffect(() => {
    if (!lookup) return
    const timer = setTimeout(() => void test.run(lookup, sample), 300)
    return () => clearTimeout(timer)
  }, [lookup]) // eslint-disable-line react-hooks/exhaustive-deps
  const outcome = test.address === address ? test.outcome : null
  const mail = entry && mailLink ? mailOf(entry) : null
  return <section className="flow-panel" aria-label="Where its mail goes">
    {/* Test last: its spinner widens it while it runs, and nothing sits after it to move. */}
    <div className="flow-panel__actions">
      {lookup && onCreate && <Button variant="primary" onClick={() => onCreate(lookup)}>Create this address</Button>}
      {entry && <Button onClick={() => onEdit(entry)}>Edit</Button>}
      {mail && <Link className="ui-button ui-button--secondary ui-button--md" to={mail}>Mail</Link>}
      <Button type="submit" form={formId} loading={test.pending}>Test</Button>
    </div>
    <TestBar id={formId} address={address} test={test} sample={sample} onSample={setSample} />
    {entry ? <EntryFlow entry={entry} overview={overview} outcome={outcome} boxes={addresses.data ?? []} /> : <OutcomeFlow address={address} overview={overview} outcome={addresses.data || addresses.error || !lookup ? outcome : null} error={test.address === address ? test.error : null} addresses={addresses.data ?? []} />}
  </section>
}
