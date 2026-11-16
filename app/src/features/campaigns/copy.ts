// Copy and limits said in more than one place in campaigns and templates, so they can't drift apart.
export const MAX_ATTACHMENTS = 20
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
export const attachmentLimit = `Up to ${MAX_ATTACHMENTS} attachments, 8 MiB in total.`
export const composerLoading = 'The composer is still loading. Try again.'
export const invalidSender = 'Enter a valid sender address.'
export const eligibleNote = 'Eligible: subscribed and not suppressed, rechecked as each email sends.'
export const templateIntro = 'Write example content; add personalization like {{name}} in each campaign.'
export const publishFirst = 'Publish this template to start campaigns from it'
