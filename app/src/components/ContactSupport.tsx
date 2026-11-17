import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { supportApi, type SupportHandoff } from '../data/support'
import { Button, Checkbox, CopyButton, Dialog, Field, Textarea, MutationError } from './ui'
import { addresses } from '../../../api/src/brand'

const MAX = 2000
// Hosted only: from the workspace menu and Settings → Account. Sends the page and the last failed request IDs with the
// optional message; message content is shared with support only when the person turns it on, only in this workspace and
// only for this request (one grant, opened within 30 minutes).
export function ContactSupportDialog({ onClose }: { onClose: () => void }) {
  const [message, setMessage] = useState('')
  const [shareContent, setShareContent] = useState(false)
  const [done, setDone] = useState<SupportHandoff | null>(null)
  const contact = useMutation({ gcTime: 0, mutationFn: supportApi.contact })
  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      const handoff = await contact.mutateAsync({ shareContent, message: message.trim() || undefined })
      if (handoff.url) window.open(handoff.url, '_blank', 'noopener')
      setDone(handoff)
    } catch { /* Shown in the form. */ }
  }
  const close = () => { if (!contact.isPending) onClose() }
  // The reference and the way to use it: the support page that opened (again, if the browser blocked it), or an email
  // that carries the reference in its subject.
  if (done) return <Dialog open onOpenChange={next => { if (!next) close() }} title={done.url ? 'Support opened in a new tab' : 'Support reference'}
    footer={<Button key="done" variant="primary" autoFocus onClick={close}>Done</Button>}>
    <div className="stack">
      <div className="contact-support__reference"><code>{done.id}</code><CopyButton value={done.id} label="Copy support reference" /></div>
      {done.url
        ? <a className="contact-support__link" href={done.url} target="_blank" rel="noopener noreferrer">Open support<ArrowUpRight size={14} aria-hidden="true" /></a>
        : <a className="contact-support__link" href={`mailto:${addresses.support}?subject=${encodeURIComponent(`Support reference ${done.id}`)}`}>Email support<ArrowUpRight size={14} aria-hidden="true" /></a>}
    </div>
  </Dialog>
  return <Dialog open onOpenChange={next => { if (!next) close() }} title="Contact support"
    footer={<><Button disabled={contact.isPending} onClick={close}>Cancel</Button><Button variant="primary" type="submit" form="contact-support" loading={contact.isPending}>Contact support</Button></>}>
    <form id="contact-support" className="stack" onSubmit={submit}>
      {/* The box stops at MAX characters; reaching it says so. */}
      <Field label="Message" htmlFor="contact-support-message" error={message.length >= MAX ? `${MAX.toLocaleString('en-US')} characters at most.` : undefined}>
        <Textarea id="contact-support-message" value={message} maxLength={MAX} onChange={event => setMessage(event.target.value)} disabled={contact.isPending} placeholder="What were you doing?" autoFocus />
      </Field>
      <div className="contact-support__share">
        <Checkbox label="Share message content with support for this request" checked={shareContent} onCheckedChange={setShareContent} disabled={contact.isPending} aria-describedby="contact-support-share-hint" />
        <div id="contact-support-share-hint" className="ui-field__hint">Lets support read email bodies in this workspace, for this request only.</div>
      </div>
      <MutationError error={contact.error} />
    </form>
  </Dialog>
}
