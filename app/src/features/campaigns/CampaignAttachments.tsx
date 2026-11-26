import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Image, Paperclip, X } from 'lucide-react'
import { IconButton, SkeletonText, useToast } from '../../components/ui'
import { useApi, useApiQuery } from '../../data/context'
import { errorText, type Attachment, type AttachmentApi } from '../../data/types'
import { attachmentLimit, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from './copy'
import { attachmentKind, cidImageSources, fetchAttachmentMetadata, isRasterType } from './composer-content'
import { fileSize, number } from '../../lib/format'
import './attachments.css'

// Thumbnails read the image itself; larger ones show an icon rather than load megabytes for a 32 px square.
const THUMBNAIL_BYTES = 2 * 1024 * 1024
const useAttachmentApi = (provided?: AttachmentApi) => {
  const api = useApi()
  const attachmentApi = provided ?? api.attachments
  return { attachmentApi, kind: attachmentKind(api, provided) }
}
const useAttachmentMetadata = (ids: string[], provided?: AttachmentApi) => {
  const cache = useQueryClient()
  const { attachmentApi, kind } = useAttachmentApi(provided)
  return useApiQuery(['attachments', kind, ids], async (_api, signal) => Promise.all(ids.map(id => fetchAttachmentMetadata(cache, attachmentApi, kind, id, signal))), { staleTime: Infinity })
}

function Thumbnail({ item, attachmentApi }: { item?: Attachment; attachmentApi?: AttachmentApi }) {
  const { attachmentApi: source, kind } = useAttachmentApi(attachmentApi)
  const image = Boolean(item && isRasterType(item.contentType)), small = Boolean(image && item!.size <= THUMBNAIL_BYTES)
  const content = useApiQuery(['attachment-content', kind, item?.id], (_api, signal) => source.content(item!.id, signal), { enabled: small, staleTime: Infinity })
  const data = content.data && isRasterType(content.data.contentType) ? `data:${content.data.contentType.toLowerCase()};base64,${content.data.content}` : ''
  return <span className="campaign-file-thumb" aria-hidden="true">{data ? <img src={data} alt="" /> : !item || (small && !content.isError) ? null : image ? <Image size={16} /> : <Paperclip size={16} />}</span>
}

// Everything that goes out with the email: images in the body (removed in the body) and files (removed here).
function AttachmentRows({ ids, items, body, attachmentApi, compact, busy, disabled, onRemove }: { ids: string[]; items: (id: string) => Attachment | undefined; body: string; attachmentApi?: AttachmentApi; compact?: boolean; busy?: boolean; disabled?: boolean; onRemove?: (id: string) => void }) {
  const inBody = cidImageSources(body)
  return <ul className="campaign-file-blocks" data-compact={compact || undefined} aria-label="Attachments" aria-busy={busy || undefined}>{ids.map(id => {
    const item = items(id), placed = Boolean(item?.disposition === 'inline' && item.contentId && inBody.has(item.contentId))
    const title = item ? `${item.filename} · ${item.contentType} · ${number(item.size)} bytes` : undefined
    // Review's column is narrow: the name gets its own line, the size and "In body" the line under it.
    if (compact) return <li key={id} title={title}>
      <Thumbnail item={item} attachmentApi={attachmentApi} />
      <span className="campaign-file-text">
        <span className="campaign-file-name">{item ? item.filename : <SkeletonText width="60%" lineHeight={18} />}</span>
        <span className="campaign-file-size" aria-label={item ? `${number(item.size)} bytes${placed ? ', in body' : ''}` : undefined}>{item ? `${fileSize(item.size)}${placed ? ' · In body' : ''}` : ''}</span>
      </span>
    </li>
    return <li key={id} title={title}>
      <Thumbnail item={item} attachmentApi={attachmentApi} />
      <span className="campaign-file-name">{item ? item.filename : <SkeletonText width="45%" />}</span>
      <span className="campaign-file-size" aria-label={item ? `${number(item.size)} bytes` : undefined}>{item ? fileSize(item.size) : ''}</span>
      <span className="campaign-file-end">{placed ? <span className="campaign-file-note">In body</span> : item && onRemove ? <IconButton label={`Remove ${item.filename}`} disabled={busy || disabled} onClick={() => onRemove(id)}><X size={16} aria-hidden="true" /></IconButton> : null}</span>
    </li>
  })}</ul>
}

/** The Review step's read-only list of what goes out with the email. */
export function AttachmentList({ ids, body, attachmentApi }: { ids: string[]; body: string; attachmentApi?: AttachmentApi }) {
  const metadata = useAttachmentMetadata(ids, attachmentApi)
  return <AttachmentRows ids={ids} items={id => metadata.data?.find(item => item.id === id)} body={body} attachmentApi={attachmentApi} compact />
}

export type CampaignAttachmentsRef = { open: () => void }
// shown: the list waits for the composer above it, whose inline images arrive after it opens and would push the list down.
type Props = { ids: string[]; persisted: string[]; body: string; shown: boolean; attachmentApi?: AttachmentApi; onChange: (ids: string[]) => void; onBusy: (busy: boolean) => void; disabled: boolean }

export const CampaignAttachments = forwardRef<CampaignAttachmentsRef, Props>(function CampaignAttachments({ ids, persisted, body, shown, attachmentApi: providedAttachmentApi, onChange, onBusy, disabled }, ref) {
  const { attachmentApi } = useAttachmentApi(providedAttachmentApi)
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const owned = useRef(new Set<string>())
  const known = useRef(new Map<string, Attachment>())
  const [busy, setBusy] = useState(false)
  const metadata = useAttachmentMetadata(ids, providedAttachmentApi)
  useEffect(() => { metadata.data?.forEach(item => known.current.set(item.id, item)) }, [metadata.data])
  useEffect(() => { if (metadata.isError) toast(errorText(metadata.error), 'error') }, [metadata.isError, metadata.error, toast])
  useImperativeHandle(ref, () => ({ open() {
    if (busy || disabled) return
    input.current?.click()
  } }))

  async function upload(file?: File) {
    if (!file || busy || disabled) return
    if (metadata.isPending || metadata.isError) {
      toast(metadata.isError ? 'Couldn’t load attachment sizes. Retrying…' : 'Wait for attachment sizes to load before uploading.', 'error')
      if (metadata.isError) void metadata.refetch()
      return
    }
    if (ids.length >= MAX_ATTACHMENTS || file.size + metadata.data.reduce((sum, item) => sum + item.size, 0) > MAX_ATTACHMENT_BYTES) { toast(attachmentLimit, 'error'); return }
    setBusy(true); onBusy(true)
    try {
      const item = await attachmentApi.upload(file)
      owned.current.add(item.id); known.current.set(item.id, item); onChange([...ids, item.id])
    } catch (cause) { toast(errorText(cause), 'error') }
    finally { setBusy(false); onBusy(false) }
  }
  async function remove(id: string) {
    if (busy || disabled) return
    setBusy(true); onBusy(true)
    try {
      if (owned.current.has(id) && !persisted.includes(id)) { await attachmentApi.remove(id); owned.current.delete(id) }
      onChange(ids.filter(value => value !== id))
    } catch (cause) { toast(errorText(cause), 'error') }
    finally { setBusy(false); onBusy(false) }
  }
  return <>
    {shown && ids.length > 0 && <AttachmentRows ids={ids} items={id => metadata.data?.find(item => item.id === id) ?? known.current.get(id)} body={body} attachmentApi={providedAttachmentApi} busy={busy} disabled={disabled} onRemove={id => void remove(id)} />}
    {busy && <span className="sr-only" role="status">Updating attachments…</span>}
    <input ref={input} type="file" hidden aria-label="Upload attachment" disabled={busy || disabled} onChange={event => { void upload(event.target.files?.[0]); event.currentTarget.value = '' }} />
  </>
})
