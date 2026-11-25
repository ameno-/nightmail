import { headerPrefix } from './brand.js';

/**
 * Every attachment limit and field rule, in numbers and words, without runtime imports so the agent prompt, the docs and
 * the API's refusals say the same. SEND_LIMITS (send-limits.ts) takes its attachment numbers from here.
 */
const MiB = 1024 * 1024;
export const ATTACHMENT_CAPS = {
  /** Decoded bytes of one email's files together, so also of one file uploaded as raw bytes. */
  attachmentBytes: 25 * MiB,
  /** One file sent as base64 inside JSON. */
  jsonAttachmentBytes: 8 * MiB,
  /** Files per email. */
  attachments: 100,
  /** SES's limit on a file's MIME type and content ID, in printable ASCII characters. */
  mimeFieldChars: 78,
  /** Uploaded bytes one workspace keeps at once. */
  storedAttachmentBytes: 100 * 1024 * MiB,
} as const;
const mib = (bytes: number) => `${bytes / MiB} MiB`;
/** What each attachment field must be, in the words every refusal and the docs use. */
export const ATTACHMENT_FIELD_RULES = {
  filename: 'the file\'s name: 1 to 200 characters, without control characters, / or \\',
  contentType: `a MIME type such as application/pdf (type/subtype, optionally with ; parameters), at most ${ATTACHMENT_CAPS.mimeFieldChars} printable ASCII characters`,
  disposition: 'attachment (the default) or inline',
  contentId: `1 to ${ATTACHMENT_CAPS.mimeFieldChars} letters, digits, _ . @ or -, for an inline image the HTML shows as cid:<contentId>`,
} as const;
/** The headers POST /v1/attachments/upload reads each field from. */
export const UPLOAD_HEADERS = { filename: `${headerPrefix}Filename`, contentType: 'Content-Type', disposition: `${headerPrefix}Disposition`, contentId: `${headerPrefix}Content-Id` } as const;
/** Every attachment limit, as the send docs, the agent prompt and each 413 state them. */
export const ATTACHMENT_LIMITS_TEXT = `One file is at most ${mib(ATTACHMENT_CAPS.jsonAttachmentBytes)} decoded when sent as base64 in JSON (POST /v1/attachments), or ${mib(ATTACHMENT_CAPS.attachmentBytes)} as raw bytes (POST /v1/attachments/upload, with the name URI-encoded in ${UPLOAD_HEADERS.filename} and the type in Content-Type). One email carries at most ${ATTACHMENT_CAPS.attachments} files and ${mib(ATTACHMENT_CAPS.attachmentBytes)} of them together, decoded. A workspace keeps at most ${ATTACHMENT_CAPS.storedAttachmentBytes / 1024 / MiB} GiB of uploaded files. For anything larger, link to the file from the email.`;
/** The rest of the rules, field by field. */
export const ATTACHMENT_RULES_TEXT = `filename: ${ATTACHMENT_FIELD_RULES.filename}, and not an extension Amazon SES refuses (.exe, .bat, .js, .vbs and others). contentType: ${ATTACHMENT_FIELD_RULES.contentType}. disposition: ${ATTACHMENT_FIELD_RULES.disposition}; inline needs a contentId: ${ATTACHMENT_FIELD_RULES.contentId}, unique within the email. Upload each file once, then list its ID in the email's attachments.`;
/** How a send with attachment problems is refused, and what Hosted adds while a sender is new. */
export const ATTACHMENT_REFUSALS_TEXT = 'A send with attachment problems is refused once, naming every problem: error.details lists each with its email (index, in a batch), attachment (its position in attachments), id, filename, code and message. Hosted senders on probation attach only standard types (images, PDF, office documents, archives, audio, video, plain text) whose name, declared type and content agree, inline only PNG, JPEG, GIF, WebP or BMP images, and never SVG.';
