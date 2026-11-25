import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useApiMutation, useApiQuery } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import { useNewsletters } from '../newsletters/shared'
import { ApiError, type AudienceList } from '../../data/types'
import { SearchField, Button, ConfirmDialog, ControlSkeleton, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, PaginationSkeleton, SkeletonText, Tabs, fieldError, MutationError } from '../../components/ui'
import { listColumns, ListDetailBodySkeleton } from './skeletons'
import { ContactTable, date, noUnknown, number, statusOptions } from './shared'
import { ImportContactsDialog } from './import'
import { BulkSubscribeDialog } from './bulk'
import { AudienceHeader } from './header'
import { useAdaptivePageSize, useDebounced, useSearchDraft } from '../../lib/pagination'

// A list's phone card: each consent count with its name, Subscribed and Unknown on one line, the other two below.
const consentCount = (status: 'subscribed' | 'unknown' | 'unsubscribed' | 'suppressed') => (row: AudienceList) => `${number(row[status] ?? 0)} ${status}`
export function ListsPage() {
  const { pageSize, tableRef } = useAdaptivePageSize(5, 100)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [create, setCreate] = useState(false)
  useEffect(() => setPage(1), [pageSize])
  const params = { page, pageSize, search: useDebounced(search.trim()) }
  const query = useApiQuery(['lists', params], (api, signal) => api.lists.list(params, signal))
  const count = (row: AudienceList, status: 'subscribed' | 'unknown' | 'unsubscribed' | 'suppressed') => row[status] ? <Link to={`/audience/lists/${row.id}?status=${status}`} title={`Show ${status} members of ${row.name}`}>{number(row[status])}</Link> : number(row[status] ?? 0)
  return <div className="audience-page measure-list"><AudienceHeader actions={<Button variant="primary" onClick={() => setCreate(true)}>Create list</Button>} />
    <div className="data-toolbar"><SearchField className="search-box--list" aria-label="Search lists" placeholder="Search lists" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><DataTable className="audience-lists" tableRef={tableRef} rows={query.data?.items || []} loading={query.isPending} skeletonRows={pageSize} minRows={pageSize} rowKey={row => row.id} rowHref={row => `/audience/lists/${row.id}`} empty={search ? <EmptyState title="No matching lists" /> : <EmptyState title="No lists yet" action={<Button onClick={() => setCreate(true)}>Create list</Button>} />} columns={[{ ...listColumns[0], render: row => <span className="audience-cell-text" title={row.name}>{row.name}</span> }, { ...listColumns[1], render: row => count(row, 'subscribed'), cardRender: consentCount('subscribed') }, { ...listColumns[2], render: row => count(row, 'unknown'), cardRender: consentCount('unknown') }, { ...listColumns[3], render: row => count(row, 'unsubscribed'), cardRender: consentCount('unsubscribed') }, { ...listColumns[4], render: row => count(row, 'suppressed'), cardRender: consentCount('suppressed') }, { ...listColumns[5], render: row => number(row.total), cardRender: row => `${number(row.total)} total` }, { ...listColumns[6], render: row => date(row.createdAt) }]} />{query.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={pageSize} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={setPage} />}</>}
    {create && <CreateListDialog onClose={() => setCreate(false)} />}
  </div>
}
function CreateListDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const navigate = useNavigate()
  const create = useApiMutation((api, input: { name: string }) => api.lists.create(input), 'List created', false, invalidate.lists)
  async function submit() { try { const list = await create.mutateAsync({ name }); onClose(); navigate(`/audience/lists/${list.id}`) } catch { /* Shown inline. */ } }
  return <Dialog open onOpenChange={open => { if (!open && !create.isPending) onClose() }} title="Create list" footer={<><Button disabled={create.isPending} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="create-list" loading={create.isPending}>Create list</Button></>}><form id="create-list" className="stack" onSubmit={event => { event.preventDefault(); void submit() }}><MutationError error={create.error} /><Field label="List name" htmlFor="list-name" error={fieldError(create.error, 'name')}><Input autoFocus id="list-name" required value={name} onChange={event => setName(event.target.value)} /></Field></form></Dialog>
}
export function ListDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const query = useApiQuery(['lists', id], (api, signal) => api.lists.get(id, signal))
  const [importing, setImporting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const remove = useApiMutation((api, listId: string) => api.lists.remove(listId), 'List deleted', false, invalidate.listRemove)
  // A newsletter is its list: deleting the list takes its sidebar item with it (the session's copy of /v1/me).
  const cache = useQueryClient(), newsletter = useNewsletters().some(item => item.id === id)
  async function deleteList() { await remove.mutateAsync(id); if (newsletter) void cache.invalidateQueries({ queryKey: ['identity'] }); navigate('/audience/lists') }
  const missingOrDenied = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status ?? 0)
  const degraded = query.isError && !query.data && !missingOrDenied
  return <div className="audience-page measure-list measure-list--narrow"><PageHeader title={query.isPending ? <SkeletonText width={96} lineHeight={24} /> : query.data?.name || 'List'} backTo="/audience/lists" actions={query.isPending ? <><ControlSkeleton width={85} /><ControlSkeleton width={120} /></> : (query.data || degraded) && <><Button variant="danger" onClick={() => {remove.reset(); setConfirmDelete(true)}}>Delete list</Button><Button variant="primary" onClick={() => setImporting(true)}>Import contacts</Button></>} />
    {query.isPending ? <ListDetailBodySkeleton /> : missingOrDenied ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <ListMembers key={id} listId={id} list={query.data} countsFailed={degraded} countsRefreshing={query.isFetching} onRetryCounts={() => void query.refetch()} />}
    {importing && <ImportContactsDialog listId={id} onClose={() => setImporting(false)} />}
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title={`Delete ${query.data?.name ?? 'list'}?`} description="Deletes the list, not its contacts." confirmLabel="Delete list" danger pending={remove.isPending} onConfirm={deleteList} />
  </div>
}
// The consent tab and search are in the URL (status, q): campaign review links straight to /audience/lists/<id>?status=unknown.
function ListMembers({ listId, list, countsFailed = false, countsRefreshing = false, onRetryCounts }: { listId: string; list?: AudienceList; countsFailed?: boolean; countsRefreshing?: boolean; onRetryCounts?: () => void }) {
  const { pageSize, tableRef } = useAdaptivePageSize(5, 100)
  const [params, setParams] = useSearchParams()
  const status = statusOptions.some(option => option.value === params.get('status')) ? params.get('status')! : '', search = params.get('q') ?? ''
  const [page, setPage] = useState(1)
  const [bulk, setBulk] = useState(false)
  const update = (key: string, value: string) => { setParams(current => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); return next }, { replace: true }); setPage(1) }
  const [draft, type] = useSearchDraft(search, value => update('q', value))
  useEffect(() => setPage(1), [pageSize])
  const request = { listId, search, status, page, pageSize }
  const query = useApiQuery(['contacts', request], (api, signal) => api.contacts.list(request, signal))
  const unknown = list?.unknown ?? 0
  return <><Tabs value={status} onValueChange={value => update('status', value)} items={[{ value: '', label: 'All members', count: list?.total }, ...statusOptions.map(option => ({ ...option, count: option.value === 'risky' ? undefined : list?.[option.value as 'subscribed' | 'unknown' | 'unsubscribed' | 'suppressed'] }))]} />
    <div className="data-toolbar"><SearchField className="search-box--list" aria-label="Search members" placeholder="Search members" value={draft} onChange={event => type(event.target.value)} />{unknown > 0 && <Button onClick={() => setBulk(true)}>Mark {number(unknown)} as subscribed…</Button>}{countsFailed && <span className="cluster muted"><span>Counts unavailable</span><Button variant="ghost" size="sm" loading={countsRefreshing} onClick={onRetryCounts}>Retry</Button></span>}</div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><ContactTable tableRef={tableRef} contacts={query.data?.items || []} members status={status} loading={query.isPending} minRows={pageSize} empty={search ? <EmptyState title="No matching members" /> : status === 'unknown' ? <EmptyState title={noUnknown} /> : status ? <EmptyState title={`No ${statusOptions.find(option => option.value === status)?.label.toLowerCase()} members`} /> : <EmptyState title="No contacts in this list" />} />{query.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={pageSize} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={setPage} />}</>}
    {bulk && <BulkSubscribeDialog listId={listId} listName={list?.name} unknownCount={unknown} searchIgnored={Boolean(search)} onClose={() => setBulk(false)} />}
  </>
}
