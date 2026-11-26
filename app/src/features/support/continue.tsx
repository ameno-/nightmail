import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Button, Dialog, SkeletonText } from '../../components/ui'
import { useSession } from '../../data/context'
import { supportApi, type SupportPendingEmail } from '../../data/support'
import { ApiError } from '../../data/types'
import { date } from '../../lib/format'
import { productName } from '../../../../api/src/brand'
import './continue.css'

// /support/continue/<conversation>/<message>: the link in the support reply to one email that didn't prove who sent it.
// The page first shows which email it is (its subject and when it arrived, never its content: GET
// /v1/support-conversations/{id}/claim), with the same checks as confirming it. The person then confirms that email,
// signed in (POST …/claim): Nightmail answers it when their verified address, a mailbox they proved, is the one that
// wrote, and support answers that one email, once. Anyone else's account gets "another account". The page is public
// (data/context.tsx isPublicPath): someone signed in without a workspace has no dashboard but can confirm, and someone
// signed out signs in from here.
//
// A sign-in that proves no mailbox (GitHub, say) gets 403 MAILBOX_SIGN_IN_REQUIRED, which names the address the email came
// from (masked) and the way through: one press emails a sign-in link there (POST …/sign-in-link), never anywhere else.
// The link opens this page again with ?link=…, which signs in at once, the account service showing its chooser; the
// sign-in proves the mailbox when its account's address is the one the link went to (api/src/account-login.ts), and the
// page, back in this tab, confirms the email without another press. Another account signed in here stays signed in.
//
// Every state keeps the same box: one title line, a text that fits its reserved lines, the email's two lines (reserved
// while it loads, and kept empty where there is none) and one button of one width, so the dialog never moves.

type State = 'loading' | 'ready' | 'claimed' | 'other' | 'limit' | 'signin' | 'mailbox' | 'sent' | 'links' | 'link' | 'invalid' | 'failed'
const CONVERSATION = /^conv_[a-z2-7]{26}$/, MESSAGE = /^msg_[0-9a-f]{32}$/, LINK = /^[\w-]{24}\.[\w-]{43}$/
type Copy = { title: string; text: string | ((address: string) => string); action: string }
const READY: Copy = { title: 'Continue your support email', text: 'Confirm you wrote this email. Support then reads your account to answer it, by email.', action: 'Continue' }
const COPY: Record<State, Copy> = {
  loading: READY,
  ready: READY,
  claimed: { title: 'Your email will be answered', text: 'The reply goes to your account’s email address.', action: 'Done' },
  other: { title: 'This link is for another account', text: 'Sign in with the account for the address you wrote from.', action: 'Done' },
  limit: { title: 'Too many open conversations', text: 'Try again once an earlier support conversation ends.', action: 'Done' },
  signin: { title: 'Sign in to continue', text: 'Use the account for the address you wrote from.', action: 'Sign in' },
  mailbox: { title: 'Sign in with an emailed link', text: address => `Your sign-in doesn’t prove you read ${address}, the address this email came from.`, action: 'Email me a sign-in link' },
  sent: { title: 'Check your inbox', text: address => `Look for a sign-in link at ${address}. It works once, for 30 minutes.`, action: 'Done' },
  links: { title: 'Too many sign-in links', text: 'Use a link already in your inbox, or try again later.', action: 'Done' },
  link: { title: 'Sign in to continue', text: 'Choose the account for the address you wrote from. The link works once.', action: 'Sign in' },
  invalid: { title: 'This link doesn’t work', text: 'Open the link from the support email again.', action: 'Done' },
  failed: { title: 'Couldn’t continue your email', text: 'Try again in a moment.', action: 'Try again' },
}
/** The address a 403 MAILBOX_SIGN_IN_REQUIRED names, with its way through (error.details[0]); null without one. */
const mailboxAddress = (error: unknown) => { const address = error instanceof ApiError && error.code === 'MAILBOX_SIGN_IN_REQUIRED' ? error.details?.[0]?.address : null; return typeof address === 'string' ? address : null }
const outcome = (error: unknown): State => !(error instanceof ApiError) ? 'failed'
  : error.status === 404 ? 'other' : error.status === 429 ? 'limit' : error.status === 401 ? 'signin' : error.code === 'MAILBOX_SIGN_IN_REQUIRED' ? mailboxAddress(error) ? 'mailbox' : 'other' : error.status === 422 ? 'invalid' : 'failed'
/** "Nov 21, 2026 at 14:33 UTC", as the support email names it. */
const received = (at: string) => `${date(at)} at ${date(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC`
// The email this tab is signing in to confirm, set when its emailed link starts the sign-in, read once back here.
const CLAIM_KEY = 'nightmail.support-continue'

export function SupportContinuePage() {
  const { id = '', message: messageId = '' } = useParams()
  const session = useSession(), navigate = useNavigate()
  const valid = CONVERSATION.test(id) && MESSAGE.test(messageId)
  const [linked] = useState(() => valid && LINK.test(new URLSearchParams(window.location.search).get('link') ?? ''))
  const [state, setState] = useState<State>(!valid ? 'invalid' : linked ? 'link' : 'loading')
  const [email, setEmail] = useState<SupportPendingEmail | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  // Back from the sign-in this page's emailed link started, in this tab: the email is confirmed once it shows.
  const [returned] = useState(() => { try { return !linked && sessionStorage.getItem(CLAIM_KEY) === `${id}/${messageId}` } catch { return false } })
  const confirmOnce = useRef(returned)
  useEffect(() => {
    document.title = `Continue your support email · ${productName.toLowerCase()}`
    if (!linked) try { sessionStorage.removeItem(CLAIM_KEY) } catch { /* Nothing was kept. */ }
  }, [])
  function failed(error: unknown) { setAddress(mailboxAddress(error)); setState(outcome(error)) }
  async function load(tries = 3): Promise<void> {
    setState('loading')
    try { setEmail(await supportApi.pending(id, messageId)); setState('ready') }
    catch (error) {
      // The session chose its account while this was in flight (data/live.ts drops that answer): ask again as that account.
      if (error instanceof DOMException && error.name === 'AbortError' && tries > 1) return load(tries - 1)
      failed(error)
    }
  }
  // The emailed link: sign in with the account for its address, back to this page (the link rides in the return URL).
  function follow() {
    try { sessionStorage.setItem(CLAIM_KEY, `${id}/${messageId}`) } catch { /* Then it waits for Continue. */ }
    session?.signIn(undefined, true)
  }
  useEffect(() => { if (!valid) return; if (linked) follow(); else void load() }, [id, messageId])
  // Back to the dashboard, or the homepage for someone without one.
  const leave = () => navigate(session?.identity ? '/overview' : '/', { replace: true })
  async function act() {
    if (state === 'signin') { session?.signIn(); return }
    if (state === 'link') { follow(); return }
    if (state === 'failed' && !email) { await load(); return }
    if (state === 'mailbox') {
      setWorking(true)
      try { setAddress((await supportApi.signInLink(id, messageId)).address); setState('sent') }
      catch (error) { if (error instanceof ApiError && error.status === 429) setState('links'); else failed(error) }
      finally { setWorking(false) }
      return
    }
    if (state !== 'ready' && state !== 'failed') { leave(); return }
    setWorking(true)
    try { await supportApi.claim(id, messageId); setState('claimed') }
    catch (error) { failed(error) }
    finally { setWorking(false) }
  }
  useEffect(() => { if (state === 'ready' && confirmOnce.current) { confirmOnce.current = false; void act() } }, [state])
  const copy = COPY[state], shown = email && (state === 'ready' || state === 'claimed' || state === 'failed')
  const text = typeof copy.text === 'string' ? copy.text : copy.text(address ?? 'your address')
  return <main className="support-continue">
    <Dialog open onOpenChange={open => { if (!open && !working) leave() }} analytics="support/continue" title={copy.title}
      description={<span className="support-continue__text">{text}</span>}
      footer={<Button variant="primary" className="support-continue__action" loading={working || state === 'loading' || (state === 'link' && !!session?.signingIn)} onClick={() => void act()}>{copy.action}</Button>}>
      <div className="support-continue__email" data-empty={!shown && state !== 'loading' ? '' : undefined}>
        {state === 'loading' ? <><SkeletonText width="80%" /><SkeletonText width="92%" /><SkeletonText width="65%" /><SkeletonText width="50%" /></>
          : shown ? <>
            <span className="support-continue__subject">{email.subject?.trim() || '(no subject)'}</span>
            <p className="support-continue__preview">{email.preview?.trim() || '(no message text)'}</p>
            <span className="support-continue__received">{email.receivedAt ? `Received ${received(email.receivedAt)}` : 'Received recently'}</span>
          </>
          : null}
      </div>
    </Dialog>
  </main>
}
