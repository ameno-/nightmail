import type { Email, EmailEvent } from '../../data/types'
import { date, shortDateTime } from '../../lib/format'

// Why a sent email ended as it did and what happens next, in one sentence under its status: a bounce, a complaint, a
// suppressed address, a refusal and a delay. `said` is the receiving server's own reply, when SES reported one.
export type Reason = { text: string; said?: string }

// What the recipient's server objected to, by SES's bounce subtype.
const refusals: Record<string, string> = {
  NoEmail: 'The address doesn’t exist', Suppressed: 'This address bounced before', OnAccountSuppressionList: 'This address bounced before',
  MailboxFull: 'The recipient’s mailbox is full', MessageTooLarge: 'The email is too large for the recipient’s server',
  ContentRejected: 'The recipient’s server refused the content', AttachmentRejected: 'The recipient’s server refused an attachment',
}
// Why the recipient's server put it off, by SES's delay type.
const delays: Record<string, string> = {
  MailboxFull: 'The recipient’s mailbox is full', SpamDetected: 'The recipient’s server suspects spam',
  RecipientServerError: 'The recipient’s server isn’t answering', TransientCommunicationFailure: 'The recipient’s server isn’t answering',
}
// A refusal before sending, by the email's error code, in the sender's terms: what to change, never how it was judged.
const rejections: Record<string, string> = {
  CONTENT_REJECTED_SPAM: 'The content reads as spam, so it wasn’t sent.',
  CONTENT_IMAGE_ONLY: 'It has images but no text, so it wasn’t sent.',
  CONTENT_TOO_LARGE_TO_SCREEN: 'It’s too long to check, so it wasn’t sent.', CONTENT_SCREEN_BUDGET_EXCEEDED: 'It’s too long to check, so it wasn’t sent.',
  ATTACHMENT_TYPE_UNSCREENABLE: 'An attachment is a file type we can’t send, so it wasn’t sent.', UNSUPPORTED_ATTACHMENT_TYPE: 'An attachment is a file type we can’t send, so it wasn’t sent.',
  ATTACHMENT_CONTENT_MISMATCH: 'An attachment isn’t the file type its name says, so it wasn’t sent.',
  ATTACHMENT_STORAGE_UNAVAILABLE: 'An attachment couldn’t be read, so it wasn’t sent.', ATTACHMENT_NOT_FOUND: 'An attachment couldn’t be read, so it wasn’t sent.',
  ATTACHMENT_LIMIT_EXCEEDED: 'It’s too large, so it wasn’t sent.', ENCODED_MESSAGE_TOO_LARGE: 'It’s too large, so it wasn’t sent.',
  BALANCE_EXHAUSTED: 'The balance ran out, so it wasn’t sent.', SEND_LIMIT_REACHED: 'The workspace had reached its limit, so it wasn’t sent.',
  HOSTED_SENDING_PAUSED: 'Sending was paused, so it wasn’t sent.', SES_TENANT_SENDING_PAUSED: 'Sending was paused, so it wasn’t sent.', SES_ACCOUNT_PAUSE_EXPIRED: 'Sending was paused, so it wasn’t sent.',
  SENDER_DOMAIN_NOT_VERIFIED: 'The sending domain isn’t verified, so it wasn’t sent.',
  SCHEDULE_RELEASE_FAILED: 'It couldn’t be sent at its scheduled time.',
}
// Why an address is skipped, by the email's suppression reason; `on` is the day it was suppressed, when known.
const suppressions: Record<string, (on: string) => string> = {
  hard_bounce: on => `This address bounced${on}, so we no longer send to it.`, soft_bounce: on => `This address bounced${on}, so we no longer send to it.`, transient: on => `This address bounced${on}, so we no longer send to it.`,
  complaint: on => `The recipient marked an email as spam${on}, so we no longer send to them.`,
  email_validation: () => 'This address looks undeliverable, so it wasn’t sent.',
  unsubscribed: () => 'The recipient unsubscribed, so they don’t get marketing email.',
  consent_missing: () => 'The recipient hasn’t agreed to marketing email, so it wasn’t sent.',
  contact_deleted: () => 'This contact was deleted, so it wasn’t sent.',
}

const last = (events: EmailEvent[], ...types: string[]) => [...events].reverse().find(event => types.includes(event.type))
// A date stays on one line: its spaces don't break.
const whole = (text: string) => text.replaceAll(' ', '\u00a0')
const day = (at: string) => whole(date(at, { month: 'short', day: 'numeric', ...(new Date(at).getUTCFullYear() === new Date().getUTCFullYear() ? {} : { year: 'numeric' }), timeZone: 'UTC' }))
const deadline = (at: string) => whole(`${shortDateTime(at)} UTC`)
// The reply without the protocol SES names before it.
const saidBy = (event?: EmailEvent) => event?.diagnostic?.replace(/^smtp;\s*/i, '') || undefined
// "it" for a sentence already about the address.
const again = (why: string) => `${why}, so we won’t send to ${/address/.test(why) ? 'it' : 'this address'} again.`

export function reasonOf(email: Email, events: EmailEvent[]): Reason | null {
  // Whether the address is skipped from now on: as its contact says, or as a permanent bounce or a complaint leaves it.
  const skipped = email.contact ? email.contact.suppressed : true
  if (email.status === 'bounced') {
    const bounce = last(events, 'bounce'), why = refusals[bounce?.detail?.bounceSubType ?? ''] ?? 'The recipient’s server refused it'
    return { text: skipped ? again(why) : `${why}.`, said: saidBy(bounce) }
  }
  if (email.status === 'complained') return { text: skipped ? again('The recipient marked it as spam') : 'The recipient marked it as spam.' }
  if (email.status === 'suppressed') {
    const since = email.contact?.suppressed ? email.contact.suppressedAt : null, at = last(events, 'suppressed', 'validation_suppressed')?.at ?? email.sentAt
    // The day counts only when the address was already suppressed as this email was skipped.
    const on = since && Date.parse(since) <= Date.parse(at) + 1000 ? ` on ${day(since)}` : ''
    return { text: (suppressions[email.suppressionReason ?? ''] ?? (() => 'This address is suppressed, so it wasn’t sent.'))(on) }
  }
  if (email.status === 'rejected') return { text: rejections[email.errorCode ?? ''] ?? 'It was refused before sending, so nothing reached the recipient.' }
  if (email.status === 'delayed') {
    const event = last(events, 'delivery_delay', 'non_permanent_bounce')
    // A soft bounce: SES gave up on this email, and the address stays good.
    if (event?.type === 'non_permanent_bounce') return { text: `${refusals[event.detail?.bounceSubType ?? ''] ?? 'The recipient’s server refused it for now'}, so this email wasn’t delivered; a later one may get through.`, said: saidBy(event) }
    const why = delays[event?.detail?.delayType ?? ''] ?? 'The recipient’s server put it off', until = event?.detail?.retryUntil
    const next = !until ? ', so we keep trying.' : Date.parse(until) > Date.now() ? `, so we keep trying until ${deadline(until)}.` : `, and we tried until ${deadline(until)}.`
    return { text: why + next, said: saidBy(event) }
  }
  return null
}
