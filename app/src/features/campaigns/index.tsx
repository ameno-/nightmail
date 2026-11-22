import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Clock, Gauge, Mail, MoreHorizontal, UsersRound } from 'lucide-react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { useApiDef, useApiMutation, useApiQuery, useRegion, useApi, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { priceUc, total, usd } from '../../data/billing'
import { useRefreshListsOnChange } from '../../data/invalidation'
import { useRegionCatalog } from '../../data/regions'
import { ApiError, campaignEditable, errorText, campaignResumable, type Campaign, type CampaignInput, type SendCampaignInput } from '../../data/types'
import { PostalAddressDialog } from '../../components/PostalAddress'
import {
  Button, Checkbox, ConfirmDialog, Dialog, DropdownMenu, EmptyState, ErrorState,
  Field, IconButton, Input, PageHeader, SectionHeader, Select, SkeletonText,
  StatusBadge, Tabs, useToast,
} from '../../components/ui'
import { EmailPreview } from '../../components/EmailPreview'
import { LOW_SENDABILITY, topFixes, useSendability } from '../../components/EmailInsight'
import { date, number } from '../../lib/format'
import { CampaignAudienceSkeleton, CampaignRouteSkeleton } from './skeletons'
import { CampaignPacing, CampaignProgress, campaignDisplayStatus, campaignPollInterval, maxPerDay, maxRatePercent, minPerDay, minRatePercent, perDayError, ratePercentError } from './CampaignProgress'
import { CampaignArchiveButton } from './CampaignArchiveButton'
import { CampaignBar, CampaignSteps } from './steps'
import { productName } from '../../../../api/src/brand'
export { CampaignsPage } from './CampaignList'
export { TemplatesPage, TemplateEditorPage } from './templates'
import { TemplatePickerDialog } from './templates'
import './campaigns.css'
import type { EmailComposerRef } from './EmailComposer'
import { composer as composerChunk, EmailComposer } from './composer-chunk'
import { ChunkFallback } from '../../lib/preloadable'
import { CampaignSenderInput } from './CampaignSenderInput'
import { CampaignAttachments, type CampaignAttachmentsRef } from './CampaignAttachments'
import { campaignVersion, useCampaignSync } from './useCampaignSync'
import { ComposerSkeleton } from './skeletons'
import { composerLoading, invalidSender } from './copy'
import { AddressList, NamedAddress, PrivateAddress } from '../../components/PrivateAddress'
import { localLabel, parseUtc, ScheduleField, scheduleError, utcLabel } from '../../components/ScheduleField'
import { useSingleFlight } from '../../lib/single-flight'
import { usePhone } from '../../lib/media'
import { useLeaveGuard } from '../../lib/leave-guard'
import { emailIsValid, replyToAddresses, replyToError } from './reply-to'

// {{placeholders}} the campaign uses; email always resolves, everything else needs a contact value or a fallback.
const placeholderPattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g
export const placeholders = (...sources: (string | undefined)[]) => [...new Set(sources.flatMap(source => [...(source ?? '').matchAll(placeholderPattern)].map(match => match[1]!)))]
// The API's rule (outbound-content.ts unsubscribePageUrl), checked as typed so autosave never sends a page it refuses.
const unsubscribePageError = (value = '') => {
  const text = value.trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    if (/^https:\/\//i.test(text) && text.length <= 1000 && !/\s/.test(text) && !url.username && !url.password && !/^[^/?#]*@/.test(text.slice(8))) return url.searchParams.has('unsubscribe_token') ? 'Remove unsubscribe_token from the address.' : ''
  } catch { /* not a URL */ }
  return 'Enter an https:// address without a user name or password.'
}
const nobodyEligible = 'Nobody on this list can receive campaigns yet. Mark contacts as subscribed or choose another list.'
const campaignRoute = (campaign: Pick<Campaign, 'id'>, view: 'edit' | 'review') => `/campaigns/${encodeURIComponent(campaign.id)}/${view}`
function campaignReadinessError(campaign: Campaign) {
  const missing = [!campaign.name.trim() && 'a campaign name', !campaign.subject.trim() && 'a subject', !emailIsValid(campaign.fromEmail.trim()) && 'a valid sender email address', !campaign.listId && 'a recipient list', !campaign.html.trim() && 'email content'].filter(Boolean)
  return missing.length ? `Complete the draft before reviewing or sending: add ${missing.join(', ')}.` : ''
}
// A test goes to one address, so it needs a complete message but no recipient list (the API sends it without one).
const campaignMessageReady = (campaign: Campaign) => Boolean(campaign.name.trim() && campaign.subject.trim() && emailIsValid(campaign.fromEmail.trim()) && campaign.html.trim())
const olderCampaign = (candidate: Campaign, baseline: Campaign) => (candidate.revision ?? 1) < (baseline.revision ?? 1) || ((candidate.revision ?? 1) === (baseline.revision ?? 1) && Date.parse(candidate.updatedAt) < Date.parse(baseline.updatedAt))
const campaignInput = (campaign: Campaign): CampaignInput => ({
  id: campaign.id, revision: campaign.revision, draft: campaign.draft, attachments: campaign.attachments, regionId: campaign.regionId,
  name: campaign.name, subject: campaign.subject, previewText: campaign.previewText, fromName: campaign.fromName, fromEmail: campaign.fromEmail, replyTo: campaign.replyTo, unsubscribePageUrl: campaign.unsubscribePageUrl,
  listId: campaign.listId, segmentId: campaign.segmentId, html: campaign.html, defaults: Object.fromEntries(Object.entries(campaign.draft?.defaults ?? {}).map(([key, value]) => [key, String(value)])),
})

export function CampaignEditorPage() {
  const { id } = useParams()
  const { regionId } = useRegion()
  // Hosted campaigns follow their From domain's region, so a new draft needs no region at all.
  const { multiTenant } = useWorkspaceAccess()
  const regions = useRegionCatalog({ enabled: !id && !multiTenant })
  const fallbackRegion = multiTenant ? '' : regionId || regions.data?.defaultRegion || ''
  const scope = useRef({ id, key: id ?? 'new', createdId: null as string | null })
  if (scope.current.id !== id) {
    const ownCreation = !scope.current.id && id === scope.current.createdId
    scope.current = { id, key: ownCreation ? scope.current.key : id ?? 'new', createdId: null }
  }
  if (!id && !multiTenant && !fallbackRegion) {
    if (regions.isPending) return <CampaignRouteSkeleton kind="editor" isNew />
    return <><PageHeader title="Create campaign" backTo="/campaigns" />{regions.isError ? <ErrorState error={regions.error} onRetry={() => regions.refetch()} /> : <EmptyState title="No sending region" action={<Link className="ui-button ui-button--secondary ui-button--md" to="/settings#workspace">Choose a default region</Link>} />}</>
  }
  return <CampaignEditorLoader key={scope.current.key} id={id} fallbackRegion={fallbackRegion} preserveEditor={next => {scope.current.createdId = next.id}} />
}

function CampaignEditorLoader({ id, fallbackRegion, preserveEditor }: { id?: string; fallbackRegion: string; preserveEditor: (campaign: Campaign) => void }) {
  const query = useApiQuery<Campaign | null>(['campaign', id ?? 'new'], (api, signal) => id ? api.campaigns.get(id, signal) : Promise.resolve(null))
  const opened = useRef<Campaign | null | undefined>(undefined)
  useEffect(() => { void composerChunk.preload().catch(() => {}) }, [])
  useEffect(() => {
    if (query.data) console.info(`[${productName} timing] campaign content ready`, { navigationMs: Number(performance.now().toFixed(1)), revision: query.data.revision })
  }, [query.data])
  if (opened.current === undefined && query.data !== undefined && (query.data === null || (!query.data.archivedAt && campaignEditable(query.data)))) opened.current = query.data
  // Once opened, background refetches must never unmount an unsaved working copy.
  if (opened.current !== undefined) return <CampaignEditor initial={opened.current} fallbackRegion={fallbackRegion} preserveEditor={preserveEditor} />
  if (query.isPending) return <CampaignRouteSkeleton kind="editor" isNew={!id} />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  // Archived and sent campaigns can't be edited: their review page is where to read, restore or follow them.
  if (query.data) return <Navigate to={campaignRoute(query.data, 'review')} replace />
  return null
}

function CampaignEditor({ initial, fallbackRegion, preserveEditor }: { initial: Campaign | null; fallbackRegion: string; preserveEditor: (campaign: Campaign) => void }) {
  const toast = useToast()
  const phone = usePhone()
  const { multiTenant } = useWorkspaceAccess()
  const api = useApi()
  const navigate = useNavigate()
  const [accepted, setAccepted] = useState(initial)
  const acceptedRef = useRef(initial)
  const [form, setForm] = useState<CampaignInput>(() => initial ? campaignInput(initial) : { regionId: fallbackRegion, name: '', subject: '', previewText: '', fromName: '', fromEmail: '', replyTo: [], listId: '', segmentId: null, html: '', defaults: {} })
  const [templatesOpen, setTemplatesOpen] = useState(false)
  // Body placeholders are known from the last saved body; subject and inbox preview are read as they are typed.
  const [bodyKeys, setBodyKeys] = useState(() => placeholders(initial?.html))
  const [replyToText, setReplyToText] = useState(() => (initial?.replyTo ?? []).join(', '))
  // Checked once you leave the field, not on every keystroke of an address still being typed.
  const [replyToLeft, setReplyToLeft] = useState(true)
  const formRef = useRef(form)
  function updateForm(next: CampaignInput) { formRef.current = next; setForm(next) }
  const editVersion = useRef(0)
  const [edits, setEdits] = useState(0)
  const [autosaving, setAutosaving] = useState(false)
  const [autosavePaused, setAutosavePaused] = useState(false)
  const creation = useRef<{ input: CampaignInput; version: number; ambiguous?: boolean } | null>(null)
  const mounted = useRef(true)
  const composer = useRef<EmailComposerRef>(null)
  const attachments = useRef<CampaignAttachmentsRef>(null)
  const [generation, setGeneration] = useState(0)
  const [composerReady, setComposerReady] = useState(false)
  const readyRef = useRef(false)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)
  const [remote, setRemote] = useState<Campaign | null>(null)
  const remoteRef = useRef<Campaign | null>(null)
  const [reviewUpdate, setReviewUpdate] = useState(false)
  const [loadingLatest, setLoadingLatest] = useState(false)
  const refreshController = useRef<AbortController | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [attachmentsBusy, setAttachmentsBusy] = useState(false)
  const [composerBusy, setComposerBusy] = useState(false)
  const handleComposerReady = useCallback(() => { readyRef.current = true; setComposerReady(true) }, [])
  // Review's Edit message and Edit audience land on what they name: the message body or the recipient list, in view and focused.
  const { hash } = useLocation()
  useEffect(() => {
    if (!composerReady || hash !== '#message') return
    const target = document.querySelector<HTMLElement>('.composer-canvas [contenteditable="true"]')
    target?.scrollIntoView({ block: 'center', behavior: 'instant' })
    target?.focus({ preventScroll: true })
  }, [composerReady, hash])
  const [error, setError] = useState('')
  const [testOpen, setTestOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(Boolean(initial?.previewText))
  const [senderOpen, setSenderOpen] = useState(false)
  const previewInput = useRef<HTMLInputElement>(null)
  const guard = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; refreshController.current?.abort() }
  }, [])
  const [domainCursor, setDomainCursor] = useState<string | undefined>()
  const options = useApiQuery(['campaign-options', { pageSize: 100, domains: domainCursor }], async (api, signal) => {
    const domainPage = await api.domains.list({pageSize: 100, cursor: domainCursor, refresh: false}, signal)
    return { domains: domainPage.items.filter(domain => domain.status === 'verified'), next: domainPage.nextCursor }
  })
  const previousOptions = useRef<typeof options.data>(undefined)
  if (options.data) previousOptions.current = options.data
  const choices = options.data ?? previousOptions.current ?? { domains: [], next: null }
  const cache = useQueryClient()
  // Saves write the campaign into the cache instead of refetching every query on each autosave.
  const saveMutation = useApiMutation((api, input: CampaignInput) => api.campaigns.save(input), undefined, false, false)
  const pending = preparing || autosaving || attachmentsBusy || composerBusy || saveMutation.isPending || loadingLatest
  busyRef.current = pending
  const markDirty = useCallback(() => { editVersion.current += 1; setEdits(editVersion.current); dirtyRef.current = true; setDirty(true); setError('') }, [])
  const handleComposerDirty = useCallback(() => { if (readyRef.current) markDirty() }, [markDirty])
  function change<K extends keyof CampaignInput>(key: K, value: CampaignInput[K]) {
    updateForm({ ...formRef.current, [key]: value })
    markDirty()
  }
  function queueRemote(next: Campaign | null) { remoteRef.current = next; setRemote(next) }
  function applyRemote(next: Campaign) {
    // A manual reload and background poll can finish out of order. Never discard
    // a newer snapshot that arrived while the reload was in flight.
    if (remoteRef.current && olderCampaign(next, remoteRef.current)) next = remoteRef.current
    if (acceptedRef.current && olderCampaign(next, acceptedRef.current)) next = acceptedRef.current
    acceptedRef.current = next
    setAccepted(next)
    updateForm(campaignInput(next))
    setReplyToText(next.replyTo.join(', '))
    setAutosavePaused(false)
    creation.current = null
    dirtyRef.current = false
    setDirty(false)
    readyRef.current = false
    setComposerReady(readyRef.current)
    setGeneration(value => value + 1)
    setPreviewOpen(Boolean(next.previewText))
    queueRemote(null)
    setReviewUpdate(false)
    setTestOpen(false)
    setError('')
  }
  function receiveRemote(next: Campaign) {
    const baseline = acceptedRef.current
    if (!baseline || next.id !== baseline.id || campaignVersion(next) === campaignVersion(baseline)) return
    if (olderCampaign(next, baseline) || (remoteRef.current && olderCampaign(next, remoteRef.current))) return
    setTestOpen(false)
    if (dirtyRef.current || busyRef.current) queueRemote(next)
    else applyRemote(next)
  }
  const sync = useCampaignSync(accepted, receiveRemote)
  const current = remote ?? accepted
  const unavailable = Boolean(sync.error && 'status' in sync.error && [401, 403, 404].includes(Number(sync.error.status)))
  const readOnly = unavailable || Boolean(current && (current.archivedAt || !campaignEditable(current)))
  const controlsDisabled = preparing || attachmentsBusy || composerBusy || loadingLatest || readOnly
  const replyToProblem = replyToError(replyToText)
  const replyToValidation = replyToLeft ? replyToProblem : ''
  const unsubscribePageValidation = unsubscribePageError(form.unsubscribePageUrl)
  const fallbackKeys = [...new Set([...placeholders(form.subject, form.previewText), ...bodyKeys])].filter(key => key !== 'email')
  const saveDisabled = options.isPending || options.isError || !composerReady || readOnly || Boolean(remote) || Boolean(replyToProblem) || Boolean(unsubscribePageValidation)
  useEffect(() => {
    if (!dirty || pending || saveDisabled || autosavePaused || !form.name.trim()) return
    const timer = setTimeout(() => { void save('auto') }, 800)
    return () => clearTimeout(timer)
  }, [edits, dirty, pending, saveDisabled, autosavePaused, form.name])
  useEffect(() => { if (remote && !dirtyRef.current && !busyRef.current) applyRemote(remote) }, [remote, pending, dirty])
  async function loadLatest() {
    if (!acceptedRef.current || pending) return
    const controller = new AbortController()
    refreshController.current?.abort()
    refreshController.current = controller
    setLoadingLatest(true)
    busyRef.current = true
    try {
      const latest = await api.campaigns.get(acceptedRef.current.id, controller.signal)
      if (!controller.signal.aborted) applyRemote(latest)
    } catch (cause) { if (!controller.signal.aborted) toast(errorText(cause), 'error') }
    finally { if (!controller.signal.aborted) { setLoadingLatest(false); busyRef.current = false } }
  }
  const syncLabel = autosaving || preparing || saveMutation.isPending ? 'Saving…' : remote ? 'Update available' : autosavePaused ? 'Save failed' : error ? 'Check draft' : unavailable ? 'Unavailable' : readOnly ? 'Read only' : sync.connection === 'offline' ? 'Sync interrupted' : dirty ? form.name.trim() ? 'Unsaved changes' : 'Name required' : accepted ? 'Saved' : 'New draft'
  const syncActionable = Boolean(remote || error || autosavePaused || sync.connection === 'offline')
  const syncState = error || autosavePaused || sync.connection === 'offline' ? 'offline' : remote || dirty || autosaving ? 'changed' : sync.connection
  const syncTitle = error || sync.error?.message || (remote ? 'A newer version is available.' : autosavePaused ? 'Autosave paused. Retry saving your changes.' : readOnly ? 'This campaign is no longer editable.' : 'Changes save automatically and sync with MCP and the API.')
  function syncAction() { if (remote) setReviewUpdate(true); else if (autosavePaused) void save('edit'); else if (error) toast(error, 'error'); else sync.checkNow() }
  function reportError(value: string) { setError(value); toast(value, 'error') }
  async function save(next: 'auto' | 'edit' | 'review' | 'test') {
    if (guard.current || pending || !readyRef.current || readOnly) return
    const automatic = next === 'auto'
    if (remoteRef.current) { if (!automatic) setReviewUpdate(true); return }
    const continuing = next === 'review' || next === 'test'
    const input = creation.current?.input ?? formRef.current
    const version = creation.current?.version ?? editVersion.current
    const validation = !input.name.trim() ? 'Enter a campaign name.'
      : continuing && !input.subject.trim() ? 'Enter a subject before continuing.'
      : (continuing || input.fromEmail.trim()) && !emailIsValid(input.fromEmail.trim()) ? invalidSender
      : !multiTenant && (!input.regionId.trim() || input.regionId.trim().length > 40) ? 'Enter a region identifier of 1–40 characters.' : ''
    if (validation) { if (!automatic) reportError(validation); return }
    // An unchanged saved draft needs no new revision: open the test or review straight away.
    if (continuing && acceptedRef.current && !dirtyRef.current && !creation.current) {
      // A saved draft can still miss its message (an empty body): say so rather than open a test the API refuses.
      if (next === 'test') { if (campaignMessageReady(acceptedRef.current)) setTestOpen(true); else reportError(acceptedRef.current.html.trim() ? campaignReadinessError({ ...acceptedRef.current, listId: acceptedRef.current.listId || 'any' }) : 'Add some email content before sending a test.') }
      else navigate(campaignRoute(acceptedRef.current, 'review'))
      return
    }
    guard.current = true
    busyRef.current = true
    setError('')
    setAutosavePaused(false)
    if (automatic) setAutosaving(true)
    else setPreparing(true)
    try {
      let submitted = creation.current?.input
      if (!submitted) {
        const content = await composer.current?.prepare()
        if (!content) throw new Error(composerLoading)
        if (continuing && !content.html.trim()) throw new Error('Add some email content before continuing.')
        submitted = { ...input, ...content, attachments: [...new Set([...(input.attachments ?? []), ...(content.inlineAttachmentIds ?? [])])], defaults: Object.fromEntries(Object.entries(input.defaults ?? {}).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value)), name: input.name.trim(), subject: input.subject.trim(), fromName: input.fromName.trim(), fromEmail: input.fromEmail.trim(), regionId: input.regionId.trim() }
        if (!submitted.id) {
          submitted.idempotencyKey = crypto.randomUUID()
          creation.current = { input: structuredClone(submitted), version }
        }
      }
      const saved = await saveMutation.mutateAsync(submitted)
      cache.setQueryData(['nightmail', 'campaign', saved.id], saved)
      void cache.invalidateQueries({queryKey: ['nightmail', 'campaigns'], refetchType: 'none'})
      if (!mounted.current) return
      creation.current = null
      const changedWhileSaving = editVersion.current !== version
      acceptedRef.current = saved
      setAccepted(saved)
      dirtyRef.current = changedWhileSaving
      setDirty(changedWhileSaving)
      queueRemote(remoteRef.current && olderCampaign(saved, remoteRef.current) ? remoteRef.current : null)
      updateForm({...formRef.current, id: saved.id, revision: saved.revision, draft: saved.draft, attachments: changedWhileSaving ? formRef.current.attachments : saved.attachments})
      const reviewing = next === 'review' && !changedWhileSaving
      if (!submitted.id && !reviewing) {
        preserveEditor(saved)
        navigate(campaignRoute(saved, 'edit'), { replace: true })
      }
      if (next === 'test' && !changedWhileSaving) setTestOpen(true)
      else if (reviewing) navigate(campaignRoute(saved, 'review'))
      setBodyKeys(placeholders(submitted.html))
    } catch (cause) {
      if (!mounted.current) return
      const status = cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : 0
      if (creation.current) {
        if (!creation.current.ambiguous && status >= 400 && status < 500 && status !== 408) creation.current = null
        else creation.current.ambiguous = true
      }
      setAutosavePaused(true)
      if (automatic) setError(errorText(cause))
      else reportError(errorText(cause))
      sync.checkNow()
    } finally {
      guard.current = false
      if (mounted.current) { setPreparing(false); setAutosaving(false) }
    }
  }
  // In-app links ask before dropping edits autosave hasn't stored: a draft without a name, a failed save, or typing
  // inside autosave's 800 ms wait. Closing or reloading the tab gets the browser's prompt.
  const leaveGuard = useLeaveGuard(dirty || autosavePaused, { what: 'this campaign', save: async () => { await save('edit'); return !dirtyRef.current && !creation.current } })
  const senderValidation = replyToValidation || unsubscribePageValidation
  const senderDetailsOpen = senderOpen || Boolean(senderValidation)
  const toggleSender = () => { const next = !senderOpen; setSenderOpen(next); if (next) requestAnimationFrame(() => document.getElementById('campaign-reply-to')?.focus({ preventScroll: true })) }
  const review = () => void save('review')
  return <div className="campaign-compose-page campaign-studio">
    <CampaignBar title={<>
      <h1 className="sr-only">{accepted ? 'Edit campaign' : 'Create campaign'}</h1>
      <Input id="campaign-name" className="studio-name" aria-label="Campaign name" placeholder="Untitled campaign" value={form.name} onChange={event => change('name', event.target.value)} required disabled={controlsDisabled} />
    </>} steps={<CampaignSteps step="write" onReview={saveDisabled || pending || autosavePaused ? undefined : review} />} actions={<>
      {!phone && <div className="campaign-sync-status" role="status" data-state={syncState} data-actionable={syncActionable || undefined} title={syncTitle}>
        <span className="campaign-sync-dot" aria-hidden="true" />
        {syncActionable ? <Button variant="ghost" size="sm" disabled={pending} onClick={syncAction}>{syncLabel}</Button> : <span>{syncLabel}</span>}
      </div>}
      {phone ? <>
        <Button variant="primary" disabled={saveDisabled || pending || autosavePaused} loading={preparing} onClick={review}>Continue</Button>
        <DropdownMenu label="More actions" trigger={<IconButton label={syncActionable ? `More actions. ${syncLabel}` : 'More actions'} className="campaign-menu-trigger" data-state={syncActionable ? syncState : undefined}><MoreHorizontal size={16} /></IconButton>} items={[
          ...(syncActionable ? [{ label: `${syncLabel} · ${remote ? 'Load latest' : error && !autosavePaused ? 'Details' : 'Retry'}`, hint: syncTitle, disabled: pending, onSelect: syncAction }] : []),
          // A new draft offers a template; once it has saved (named), a test send.
          ...(accepted ? [{ label: 'Send test', disabled: saveDisabled || pending || autosavePaused, onSelect: () => void save('test') }] : [{ label: 'Use a template', disabled: pending, onSelect: () => setTemplatesOpen(true) }]),
        ]} />
      </> : <>
        {!accepted && <Button variant="ghost" disabled={pending} onClick={() => setTemplatesOpen(true)}>Use a template</Button>}
        <Button variant="secondary" disabled={!accepted || saveDisabled || pending || autosavePaused} title={!accepted ? 'Name the campaign first' : undefined} onClick={() => save('test')}>Send test</Button>
        <Button variant="primary" disabled={saveDisabled || pending || autosavePaused} loading={preparing} onClick={review} data-analytics="campaigns/review">Continue</Button>
      </>}
    </>} />
    {options.isError && <ErrorState error={options.error} onRetry={() => options.refetch()} />}
    <section className="campaign-compose-workspace" aria-label="Campaign composer">
      <div className="campaign-compose-scroll">
        <div className="campaign-compose-sheet">
          <div className="campaign-compose-metadata">
            <div className="campaign-compose-row campaign-compose-sender"><label htmlFor="campaign-from-email">From</label><CampaignSenderInput key={generation} name={form.fromName} email={form.fromEmail} domains={choices.domains.map(domain => domain.name)} disabled={controlsDisabled || options.isPending} onChange={({name, email}) => {const domain = email.split('@')[1]?.toLowerCase(); const supports = (parent: string) => domain === parent || domain?.endsWith(`.${parent}`); const match = choices.domains.find(item => supports(item.name) && item.regionId === formRef.current.regionId) ?? choices.domains.find(item => supports(item.name)); if (name !== formRef.current.fromName || email !== formRef.current.fromEmail || (match && match.regionId !== formRef.current.regionId)) updateForm({...formRef.current, fromName: name, fromEmail: email, ...(match ? {regionId: match.regionId} : {})}); markDirty()}} /><Button variant="ghost" size="sm" className="campaign-sender-toggle" aria-expanded={senderDetailsOpen} aria-controls="campaign-sender-details" onClick={toggleSender}>Reply to<ChevronRight size={14} aria-hidden="true" /></Button></div>
            <div id="campaign-sender-details" className="campaign-compose-preview" data-open={senderDetailsOpen || undefined} aria-hidden={!senderDetailsOpen} inert={!senderDetailsOpen}>
              <div>
                <div className="campaign-compose-row"><label htmlFor="campaign-reply-to">Reply to</label><Input id="campaign-reply-to" type="text" inputMode="email" autoCapitalize="none" spellCheck={false} placeholder="reply@example.com" value={replyToText} aria-invalid={Boolean(replyToValidation) || undefined} aria-describedby={replyToValidation ? 'campaign-reply-to-error' : undefined} onChange={event => { const value = event.target.value; setReplyToText(value); setReplyToLeft(false); updateForm({...formRef.current, replyTo: replyToAddresses(value)}); markDirty() }} onBlur={() => setReplyToLeft(true)} disabled={controlsDisabled} /></div>
                {replyToValidation && <div id="campaign-reply-to-error" className="campaign-compose-feedback ui-field__error" role="alert">{replyToValidation}</div>}
                <div className="campaign-compose-row"><label htmlFor="campaign-unsubscribe-page">Unsubscribe</label><Input id="campaign-unsubscribe-page" type="url" inputMode="url" autoCapitalize="none" spellCheck={false} maxLength={1000} placeholder="https://example.com/unsubscribe" value={form.unsubscribePageUrl ?? ''} aria-invalid={Boolean(unsubscribePageValidation) || undefined} aria-describedby={unsubscribePageValidation ? 'campaign-unsubscribe-page-error' : undefined} onChange={event => change('unsubscribePageUrl', event.target.value)} disabled={controlsDisabled} /></div>
                {unsubscribePageValidation && <div id="campaign-unsubscribe-page-error" className="campaign-compose-feedback ui-field__error" role="alert">{unsubscribePageValidation}</div>}
              </div>
            </div>
            {(domainCursor || choices.next) && <div className="campaign-compose-feedback cluster"><Button onClick={() => setDomainCursor(undefined)}>First domains</Button><Button disabled={!choices.next} onClick={() => setDomainCursor(choices.next ?? undefined)}>More domains</Button></div>}
            {!options.isPending && choices.domains.length === 0 && <div className="campaign-compose-feedback campaign-note" data-tone="warning"><span>No verified domains on this page · <Link to="/domains">Add a domain</Link></span></div>}
            <div className="campaign-compose-row campaign-compose-subject"><label htmlFor="campaign-subject">Subject</label><Input id="campaign-subject" placeholder="Add a subject" value={form.subject} onChange={event => change('subject', event.target.value)} disabled={controlsDisabled} /><Button className="campaign-preview-toggle" variant="ghost" size="sm" disabled={controlsDisabled} aria-expanded={previewOpen} aria-controls="campaign-preview-row" onClick={() => {setPreviewOpen(!previewOpen); if (!previewOpen) requestAnimationFrame(() => previewInput.current?.focus({preventScroll: true}))}}>Inbox preview</Button></div>
            <div id="campaign-preview-row" className="campaign-compose-preview" data-open={previewOpen || undefined} aria-hidden={!previewOpen} inert={!previewOpen}>
              <div><div className="campaign-compose-row"><label htmlFor="campaign-preview">Inbox preview</label><Input ref={previewInput} id="campaign-preview" maxLength={200} placeholder="Shown after the subject" value={form.previewText} onChange={event => change('previewText', event.target.value)} disabled={controlsDisabled} /></div></div>
            </div>
          </div>
          <ChunkFallback.Provider value={<ComposerSkeleton />}><EmailComposer key={generation} ref={composer} personalize attachmentIds={form.attachments ?? []} initialHtml={form.html} disabled={controlsDisabled} onReady={handleComposerReady} onDirty={handleComposerDirty} onBusy={value => {busyRef.current = value || attachmentsBusy || guard.current || loadingLatest; setComposerBusy(value); if (value) markDirty()}} onAttach={() => {markDirty(); attachments.current?.open()}} /></ChunkFallback.Provider>
          <CampaignAttachments key={`attachments:${generation}`} ref={attachments} ids={form.attachments ?? []} persisted={form.draft?.attachments ?? []} onChange={ids => change('attachments', ids)} onBusy={value => {busyRef.current = value || guard.current || loadingLatest; setAttachmentsBusy(value)}} disabled={preparing || autosaving || saveMutation.isPending || composerBusy || loadingLatest || readOnly} />
          {/* Every contact has an email, so {{email}} needs no fallback and no row. */}
          {fallbackKeys.length > 0 && <section className="campaign-personalize" aria-labelledby="campaign-personalize-title">
            <h2 className="campaign-personalize__lead" id="campaign-personalize-title">Fallbacks</h2>
            {fallbackKeys.map(key => <div key={key} className="campaign-compose-row"><label htmlFor={`campaign-fallback-${key}`}>{`{{${key}}}`}</label><Input id={`campaign-fallback-${key}`} placeholder={key === 'name' || key === 'firstName' ? 'there' : undefined} value={form.defaults?.[key] ?? ''} aria-invalid={!form.defaults?.[key]?.trim() || undefined} onChange={event => change('defaults', { ...formRef.current.defaults, [key]: event.target.value })} disabled={controlsDisabled} /></div>)}
          </section>}
        </div>
      </div>
    </section>
    <ConfirmDialog open={reviewUpdate} onOpenChange={value => {if (!loadingLatest) setReviewUpdate(value)}} title="Load the latest campaign?" description="This campaign changed elsewhere. Loading the latest version discards your unsaved changes." confirmLabel="Load latest" onConfirm={loadLatest} pending={loadingLatest} />
    {accepted && testOpen && <TestEmailDialog campaign={accepted} open={testOpen} onOpenChange={setTestOpen} />}
    {templatesOpen && <TemplatePickerDialog onOpenChange={setTemplatesOpen} />}
    {leaveGuard}
  </div>
}

function TestEmailDialog({ campaign, open, onOpenChange }: { campaign: Campaign; open: boolean; onOpenChange: (value: boolean) => void }) {
  const [to, setTo] = useState('')
  const [error, setError] = useState('')
  const guard = useRef(false)
  // Placeholders without a fallback need a sample value, or the test can't render.
  const fallbacks = campaign.draft?.defaults ?? {}
  const samples = placeholders(campaign.subject, campaign.previewText, campaign.html).filter(key => key !== 'email' && (fallbacks[key] === undefined || fallbacks[key] === ''))
  const [data, setData] = useState<Record<string, string>>(() => Object.fromEntries(samples.map(key => [key, key === 'name' ? 'Sam Example' : key === 'firstName' ? 'Sam' : ''])))
  const [sent, setSent] = useState<{ to: string; id?: string } | null>(null)
  const mutation = useApiMutation((api, input: { id: string; to: string; data: Record<string, string> }) => api.campaigns.test(input))
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (guard.current || mutation.isPending) return
    if (!emailIsValid(to.trim())) { setError('Recipient email: enter an address like you@example.com.'); return }
    const missing = samples.find(key => !data[key]?.trim())
    if (missing) { setError(`Sample {{${missing}}}: enter a value to show in the test, or add a fallback in the editor.`); return }
    setError('')
    guard.current = true
    try {
      const result = await mutation.mutateAsync({ id: campaign.id, to: to.trim(), data: Object.fromEntries(samples.map(key => [key, data[key]!.trim()])) })
      if (!result.accepted) { setError('The test wasn’t accepted. Try again.'); return }
      setSent({ to: to.trim(), id: result.id })
    } catch (cause) { setError(errorText(cause)) }
    finally { guard.current = false }
  }
  return <Dialog open={open} onOpenChange={value => { if (!mutation.isPending) { setError(''); onOpenChange(value) } }} title="Send test email">
    {sent ? <div className="stack">
      <p className="campaign-note" data-tone="success" role="status"><span>Test sent to <PrivateAddress value={sent.to} />.{sent.id && <> <Link to={`/logs/${encodeURIComponent(sent.id)}`}>View in Logs</Link></>}</span></p>
      <div className="cluster campaign-dialog-actions"><Button variant="secondary" onClick={() => { setSent(null); mutation.reset() }}>Send another</Button><Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button></div>
    </div> : <form className="stack" onSubmit={submit} noValidate>
      <Field label="Recipient email" htmlFor="campaign-test-recipient"><Input id="campaign-test-recipient" type="email" autoComplete="email" autoFocus value={to} onChange={event => { setTo(event.target.value); setError('') }} disabled={mutation.isPending} /></Field>
      {samples.map(key => <Field key={key} label={`Sample {{${key}}}`} htmlFor={`campaign-test-${key}`}><Input id={`campaign-test-${key}`} value={data[key] ?? ''} onChange={event => { setData({ ...data, [key]: event.target.value }); setError('') }} disabled={mutation.isPending} /></Field>)}
      {error && <p className="campaign-note" data-tone="danger" role="alert">{error}</p>}
      <div className="cluster campaign-dialog-actions"><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" loading={mutation.isPending}>Send test</Button></div>
    </form>}
  </Dialog>
}

export function CampaignReviewPage() {
  const { id = '' } = useParams()
  const query = useApiQuery(['campaign', id], (api, signal) => api.campaigns.get(id, signal), { interval: campaignPollInterval })
  // The polled review learns of a finished or paused send before the cached Campaigns list does.
  useRefreshListsOnChange('campaigns', query.data?.status)
  if (query.isPending) return <CampaignRouteSkeleton kind="review" />
  if (!query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  return <CampaignReview key={id} campaign={query.data} stale={query.isError} refreshing={query.isFetching} refresh={() => void query.refetch()} />
}

// The server renders block HTML into the styled email; the review shows that rendering, not the blocks.
function CampaignRenderedPreview({ campaign, transform = html => html }: { campaign: Campaign; transform?: (html: string) => string }) {
  const preview = useApiQuery(['campaign-preview', campaign.id, campaign.revision], (api, signal) => api.campaigns.preview(campaign.id, signal))
  if (preview.isPending) return <div className="ui-email-preview campaign-preview-loading" role="status"><SkeletonText width="55%" lineHeight={28} /><SkeletonText /><SkeletonText width="80%" /></div>
  if (preview.isError) return <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
  return <EmailPreview html={transform(preview.data.html)} title="Campaign email preview" attachmentIds={campaign.attachments} respectStyles remoteImages />
}
// A schedule that has released nobody yet can still move or go back to a draft.
const unreleasedSchedule = (campaign: Campaign) => Boolean(campaign.scheduledAt) && ['preparing', 'scheduled', 'paused'].includes(campaign.status) && (campaign.delivery?.expanded ?? 0) === 0
const sampleValue = (key: string) => key === 'email' ? 'sam@example.com' : key === 'name' ? 'Sam Example' : key === 'firstName' ? 'Sam' : `[${key}]`
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

function useCampaignCache() {
  const cache = useQueryClient()
  return (next: Campaign) => { cache.setQueryData(['nightmail', 'campaign', next.id], next); void cache.invalidateQueries({ queryKey: ['nightmail', 'campaigns'], refetchType: 'none' }) }
}

function ScheduledBanner({ campaign }: { campaign: Campaign }) {
  const api = useApi()
  const navigate = useNavigate()
  const toast = useToast()
  const accept = useCampaignCache()
  const { canAdminister } = useWorkspaceAccess()
  const [dialog, setDialog] = useState<'reschedule' | 'edit' | 'unschedule' | null>(null)
  const at = campaign.scheduledAt!
  const total = campaign.delivery?.total ?? campaign.recipients
  async function unschedule(edit: boolean) {
    accept(await api.campaigns.unschedule(campaign.id))
    toast(edit ? 'Unscheduled. Schedule it again after editing.' : 'Unscheduled. The campaign is a draft again.', 'success')
    if (edit) navigate(campaignRoute(campaign, 'edit'))
  }
  const blocked = canAdminister ? undefined : 'Only owners and admins can change a schedule.'
  return <>
    <div className="campaign-scheduled" role="status">
      <div className="campaign-scheduled__text"><strong>Scheduled for {utcLabel(at)}</strong><span className="muted">{localLabel(at)} · {number(total)} {total === 1 ? 'recipient' : 'recipients'}</span></div>
      <div className="cluster"><Button size="sm" disabled={!canAdminister} title={blocked} onClick={() => setDialog('reschedule')}>Reschedule</Button><Button size="sm" disabled={!canAdminister} title={blocked ?? 'Unschedules it so you can edit; schedule it again afterwards'} onClick={() => setDialog('edit')}>Edit</Button><Button size="sm" variant="ghost" disabled={!canAdminister} title={blocked} onClick={() => setDialog('unschedule')}>Unschedule</Button></div>
    </div>
    <ConfirmDialog open={dialog === 'edit'} onOpenChange={open => setDialog(open ? 'edit' : null)} title="Edit this campaign?" description="Editing turns it back into a draft. Schedule it again when you’re done." confirmLabel="Unschedule and edit" onConfirm={() => unschedule(true)} />
    <ConfirmDialog open={dialog === 'unschedule'} onOpenChange={open => setDialog(open ? 'unschedule' : null)} title="Unschedule this campaign?" description="It becomes a draft again and won’t send." confirmLabel="Unschedule" onConfirm={() => unschedule(false)} />
    {dialog === 'reschedule' && <RescheduleDialog campaign={campaign} onClose={() => setDialog(null)} />}
  </>
}

function RescheduleDialog({ campaign, onClose }: { campaign: Campaign; onClose: () => void }) {
  const api = useApi()
  const toast = useToast()
  const accept = useCampaignCache()
  const [value, setValue] = useState(() => campaign.scheduledAt!.slice(0, 16))
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  // Single flight: a second Reschedule before the first answers would send the same change again.
  const reschedule = useSingleFlight('campaigns.reschedule', async (at: string) => {
    setPending(true)
    try { const next = await api.campaigns.reschedule(campaign.id, at); accept(next); toast(`Rescheduled for ${utcLabel(next.scheduledAt!)}`, 'success'); onClose() }
    catch (cause) { setError(errorText(cause)) }
    finally { setPending(false) }
  }, campaign.id)
  function submit(event: FormEvent) {
    event.preventDefault()
    const problem = scheduleError(value)
    if (problem) { setError(problem); return }
    void reschedule(parseUtc(value)!.toISOString())
  }
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }} title="Reschedule campaign">
    <form className="stack" onSubmit={submit} noValidate>
      <ScheduleField id="campaign-reschedule" value={value} onChange={next => { setValue(next); setError('') }} error={error} disabled={pending} />
      <div className="cluster campaign-dialog-actions"><Button type="button" disabled={pending} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" loading={pending}>Reschedule</Button></div>
    </form>
  </Dialog>
}

// Stops a campaign that is sending, paused or failed after releasing some recipients; emails already sent stay sent.
function CancelCampaignButton({ campaign }: { campaign: Campaign }) {
  const api = useApi()
  const toast = useToast()
  const cache = useQueryClient()
  const { canAdminister } = useWorkspaceAccess()
  const [open, setOpen] = useState(false)
  return <>
    <Button variant="ghost" disabled={!canAdminister} title={canAdminister ? 'Stop releasing recipients and cancel queued emails' : 'Only owners and admins can cancel campaigns.'} onClick={() => setOpen(true)}>Cancel campaign</Button>
    <ConfirmDialog open={open} onOpenChange={setOpen} danger title="Cancel this campaign?" description="Queued emails are canceled and remaining recipients won’t get it. Sent emails stay sent. You can’t undo this." confirmLabel="Cancel campaign" onConfirm={async () => { const result = await api.campaigns.cancel(campaign.id); toast(`Campaign canceled · ${number(result.canceled)} not sent`, 'success'); await cache.invalidateQueries({ queryKey: ['nightmail', 'campaign', campaign.id] }); void cache.invalidateQueries({ queryKey: ['nightmail', 'campaigns'], refetchType: 'none' }) }} />
  </>
}

type ReviewRowId = 'to' | 'message' | 'score' | 'when'
// A Review row: one line that says what is set (who, what, when), opening in place to change it.
function ReviewRow({ id, label, icon, summary, open, onToggle, disabled = false, children }: { id: ReviewRowId; label: string; icon: ReactNode; summary: ReactNode; open: boolean; onToggle: () => void; disabled?: boolean; children: ReactNode }) {
  return <section className="review-row" data-open={open || undefined} aria-label={label}>
    <button type="button" className="review-row__head" aria-expanded={open} aria-controls={`review-${id}`} disabled={disabled} onClick={onToggle}>
      <span className="review-row__icon" aria-hidden="true">{icon}</span>
      <span className="review-row__summary">{summary}</span>
      {!disabled && <ChevronDown size={16} className="review-row__chevron" aria-hidden="true" />}
    </button>
    <div id={`review-${id}`} className="review-row__body" inert={!open} aria-hidden={!open}><div><div className="review-row__inner">{children}</div></div></div>
  </section>
}

// The Review step's recipient list and segment: choosing one saves the draft, and the counts under it follow.
function AudiencePicker({ campaign, disabled }: { campaign: Campaign; disabled?: boolean }) {
  const api = useApi()
  const toast = useToast()
  const accept = useCampaignCache()
  const [cursor, setCursor] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const options = useApiQuery(['campaign-audience-options', cursor ?? ''], async (api, signal) => {
    const [listPage, segmentPage] = await Promise.all([api.lists.list({ pageSize: 100, cursor, counts: false }, signal), api.segments.list({ pageSize: 100 }, signal)])
    return { lists: [...listPage.items].sort((a, b) => a.name.localeCompare(b.name)), segments: [...segmentPage.items].sort((a, b) => a.name.localeCompare(b.name)), next: listPage.nextCursor }
  })
  const lists = options.data?.lists ?? [], segments = options.data?.segments ?? []
  // The chosen list or segment may not be on the loaded page: read its name, so it never shows as an ID.
  const listMissing = Boolean(campaign.listId) && !options.isPending && !lists.some(list => list.id === campaign.listId)
  const segmentMissing = Boolean(campaign.segmentId) && !options.isPending && !segments.some(segment => segment.id === campaign.segmentId)
  const chosenList = useApiQuery(['lists', campaign.listId], (api, signal) => api.lists.get(campaign.listId, signal), { enabled: listMissing })
  const chosenSegment = useApiQuery(['segments', campaign.segmentId ?? ''], (api, signal) => api.segments.get(campaign.segmentId!, signal), { enabled: segmentMissing })
  async function choose(listId: string, segmentId: string | null) {
    if (saving || (listId === campaign.listId && segmentId === (campaign.segmentId ?? null))) return
    setSaving(true)
    try { accept(await api.campaigns.save({ ...campaignInput(campaign), listId, segmentId })) }
    catch (cause) { toast(errorText(cause), 'error') }
    finally { setSaving(false) }
  }
  const off = disabled || saving || options.isPending
  return <div className="campaign-audience-picker">
    <Field label="List" htmlFor="campaign-list"><Select id="campaign-list" aria-label="Recipient list" disabled={off} value={campaign.listId} onValueChange={value => void choose(value, campaign.segmentId ?? null)} options={options.isPending ? [{ value: campaign.listId, label: 'Loading lists…', disabled: true }] : lists.length ? [{ value: '', label: 'Choose a list' }, ...(listMissing ? [{ value: campaign.listId, label: chosenList.data?.name ?? (chosenList.isError ? 'List not found' : 'Loading list…') }] : []), ...lists.map(list => ({ value: list.id, label: list.name }))] : [{ value: '', label: 'No lists yet. Create one in Audience.', disabled: true }]} /></Field>
    {(cursor || options.data?.next) && <div className="cluster"><Button onClick={() => setCursor(undefined)}>First lists</Button><Button disabled={!options.data?.next} onClick={() => setCursor(options.data?.next ?? undefined)}>More lists</Button></div>}
    <Field label="Segment" htmlFor="campaign-segment"><Select id="campaign-segment" aria-label="Segment" disabled={off || !campaign.listId} value={campaign.segmentId ?? ''} onValueChange={value => void choose(campaign.listId, value || null)} options={[{ value: '', label: 'Everyone on the list' }, ...(campaign.segmentId && segmentMissing ? [{ value: campaign.segmentId, label: chosenSegment.data?.name ? `Only ${chosenSegment.data.name}` : chosenSegment.isError ? 'Segment not found' : 'Loading segment…' }] : []), ...segments.map(segment => ({ value: segment.id, label: `Only ${segment.name}` })), ...(!options.isPending && !segments.length ? [{ value: '__none', label: 'No segments yet. Create one in Audience.', disabled: true }] : [])]} /></Field>
  </div>
}

// Where the campaign goes: the list (and segment) by name, never by id.
function AudienceSource({ listId, segmentId }: { listId: string; segmentId: string | null }) {
  const list = useApiQuery(['lists', listId], (api, signal) => api.lists.get(listId, signal), { enabled: Boolean(listId) })
  const segment = useApiQuery(['segments', segmentId ?? ''], (api, signal) => api.segments.get(segmentId!, signal), { enabled: Boolean(segmentId) })
  if (!listId) return <p className="campaign-audience-source muted">No list chosen yet.</p>
  return <p className="campaign-audience-source" title={list.data?.name}>{list.data ? <Link to={`/audience/lists/${encodeURIComponent(listId)}`}>{list.data.name}</Link> : <SkeletonText width={120} />}{segmentId && <span className="muted"> · only {segment.data?.name ?? 'segment'}</span>}</p>
}

function CampaignResults({ campaign }: { campaign: Campaign }) {
  const byStatus = campaign.counts?.byStatus ?? {}
  const total = Math.max(campaign.counts?.total ?? 0, campaign.delivery?.total ?? 0)
  const canceled = (byStatus.canceled ?? 0) + (campaign.delivery?.canceled ?? 0)
  // Simulated sends get their own row, as while sending (CampaignProgress), only when there are some.
  const rows: [string, number, string][] = [
    ['Delivered', byStatus.delivered ?? 0, 'Accepted by the recipient’s mail server'],
    ...((byStatus.simulated ?? 0) > 0 ? [['Simulated', byStatus.simulated ?? 0, ''] as [string, number, string]] : []),
    ['Bounced', byStatus.bounced ?? 0, `Rejected by the recipient’s mail server; ${productName} stops emailing these addresses`],
    ['Complaints', byStatus.complained ?? 0, `Marked as spam; ${productName} stops emailing these addresses`],
    ['Failed', (byStatus.rejected ?? 0) + (byStatus.rendering_failed ?? 0), 'Couldn’t be sent'],
    ['Suppressed', byStatus.suppressed ?? 0, 'Skipped because the address is suppressed'],
    ['Canceled', canceled, 'Never sent because the campaign was canceled'],
  ]
  return <div className="campaign-audience-summary">
    <div className="campaign-summary-line"><strong>Recipients</strong><span>{number(total)}</span></div>
    {rows.map(([label, count, hint]) => <div className="campaign-summary-line" key={label} title={hint || undefined}><span>{label}</span><span>{number(count)}</span></div>)}
  </div>
}

function CampaignReview({ campaign, stale, refreshing, refresh }: { campaign: Campaign; stale: boolean; refreshing: boolean; refresh: () => void }) {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
  const [scheduled, setScheduled] = useState('')
  const [error, setError] = useState('')
  const [scheduleProblem, setScheduleProblem] = useState('')
  const [confirmation, setConfirmation] = useState<SendCampaignInput | null>(null)
  const [testOpen, setTestOpen] = useState(false)
  const [pace, setPace] = useState({ limit: false, perDay: '50000', autoPause: true, share: '100' })
  const [paceToggled, setPaceToggled] = useState(false)
  // One row of the Review step open at a time.
  const [openRow, setOpenRow] = useState<ReviewRowId | null>(null)
  const [seen, setSeen] = useState(() => new Set<ReviewRowId>())
  useEffect(() => { if (openRow && !seen.has(openRow)) setSeen(new Set([...seen, openRow])) }, [openRow, seen])
  const guard = useRef(false)
  const { canAdminister, multiTenant } = useWorkspaceAccess()
  const origin = multiTenant ? '' : ` from ${campaign.regionId}`

  const draft = !campaign.archivedAt && campaignEditable(campaign)
  const readinessError = campaignReadinessError(campaign)
  const fallbacks = campaign.draft?.defaults ?? {}
  const keys = placeholders(campaign.subject, campaign.previewText, campaign.html)
  const missingFallbacks = keys.filter(key => key !== 'email' && (fallbacks[key] === undefined || fallbacks[key] === ''))
  // A live count of the saved audience, read as the page opens; the send freezes its own snapshot.
  const audience = useApiQuery(['campaign-audience', campaign.id, campaign.revision ?? 0], (api, signal) => api.campaigns.audience({ id: campaign.id, listId: campaign.listId, segmentId: campaign.segmentId }, signal), { enabled: draft && Boolean(campaign.listId) })
  const listName = useApiQuery(['lists', campaign.listId], (api, signal) => api.lists.get(campaign.listId, signal), { enabled: Boolean(campaign.listId) }).data?.name
  const segmentName = useApiQuery(['segments', campaign.segmentId ?? ''], (api, signal) => api.segments.get(campaign.segmentId!, signal), { enabled: Boolean(campaign.segmentId) }).data?.name
  const perDay = Number(pace.perDay.trim().replaceAll(',', ''))
  const paceError = pace.limit ? perDayError(perDay) : ''
  const paceDays = pace.limit && !paceError && audience.data?.eligible ? Math.ceil(audience.data.eligible / perDay) : null
  const sharePercent = Number(pace.share.trim())
  const shareError = ratePercentError(sharePercent)
  // A value that needs fixing keeps the fields open.
  const paceOpen = paceToggled || Boolean(paceError || shareError)
  const paceLine = [pace.limit && `${number(perDay)} per day`, `${pace.share.trim()}% speed`, !multiTenant && (pace.autoPause ? 'auto-pause on' : 'auto-pause off')].filter(Boolean).join(' · ')
  const paceSummary = (input: SendCampaignInput | null) => !input?.pacing ? '' : `${input.pacing.perDay ? ` Sends to up to ${number(input.pacing.perDay)} recipients per day${paceDays ? ` (about ${paceDays} ${paceDays === 1 ? 'day' : 'days'})` : ''}.` : ''}${input.pacing.rateShare != null && input.pacing.rateShare < 1 ? ` Uses at most ${Math.round(input.pacing.rateShare * 100)}% of your sending speed.` : ''}${input.pacing.autoPause === false ? ' Auto-pause on high bounces or complaints is off.' : ''}`
  const toast = useToast()
  const sendMutation = useApiMutation((api, input: SendCampaignInput) => api.campaigns.send(input))
  // Every campaign footer carries the workspace's postal address, so Send and Schedule ask for it first when it is
  // missing, then go on: to the confirmation, or straight to sending when the API asked after it was confirmed.
  const settings = useApiDef(queries.workspaceSettings(), { enabled: draft && canAdminister })
  const [addressFor, setAddressFor] = useState<{ input: SendCampaignInput; confirmed: boolean } | null>(null)
  const recipients = audience.data ? `${number(audience.data.eligible)} eligible ${audience.data.eligible === 1 ? 'recipient' : 'recipients'}` : 'the eligible recipients'
  const audienceName = `${listName ? ` in ${listName}` : ''}`
  // Hosted and enforced: what the send costs beyond the free allowance, against the balance, read while the page opens.
  const billing = useApiDef(queries.billing(), { enabled: draft && multiTenant && canAdminister }).data
  const cost = billing && billing.enforcement === 'enforce' && billing.mode === 'prepaid' && billing.balance && audience.data ? (() => {
    const beyond = Math.max(0, audience.data.eligible - billing.free.sent.left), uc = BigInt(beyond) * priceUc(billing.prices.emailPerThousand) / 1000n
    return ` Estimated cost ${usd(uc)} (${number(beyond)} ${beyond === 1 ? 'recipient' : 'recipients'} beyond your free sends). Balance ${usd(total(billing.balance))}.${BigInt(billing.balance.available) < uc ? ' The campaign pauses when the balance runs out and resumes after you add credit.' : ''}`
  })() : ''
  function requestConfirmation() {
    if (!draft || sendMutation.isPending) return
    if (readinessError) { setError(readinessError); return }
    setError('')
    if (audience.data && audience.data.eligible < 1) { setError(nobodyEligible); return }
    if (paceError) { setError(`Recipients per day: ${paceError}`); return }
    if (shareError) { setError(`Sending speed limit: ${shareError}`); return }
    const input: SendCampaignInput = { id: campaign.id, mode, revision: campaign.revision }
    // Defaults (no daily limit, auto-pause on, full send rate) need no pacing object.
    if (pace.limit || !pace.autoPause || sharePercent < 100) input.pacing = { perDay: pace.limit ? perDay : null, autoPause: pace.autoPause, rateShare: sharePercent / 100 }
    if (mode === 'schedule') {
      // datetime-local has no offset: this field is explicitly UTC, never the browser's local zone.
      const problem = scheduleError(scheduled)
      if (problem) { setScheduleProblem(problem); return }
      input.scheduledAt = parseUtc(scheduled)!.toISOString()
    }
    if (settings.data && !settings.data.postalAddress) { setAddressFor({ input, confirmed: false }); return }
    setConfirmation(input)
  }
  async function send(input: SendCampaignInput) {
    if (!draft || guard.current || sendMutation.isPending) return
    if (readinessError) { setError(readinessError); setConfirmation(null); return }
    guard.current = true
    setError('')
    try { const result = await sendMutation.mutateAsync(input); if ('queued' in result && !result.scheduledAt) toast(`Sending started · ${number(result.queued)} ${result.queued === 1 ? 'recipient' : 'recipients'}${result.simulated ? ' · simulated' : ''}`, 'success'); setConfirmation(null) }
    catch (cause) {
      setConfirmation(null)
      if (cause instanceof ApiError && cause.code === 'POSTAL_ADDRESS_REQUIRED') setAddressFor({ input, confirmed: true })
      else setError(errorText(cause))
    }
    finally { guard.current = false }
  }
  const confirmSend = () => confirmation ? send(confirmation) : undefined
  const scheduledView = !draft && !campaign.archivedAt && unreleasedSchedule(campaign)
  const sentSomething = (campaign.counts?.total ?? 0) > 0
  const finished = ['done', 'canceled'].includes(campaign.status) || (campaign.status === 'failed' && !campaignResumable(campaign))
  const cancellable = !draft && !campaign.archivedAt && !scheduledView && (['preparing', 'sending', 'paused'].includes(campaign.status) || campaignResumable(campaign))
  const sendability = useSendability(draft && !readinessError ? { kind: 'campaign', id: campaign.id, revision: campaign.revision ?? 0 } : null)
  const lowScore = Boolean(sendability.data && sendability.data.score < LOW_SENDABILITY)
  const scoreNote = lowScore ? ` Its sendability score is ${sendability.data!.score} of 100.` : ''
  const previewHtml = (html: string) => keys.length ? html.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, key: string) => escapeHtml(fallbacks[key] ? String(fallbacks[key]) : sampleValue(key))) : html
  // What the Write step still needs, each named, and what this step needs: shown under the send button.
  const missing = [!campaign.name.trim() && 'a name', !campaign.subject.trim() && 'a subject', !emailIsValid(campaign.fromEmail.trim()) && 'a sender', !campaign.html.trim() && 'content'].filter(Boolean) as string[]
  const writeLink = <Link to={campaignRoute(campaign, 'edit')}>Write</Link>
  const notes: ['neutral' | 'warning' | 'danger', ReactNode][] = !draft ? [] : [
    ...(missing.length ? [['neutral', <>Add {missing.join(', ').replace(/, ([^,]*)$/, ' and $1')} in {writeLink}.</>] as ['neutral', ReactNode]] : []),
    ...(missingFallbacks.length ? [['warning', <>{missingFallbacks.map(key => `{{${key}}}`).join(', ')} {missingFallbacks.length === 1 ? 'needs' : 'need'} a fallback in {writeLink}, or contacts without a value stop the send.</>] as ['warning', ReactNode]] : []),
    ...(!canAdminister ? [['neutral', 'Only owners and admins can send or schedule campaigns.'] as ['neutral', ReactNode]] : []),
    ...(error ? [['danger', error] as ['danger', ReactNode]] : []),
  ]
  const bar = <CampaignBar back={campaign.archivedAt ? '/campaigns?archived=true' : '/campaigns'} title={<h1 className="studio-title">{campaign.name}</h1>} steps={draft && <CampaignSteps step="review" writeTo={campaignRoute(campaign, 'edit')} />} actions={<>{stale && <span className="campaign-note" data-tone="warning" title="Showing the last available counts.">Couldn’t refresh</span>}{!campaignEditable(campaign) && (sentSomething ? <Link className="ui-button ui-button--secondary ui-button--md" to={`/logs?campaign=${encodeURIComponent(campaign.id)}`}>View logs</Link> : <Button disabled title="Each email appears in Logs once sending starts">View logs</Button>)}<StatusBadge status={campaignDisplayStatus(campaign)} />{campaign.archivedAt && <CampaignArchiveButton campaign={campaign} />}</>} />
  const dialogs = <>
    <ConfirmDialog open={confirmation !== null} onOpenChange={open => { if (!open && !sendMutation.isPending) setConfirmation(null) }} title={confirmation?.mode === 'schedule' ? 'Schedule this campaign?' : 'Send this campaign now?'} description={confirmation?.mode === 'schedule' ? `Send “${campaign.name}”${origin} to ${recipients}${audienceName} on ${utcLabel(confirmation.scheduledAt!)} (${localLabel(confirmation.scheduledAt!)}).${paceSummary(confirmation)}${cost}${scoreNote} You can change this until sending starts.` : `Send “${campaign.name}”${origin} to ${recipients}${audienceName} now.${paceSummary(confirmation)}${cost} Consent is checked again as each email sends.${scoreNote} You can’t undo this.`} confirmLabel={confirmation?.mode === 'schedule' ? 'Schedule' : 'Send now'} onConfirm={confirmSend} pending={sendMutation.isPending} />
    {draft && testOpen && <TestEmailDialog campaign={campaign} open={testOpen} onOpenChange={setTestOpen} />}
    {addressFor && <PostalAddressDialog open onOpenChange={open => { if (!open) setAddressFor(null) }} initial={null} required title="Add your postal address" submitLabel="Continue"
      onSaved={() => { if (addressFor.confirmed) void send(addressFor.input); else setConfirmation(addressFor.input) }} />}
  </>
  if (draft) {
    const toggle = (row: ReviewRowId) => setOpenRow(openRow === row ? null : row)
    const eligible = audience.data?.eligible ?? 0
    const segmentLabel = segmentName ? ` · only ${segmentName}` : ''
    const toSummary = !campaign.listId ? <span className="review-cta">Choose who gets it</span>
      : !audience.data ? <><strong>{listName ?? 'Your list'}</strong><span className="muted">{audience.isError ? 'Couldn’t count' : 'Counting…'}</span></>
      : eligible ? <><strong>{number(eligible)} {eligible === 1 ? 'contact' : 'contacts'}</strong><span className="muted">in {listName}{segmentLabel}</span></>
      : <><strong>{listName}{segmentLabel}</strong><span className="review-warn">Nobody can receive it yet</span></>
    const fixes = sendability.data ? topFixes(sendability.data) : []
    const sendabilitySummary = !sendability.data ? <span className="muted">{missing.length ? 'Checked once the message is complete' : !campaign.listId ? 'Checked once you choose a list' : 'Checking…'}</span>
      : <><strong>Sendability {sendability.data.score}</strong><span className={lowScore ? 'review-warn' : 'muted'}>{fixes.length ? `${fixes.length} ${fixes.length === 1 ? 'suggestion' : 'suggestions'}` : 'Looks good'}</span></>
    const scheduledAt = mode === 'schedule' && scheduled && !scheduleError(scheduled) ? parseUtc(scheduled)!.toISOString() : null
    const paced = pace.limit || sharePercent < 100 || !pace.autoPause
    const whenSummary = mode === 'now' ? <><strong>Right now</strong>{paced && <span className="muted">{paceLine}</span>}</> : scheduledAt ? <><strong>{utcLabel(scheduledAt)}</strong><span className="muted">{localLabel(scheduledAt)}</span></> : <span className="muted">Pick a time</span>
    return <div className="campaign-review">
      {bar}
      <div className="review-flow">
        <ReviewRow id="to" label="Recipients" icon={<UsersRound size={16} />} open={openRow === 'to'} onToggle={() => toggle('to')} summary={toSummary}>
          <AudiencePicker campaign={campaign} disabled={sendMutation.isPending} />
          {audience.data && campaign.listId && <p className="review-detail">{number(audience.data.matched)} on the list{audience.data.suppressed ? ` · ${number(audience.data.suppressed)} suppressed` : ''}{audience.data.unsubscribed ? <> · {number(audience.data.unsubscribed)} not subscribed · <Link to={`/audience/lists/${encodeURIComponent(campaign.listId)}?status=unknown`}>Fix</Link></> : null}</p>}
        </ReviewRow>
        <ReviewRow id="message" label="Message" icon={<Mail size={16} />} open={openRow === 'message'} onToggle={() => toggle('message')} summary={campaign.subject ? <strong>{campaign.subject}</strong> : <span className="muted">No subject yet</span>}>
          <p className="review-detail">From {campaign.fromEmail ? <NamedAddress name={campaign.fromName} address={campaign.fromEmail} /> : 'no sender yet'}</p>
          <div className="review-actions"><Link className="ui-button ui-button--secondary ui-button--sm" to={`${campaignRoute(campaign, 'edit')}#message`}>Edit</Link><Button size="sm" disabled={!campaignMessageReady(campaign)} onClick={() => setTestOpen(true)}>Send test</Button></div>
          {seen.has('message') && <CampaignRenderedPreview campaign={campaign} transform={previewHtml} />}
        </ReviewRow>
        <ReviewRow id="score" label="Sendability" icon={<Gauge size={16} />} open={openRow === 'score'} onToggle={() => toggle('score')} disabled={!fixes.length} summary={sendabilitySummary}>
          <ol className="review-fixes">{fixes.map(finding => <li key={finding.ruleId}>{finding.fix}</li>)}</ol>
        </ReviewRow>
        <ReviewRow id="when" label="When" icon={<Clock size={16} />} open={openRow === 'when'} onToggle={() => toggle('when')} summary={whenSummary}>
          <Tabs value={mode} onValueChange={value => { if (!sendMutation.isPending) { setMode(value as 'now' | 'schedule'); setError(''); setScheduleProblem('') } }} items={[{ value: 'now', label: 'Send now' }, { value: 'schedule', label: 'Schedule' }]} />
          {mode === 'schedule' && <ScheduleField id="campaign-schedule" value={scheduled} onChange={value => { setScheduled(value); setScheduleProblem(''); setError('') }} error={scheduleProblem} disabled={sendMutation.isPending} />}
          <div className="campaign-pacing-options" role="group" aria-labelledby="campaign-pacing-label">
            <div className="campaign-pacing-head"><Button id="campaign-pacing-label" variant="ghost" size="sm" className="campaign-pacing-toggle" aria-expanded={paceOpen} aria-controls="campaign-pacing-fields" onClick={() => setPaceToggled(!paceOpen)}><ChevronRight size={14} aria-hidden="true" />Pace sending</Button></div>
            {paceOpen && <div id="campaign-pacing-fields" className="campaign-pacing-fields">
              <Checkbox label="Limit recipients per day" checked={pace.limit} disabled={sendMutation.isPending} onCheckedChange={limit => { setPace({ ...pace, limit }); setError('') }} />
              {pace.limit && <Field label="Recipients per day" htmlFor="campaign-per-day" error={paceError}><Input id="campaign-per-day" type="number" inputMode="numeric" min={minPerDay} max={maxPerDay} step={1} value={pace.perDay} onChange={event => { setPace({ ...pace, perDay: event.target.value }); setError('') }} disabled={sendMutation.isPending} /></Field>}
              <Field label="Sending speed limit (%)" htmlFor="campaign-rate-share" error={shareError}><Input id="campaign-rate-share" type="number" inputMode="numeric" min={minRatePercent} max={maxRatePercent} step={1} value={pace.share} onChange={event => { setPace({ ...pace, share: event.target.value }); setError('') }} disabled={sendMutation.isPending} /></Field>
              {/* Hosted always pauses on high bounces or complaints. */}
              {!multiTenant && <Checkbox label="Pause automatically on high bounces or complaints" checked={pace.autoPause} disabled={sendMutation.isPending} onCheckedChange={autoPause => setPace({ ...pace, autoPause })} />}
            </div>}
          </div>
        </ReviewRow>
        <div className="review-send">
          <Button variant="primary" className="review-send__button" loading={sendMutation.isPending} disabled={!canAdminister || Boolean(readinessError) || Boolean(audience.data && !audience.data.eligible)} onClick={requestConfirmation} data-analytics={mode === 'schedule' ? 'campaigns/schedule' : 'campaigns/send'}>{mode === 'schedule' ? 'Schedule' : eligible ? `Send to ${number(eligible)} ${eligible === 1 ? 'contact' : 'contacts'}` : 'Send now'}</Button>
          {/* What stops the send and isn't shown in a row above: one line each, under the button. */}
          {notes.length > 0 && <ul className="campaign-notes">{notes.map(([tone, text], index) => <li key={index} className="campaign-note" data-tone={tone} role={tone === 'danger' ? 'alert' : undefined}><span>{text}</span></li>)}</ul>}
        </div>
      </div>
      {dialogs}
    </div>
  }
  return <div className="campaign-review">
    {bar}
    <div className="campaign-review__body stack">
    {scheduledView && <ScheduledBanner campaign={campaign} />}
    <div className="campaign-review-layout">
      <section className="campaign-fields campaign-recipients">
        {campaign.delivery?.error && <p className="campaign-note" data-tone="danger" role="alert">{campaign.delivery.error.message}</p>}
        <SectionHeader title={scheduledView ? 'Recipients' : 'Delivery'} actions={<div className="cluster">{cancellable && <CancelCampaignButton campaign={campaign} />}<Button variant="secondary" size="sm" onClick={refresh} disabled={refreshing} title="This page also updates by itself">Refresh</Button></div>} />
        {/* Eligible recipients is matched contacts less the suppressed and not subscribed lines under it. */}
        {<>
          {scheduledView ? <div className="campaign-audience-summary">
            <div className="campaign-summary-line"><span>Recipients, frozen when scheduled</span><span>{number(campaign.delivery?.total ?? campaign.recipients)}</span></div>
            <AudienceSource listId={campaign.listId} segmentId={campaign.segmentId} />
          </div> : <>
            <AudienceSource listId={campaign.listId} segmentId={campaign.segmentId} />
            <CampaignPacing key={`${campaign.id}:${campaign.delivery?.pacing?.perDay ?? ''}:${campaign.delivery?.pacing?.autoPause ?? ''}:${campaign.delivery?.pacing?.rateShare ?? ''}`} campaign={campaign} />
            {finished ? <CampaignResults campaign={campaign} /> : campaign.counts ? <CampaignProgress campaign={campaign} /> : <div className="campaign-audience-summary"><div className="campaign-summary-line"><span>Recipients</span><span>{number(campaign.recipients)}</span></div></div>}
          </>}
          {scheduledView && <CampaignPacing key={`${campaign.id}:paused`} campaign={campaign} />}
        </>}
      </section>
      <section className="campaign-fields campaign-message">
        <SectionHeader title="Message" />
        <dl className="ui-facts campaign-message-details"><dt>From</dt><dd><NamedAddress name={campaign.fromName} address={campaign.fromEmail} /></dd>{campaign.replyTo.length > 0 && <><dt>Reply to</dt><dd><AddressList values={campaign.replyTo} /></dd></>}<dt>Subject</dt><dd>{campaign.subject}</dd>{campaign.previewText && <><dt>Inbox preview</dt><dd>{campaign.previewText}</dd></>}</dl>
        <CampaignRenderedPreview campaign={campaign} transform={previewHtml} />
      </section>
    </div>
    </div>
    {dialogs}
  </div>
}
