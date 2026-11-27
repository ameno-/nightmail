import { AsyncLocalStorage } from 'node:async_hooks';
import { receivedMailStore, forwardedStagingKey, withMailObjects } from './mail-objects.js';
import {mimeIndex} from './mailbox-mime-index.js';
import {wirePreview} from './protocol-preview.js';
import { copyWorkspaceRaw, headWorkspaceRaw, transferWorkspaceRaw, PARSE_LIMIT, type RawObjectHead } from './mailbox-mime.js';
import { matchRouting, plusBase } from './routing-match.js';
import { storeNotice, wakeTargets } from './inbox-wake.js';
import { storeIncoming, storeIncomingBatch, type IncomingBatchEntry } from './mailbox-ingest-store.js';
import { mailJson } from './mailbox-text.js';
import { platformHosts } from './domain-claims.js';
import { receivingPolicy,ingestInput,type IngestInput } from './mailbox-ingest-input.js';
import PostalMime, { addressParser, decodeWords, type Address, type Email } from 'postal-mime';
import { and, eq, sql } from 'drizzle-orm';
import { ApiError, digest, lazyModule, log, ModuleLoadError, type JobBatchItem, type JobBatchOutcome, type JobHandler, type Runtime } from './core.js';
import { JobDeferred, MAX_ATTEMPTS, retryDatabaseFailures } from './jobs.js';
import { mailAttachments, mailReceipts, type MailAddress, type MailHeader, type Verdicts } from './db/mailbox.js';
import { mailboxS3, STAGING_PREFIX, refreshMailboxDns } from './mailbox-setup.js';
import { ADDRESS, messageIdListCounted, normalizeMessageId, snippetOf, type Scope } from './mailbox-store.js';
import { INBOUND_ADDRESS_ADDR_LIMIT, INBOUND_ADDRESS_NAME_LIMIT, INBOUND_ADDRESS_STORE_LIMIT } from './inbound-bounds.js';
import type { ReceivedNotification } from './mailbox-receipts.js';
import { scheduleMailRecovery, stagingJobs } from './mailbox-staging.js';
import { billed } from './billing/gate.js';
import type { BillingPosition } from './billing/types.js';
import { loopHeaderNames } from './brand.js';
export { acceptInboundNotification } from './mailbox-receipts.js';

const loadIngestS3 = lazyModule(() => import('@aws-sdk/client-s3'));
const PARSE_LINE_LIMIT = 30_000;
const PARSE_ESCAPE_LIMIT = 131_072; // PostalMime escapeHtml expands [<>"'?&] 6x with per-match callbacks.
const DEGRADED_PARSE_LIMIT = 256 * 1024; // Raw byte cap if postal-mime's internal hook is unavailable.
const BODY_LIMIT = 1_000_000;
const MAX_ATTACHMENTS = 100; // More parts would exhaust the Worker subrequest budget; the message is stored without them.
const HEADER_LIMIT = 64 * 1024;
const INGEST_OUTAGE_MS = 48 * 3600_000; // Below the 3-day staging lifecycle (mail-controls.ts), with a day to spare.

export const flatten = (list: Address[] | Address | undefined): MailAddress[] => (Array.isArray(list) ? list : list ? [list] : []).flatMap(item => item.group ? item.group : [item])
  .filter(item => typeof item.address === 'string' && item.address.includes('@')).map(item => ({ name: item.name?.trim().slice(0, INBOUND_ADDRESS_NAME_LIMIT) || null, address: item.address!.trim().toLowerCase().slice(0, INBOUND_ADDRESS_ADDR_LIMIT) }));
const capAddresses = (list: MailAddress[]) => ({ items: list.slice(0, INBOUND_ADDRESS_STORE_LIMIT), count: list.length });
const verdict = (value: { status?: string } | undefined) => typeof value?.status === 'string' ? value.status : undefined;
/**
 * Whether a From field is exactly `address` (lowercase): one literal addr-spec, optionally with a display name. The
 * display parser recovers addresses from malformed text (even multiple angle addresses); identity evidence must not.
 * Support registration (src/support-conversations.ts) applies it to the stored headers too.
 */
export function literalFrom(value: string, address: string) {
  if (!withinFieldLimit(value)) return false;
  const field = value.trim().toLowerCase(), angle = `<${address}>`;
  if (field === address) return true;
  if (!field.endsWith(angle)) return false;
  const display = field.slice(0,-angle.length).trim();
  return !/[()<>@,;:\\"\[\]\x00-\x1f]/.test(display) || /^"(?:[^"\\\r\n]|\\[^\r\n])*"$/.test(display);
}
/**
 * Whether an aggregate DKIM PASS can be attributed to `domain`: SES does not say which signature passed, so only a sole
 * DKIM-Signature whose one d= tag is that domain counts. Support registration records it as dkimAligned.
 */
export function soleAlignedSignature(signatures: string[], domain: string) {
  return signatures.length===1 && withinFieldLimit(signatures[0]!) && (()=>{
    const tags=signatures[0]!.split(';').map(t=>t.trim()).filter(t=>/^d\s*=/i.test(t));
    return tags.length===1 && /^d[ \t]*=[ \t]*([^\s]+)$/i.exec(tags[0]!)?.[1]?.toLowerCase()===domain;
  })();
}
/** A header field name as RFC 5322 defines it: printable ASCII but the colon. The parser keeps a name as written, so "From :",
 * "From<TAB>:", a first line that starts with a space or an mbox "From " line would each be a field it doesn't count as a From. */
const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]+$/;
/** One From, and only one: every field name well formed, one From field that is exactly `address`, and SES's own From (when
 * it gave one; the author check requires it) agreeing. */
function singleFrom(email:Email,address:string,mail:ReceivedNotification['mail'],requireSes=false) {
  if (!email.headers.every(h => FIELD_NAME.test(h.key))) return false;
  const from = email.headers.filter(h => h.key === 'from');
  const sesFrom = mail?.commonHeaders?.from;
  if (requireSes && !sesFrom) return false;
  return from.length===1 && literalFrom(from[0]!.value,address) && (!sesFrom || (sesFrom.length===1 && literalFrom(sesFrom[0]!,address)));
}
// SES authenticates domains, not display names or Reply-To. An aggregate DKIM
// PASS cannot identify which of several differently aligned signatures passed.
function replyAuthorVerified(email:Email|null,address:string,mail:ReceivedNotification['mail'],v:Verdicts){
  if(!email || !ADDRESS.test(address) || !singleFrom(email,address,mail,true))return false;
  if(v.dmarc==='PASS')return true;
  const domain=address.split('@')[1]!,source=mail?.source?.toLowerCase();
  if(v.spf==='PASS' && source && ADDRESS.test(source) && source.split('@')[1]===domain)return true;
  return v.dkim==='PASS' && soleAlignedSignature(email.headers.filter(h=>h.key==='dkim-signature').map(h=>h.value),domain);
}
/**
 * Why the author check refused a message SES's DMARC passed, for the two reasons it is stricter than SES: a header name
 * that isn't well formed, or no From of SES's own (commonHeaders.from). One stable code per reason, logged without
 * addresses or header text, so such refusals can be seen.
 */
export function authorRefusals(email: Email | null, address: string, mail: ReceivedNotification['mail'], v: Verdicts) {
  if (!email || v.dmarc !== 'PASS' || replyAuthorVerified(email, address, mail, v)) return [];
  return [...email.headers.every(h => FIELD_NAME.test(h.key)) ? [] : ['AUTHOR_UNVERIFIED_HEADER_NAME'], ...mail?.commonHeaders?.from ? [] : ['AUTHOR_UNVERIFIED_SES_FROM_MISSING']];
}
function authenticatedFrom(email: Email | null, address: string, mail: ReceivedNotification['mail'], verdicts: Verdicts) {
  const dmarcPass = verdicts.dmarc === 'PASS', noDmarc = verdicts.dmarc === undefined || verdicts.dmarc === 'GRAY';
  if (!dmarcPass && !(noDmarc && verdicts.dkim === 'PASS')) return false;
  // DKIM signs the bottommost occurrence; the MIME parser reads the first Date. Reject ambiguity.
  if (!email || !ADDRESS.test(address) || email.headers.filter(h => h.key === 'date').length !== 1) return false;
  if(!singleFrom(email,address,mail))return false;
  const signatures = email.headers.filter(h => h.key === 'dkim-signature');
  const domain = address.split('@')[1];
  // DMARC through SPF authenticates this delivery. If it could instead be a replay of a
  // passing DKIM signature, do not trust an unsigned Date even when DMARC passed.
  const envelope = mail?.source?.toLowerCase();
  const failedDkim = verdicts.dkim === 'FAIL' || verdicts.dkim === 'GRAY';
  const alignedSpf = verdicts.spf === 'PASS' && (failedDkim || (envelope && ADDRESS.test(envelope) && envelope.split('@')[1] === domain));
  if (dmarcPass && (alignedSpf || (!signatures.length && verdicts.dkim !== 'PASS'))) return true;
  // SES doesn't identify the passing signature. With DMARC, require every candidate to
  // cover the date. Without DMARC, only a sole, strictly aligned signature is attributable.
  if (!signatures.length || (!dmarcPass && signatures.length !== 1)) return false;
  return signatures.every(({value}) => {
    if (!withinFieldLimit(value)) return false;
    const tags = value.split(';').map(tag => tag.trim());
    const signed = tags.filter(tag => /^h\s*=/i.test(tag));
    const headers = signed.length === 1 && /^h[ \t]*=[ \t]*(.+)$/.exec(signed[0]!)?.[1]?.toLowerCase().split(':').map(name => name.trim());
    if (!headers || !headers.includes('from') || !headers.includes('date')) return false;
    const domains = tags.filter(tag => /^d\s*=/i.test(tag));
    return dmarcPass || (domains.length === 1 && /^d[ \t]*=[ \t]*([^\s]+)$/.exec(domains[0]!)?.[1]?.toLowerCase() === domain);
  });
}
const cap = (value: string | undefined | null) => value && value.length > BODY_LIMIT ? { value: value.slice(0, BODY_LIMIT), truncated: true } : { value: value ?? null, truncated: false };
// Loop markers (ours, under every name, and other installations'), auto-replies and list mail.
const FORWARD_BLOCKING_HEADERS = new Set([...loopHeaderNames, 'auto-submitted', 'x-autoreply', 'x-autorespond', 'list-id', 'precedence']);
/**
 * Whether a received message may ever be forwarded: parsed, not automated, not spam, virus scan passed, DMARC not
 * failed, fewer than 200 top-level headers, none of FORWARD_BLOCKING_HEADERS and fewer than 25 Received hops.
 * Decided once at ingest from the complete parsed header names (lower case) and stored as verdicts.forwardEligible;
 * a forward reads that (sendToEndpoint).
 */
export function forwardEligibility(message: { status?: string; automated?: boolean; spam?: boolean; verdicts?: Verdicts }, headerNames: readonly string[]) {
  return message.status === 'received' && !message.automated && !message.spam && message.verdicts?.virus === 'PASS' && message.verdicts.dmarc !== 'FAIL'
    && headerNames.length < 200 && !headerNames.some(name => FORWARD_BLOCKING_HEADERS.has(name)) && headerNames.filter(name => name === 'received').length < 25;
}
export function headersOf(email: Email | null): MailHeader[] {
  const out: MailHeader[] = []; let size = 0;
  for (const header of email?.headers ?? []) { if (header.key==='bcc' || header.key==='resent-bcc') continue; size += header.originalKey.length + header.value.length; if (size > HEADER_LIMIT || out.length >= 200) break; out.push({ name: header.originalKey, value: header.value }); }
  return out;
}
const AUTOMATED_HEADERS = new Set(['auto-submitted', 'precedence', 'x-autoreply', 'x-autorespond', 'content-type', 'from']);
const RAW_HEADER_SCAN_LIMIT = 2 * 1024 * 1024;
const RAW_HEADER_FIELD_LIMIT = 16 * 1024;
const utf8 = new TextEncoder();
// UTF-16 length bounds UTF-8 bytes from below and a third of them from above, so encoding only runs in the narrow middle band.
const withinFieldLimit = (value: string) => value.length * 3 <= RAW_HEADER_FIELD_LIMIT || (value.length <= RAW_HEADER_FIELD_LIMIT && utf8.encode(value).byteLength <= RAW_HEADER_FIELD_LIMIT);
const rawHeaderDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
let incompleteAutomatedHeaderScans = 0;
const trimWsp = (s: string) => {
  let a = 0, b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
};
function unfoldHeaderValue(s: string): string {
  const parts: string[] = [];
  let copyFrom = 0, i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 13 && c !== 10) { i++; continue; }
    if (i > copyFrom) parts.push(s.slice(copyFrom, i));
    while (i < s.length && s.charCodeAt(i) === 13) i++;
    if (i < s.length && s.charCodeAt(i) === 10) i++;
    else if (i < s.length) parts.push(' ');
    copyFrom = i;
  }
  if (copyFrom === 0) return trimWsp(s);
  if (copyFrom < s.length) parts.push(s.slice(copyFrom));
  return trimWsp(parts.join(''));
}
function stripHeaderComments(input: string): string {
  let out = '', depth = 0, commentStart = 0, quote = false, esc = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (esc) { if (depth === 0) out += ch; esc = false; continue; }
    if (ch === '\\' && (quote || depth > 0)) { esc = true; if (depth === 0) out += ch; continue; }
    if (depth === 0 && ch === '"') { quote = !quote; out += ch; continue; }
    if (!quote) {
      if (ch === '(') { if (depth === 0) commentStart = i; depth++; continue; }
      if (ch === ')' && depth > 0) { depth--; continue; }
    }
    if (depth === 0) out += ch;
  }
  return depth === 0 || input.indexOf(';', commentStart) < 0 ? out : input;
}
function unquoteMimeToken(s: string): string {
  const t = trimWsp(s);
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\([\s\S])/g, '$1') : t;
}
function parseStructuredField(raw: string): { value: string; params: Map<string, string> } {
  const cleaned = stripHeaderComments(raw);
  const parts: string[] = [];
  let cur = '', quote = false, esc = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (esc) { cur += ch; esc = false; continue; }
    if (quote && ch === '\\') { cur += ch; esc = true; continue; }
    if (ch === '"') { quote = !quote; cur += ch; continue; }
    if (!quote && ch === ';') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  const decodedHead = trimWsp(decodeWords(unquoteMimeToken(parts[0] ?? '')));
  const semi = decodedHead.indexOf(';');
  const value = (semi < 0 ? decodedHead : trimWsp(decodedHead.slice(0, semi))).toLowerCase();
  const params = new Map<string, string>();
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!, eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = trimWsp(p.slice(0, eq)).toLowerCase();
    if (k && !params.has(k)) params.set(k, trimWsp(decodeWords(unquoteMimeToken(p.slice(eq + 1)))).toLowerCase());
  }
  return { value, params };
}
function rawAutomatedHeaders(raw: Uint8Array): Map<string, string> | null {
  const out = new Map<string, string>();
  const head = raw.subarray(0, Math.min(raw.byteLength, RAW_HEADER_SCAN_LIMIT));
  let pos = 0, ended = false, capped = false;
  while (pos < head.byteLength) {
    const start = pos;
    let nl = head.indexOf(10, pos);
    const lineEnd = nl < 0 ? head.byteLength : nl;
    let firstEnd = lineEnd;
    while (firstEnd > pos && head[firstEnd - 1] === 13) firstEnd--;
    if (firstEnd === pos) { ended = nl >= 0; break; }
    if (nl < 0 && raw.byteLength > head.byteLength) break;
    pos = nl < 0 ? head.byteLength : nl + 1;
    let foldTruncated = false;
    while (pos < head.byteLength && (head[pos] === 32 || head[pos] === 9)) {
      nl = head.indexOf(10, pos);
      if (nl < 0 && raw.byteLength > head.byteLength) { foldTruncated = true; break; }
      pos = nl < 0 ? head.byteLength : nl + 1;
    }
    if (foldTruncated) break;
    let k = start;
    while (k < firstEnd && (head[k] === 32 || head[k] === 9)) k++;
    let key = '';
    while (k < pos && key.length <= 14) {
      const b = head[k]!;
      if (b === 58 || b === 32 || b === 9 || b === 13 || b === 10) break;
      key += String.fromCharCode(b >= 65 && b <= 90 ? b + 32 : b);
      k++;
    }
    if (!AUTOMATED_HEADERS.has(key) || out.has(key)) continue;
    while (k < pos) {
      if (head[k] === 32 || head[k] === 9 || head[k] === 10) { k++; continue; }
      if (head[k] === 13) {
        let cr = k;
        while (cr < pos && head[cr] === 13) cr++;
        if (cr < pos && head[cr] === 10) { k = cr + 1; continue; }
      }
      break;
    }
    if (k >= pos || head[k] !== 58) continue;
    let v = k + 1;
    while (v < pos && (head[v] === 32 || head[v] === 9 || head[v] === 13 || head[v] === 10)) {
      if (head[v] === 13) {
        let cr = v;
        while (cr < pos && head[cr] === 13) cr++;
        if (cr < pos && head[cr] === 10) { v = cr + 1; continue; }
        v = cr;
        continue;
      }
      v++;
    }
    if (pos - v > RAW_HEADER_FIELD_LIMIT) { capped = true; break; }
    out.set(key, unfoldHeaderValue(rawHeaderDecoder.decode(head.subarray(v, pos))));
  }
  return ended && !capped ? out : null;
}
function automated(email: Email | null, raw: Uint8Array, from: string) {
  let fallback: Map<string, string> | null = null;
  if (!email) {
    fallback = rawAutomatedHeaders(raw);
    if (!fallback) {
      log('warn', { code: 'MAILBOX_AUTOMATED_HEADER_SCAN_INCOMPLETE', count: ++incompleteAutomatedHeaderScans });
      return false;
    }
  }
  let parsedCapped = false;
  const header = (name: string) => {
    if (!email) return fallback!.get(name) ?? '';
    const value = email.headers.find(item => item.key === name)?.value ?? '';
    if (withinFieldLimit(value)) return value;
    parsedCapped = true;
    return '';
  };
  const auto = parseStructuredField(header('auto-submitted')).value;
  const precedence = parseStructuredField(header('precedence')).value;
  const contentType = parseStructuredField(header('content-type'));
  const report = contentType.value === 'multipart/report' && /^(?:(?:global-)?delivery-status|(?:global-)?disposition-notification)$/.test(contentType.params.get('report-type') ?? '');
  const xAutoreply = trimWsp(decodeWords(stripHeaderComments(header('x-autoreply'))));
  const xAutorespond = trimWsp(decodeWords(stripHeaderComments(header('x-autorespond'))));
  const rawFrom = fallback?.get('from') ?? '';
  const rawSenders = rawFrom ? flatten(addressParser(rawFrom)).map(item => item.address) : [];
  const daemonSender = /^(?:mailer-daemon|postmaster)@/.test(from) || rawSenders.some(addr => /^(?:mailer-daemon|postmaster)@/.test(addr));
  if ((auto !== '' && auto !== 'no') || /^(?:bulk|junk|list|auto[-_]reply)$/.test(precedence) || !!xAutoreply || !!xAutorespond || daemonSender || report) return true;
  if (parsedCapped) log('warn', { code: 'MAILBOX_AUTOMATED_HEADER_SCAN_INCOMPLETE', count: ++incompleteAutomatedHeaderScans });
  return false;
}
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const HEADER_LINES = 256, MIME_DEPTH = 12, MIME_PARSE_MS = 1000;
function withinMimeLimits(raw: Uint8Array,lineLimit=PARSE_LINE_LIMIT) {
  let lines = 0, start = 0, headers = true, headerBytes = 0, headerLines = 0;
  const boundaries: string[] = [];
  const declared = new Set<string>();
  while (start < raw.length) {
    const lf = raw.indexOf(10, start), end = lf < 0 ? raw.length : lf;
    if (++lines > lineLimit) return false;
    const length = end-start-(end>start && raw[end-1] === 13 ? 1 : 0);
    // Conservative preflight of possible RFC 2046 delimiters, without decoding
    // headers or bodies. Parser-side limits below remain authoritative for
    // noncanonical syntax, attached messages and transfer encodings.
    let matched = false;
    if (declared.size && raw[start]===45 && raw[start+1]===45 && length>=3 && length<=76) {
      const delimiter=String.fromCharCode(...raw.subarray(start+2,start+length)).trimEnd();
      const closing=delimiter.endsWith('--'), key=closing?delimiter.slice(0,-2):delimiter;
      const index=boundaries.lastIndexOf(key);
      if (declared.has(key)) {
        if (index>=0) boundaries.length=index+(closing?0:1);
        else if (!closing && boundaries.push(key)>MIME_DEPTH) return false;
        headers=!closing; matched=true;
      }
    }
    if (!matched && headers) {
      headers = length>0;
      if (headers && (++headerLines>HEADER_LINES || (headerBytes+=end-start+1)>HEADER_LIMIT)) return false;
      if (headers && length<=1024 && [32,9,67,99].includes(raw[start]!)) {
        const field=String.fromCharCode(...raw.subarray(start,start+length));
        if (/^(?:content-type:|[ \t])/i.test(field)) {
          const boundary=/(?:;|^[ \t])\s*boundary\s*=\s*(?:"([^"\r\n]{1,70})"|([^;\s]{1,70}))/i.exec(field);
          if (boundary) declared.add((boundary[1]??boundary[2])!);
        }
      }
    }
    start = end + 1;
  }
  return true;
}
function countEscaped(value: string | undefined, count: number) {
  if (!value) return count;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 63 && (c === 60 || c === 62 || c === 34 || c === 39 || c === 63 || c === 38) && ++count > PARSE_ESCAPE_LIMIT) return count;
  }
  return count;
}
function countAddressesEscaped(list: Address[] | undefined, count: number): number {
  for (const addr of list ?? []) {
    if (addr.group) {
      count = countEscaped(addr.name, count);
      if (count <= PARSE_ESCAPE_LIMIT) count = countAddressesEscaped(addr.group, count);
    } else {
      count = countEscaped(addr.address, count);
      if (count <= PARSE_ESCAPE_LIMIT) count = addr.name ? countEscaped(addr.name, count) : countEscaped(addr.address, count + 2);
    }
    if (count > PARSE_ESCAPE_LIMIT) return count;
  }
  return count;
}
function countHeaderEscaped(msg: Email, count: number) {
  if (msg.from) { count = countAddressesEscaped([msg.from], count); if (count > PARSE_ESCAPE_LIMIT) return count; }
  if (msg.subject) { count = countEscaped(msg.subject, count); if (count > PARSE_ESCAPE_LIMIT) return count; }
  if (msg.date) {
    count = countEscaped(msg.date, count);
    if (count <= PARSE_ESCAPE_LIMIT && Number.isNaN(Date.parse(msg.date))) count = countEscaped(msg.date, count);
    if (count > PARSE_ESCAPE_LIMIT) return count;
  }
  for (const list of [msg.to, msg.cc, msg.bcc]) if (list?.length) { count = countAddressesEscaped(list, count); if (count > PARSE_ESCAPE_LIMIT) return count; }
  return count;
}
type InternalEntry = { type: 'text'; value: string } | { type: 'subMessage'; value: Email };
type InternalParser = { textTypes: Set<string>; textMap: Map<unknown, { plain?: InternalEntry[]; html?: InternalEntry[] }> };
const mimeBudget = (ms=MIME_PARSE_MS) => ({ count: 0, headerLines: 0, lines: 0, deadline: performance.now() + ms });
const escapeBudgetStore = new AsyncLocalStorage<ReturnType<typeof mimeBudget>>();
const postalProto = PostalMime.prototype as unknown as {
  parse?: (this: unknown, buf: unknown) => Promise<Email>;
  processLine?: (this: { currentNode: { state: string } }, line: Uint8Array, br: Uint8Array, final: boolean) => Promise<void>;
  renderTextContent?: (this: InternalParser) => void;
};
const origParse = postalProto.parse;
const origLine = postalProto.processLine;
const origRenderTextContent = postalProto.renderTextContent;
let escapeGuardWarned = false;
function warnMissingEscapeGuard() {
  if (escapeGuardWarned) return;
  escapeGuardWarned = true;
  log('warn', { code: 'MAILBOX_MIME_ESCAPE_GUARD_UNAVAILABLE' });
}
const guardedRenderTextContent = function (this: InternalParser) {
  if (this.textTypes.has('html')) {
    const budget = escapeBudgetStore.getStore() ?? { count: 0 };
    let count = budget.count;
    for (const entry of this.textMap.values()) {
      const own = entry.html;
      for (const item of own || entry.plain || []) {
        count = item.type === 'subMessage' ? countHeaderEscaped(item.value, count) : !own ? countEscaped(item.value, count) : count;
        if (count > PARSE_ESCAPE_LIMIT) { budget.count = count; throw new RangeError('MIME entity expansion limit exceeded'); }
      }
    }
    budget.count = count;
  }
  return origRenderTextContent!.call(this);
};
const escapeGuardInstalled = (() => {
  try {
    if (typeof origParse !== 'function' || typeof origLine !== 'function' || typeof origRenderTextContent !== 'function') return false;
    const probe = new PostalMime() as unknown as Partial<InternalParser>;
    if (!(probe.textTypes instanceof Set) || !(probe.textMap instanceof Map)) return false;
    postalProto.parse = function (buf: unknown) {
      return escapeBudgetStore.getStore() ? origParse.call(this, buf) : escapeBudgetStore.run(mimeBudget(), () => origParse.call(this, buf));
    };
    // Use the parser's own boundary recognition, including decoded nested mail.
    // Give workerd a scheduling point; its clock does not advance in pure JS.
    postalProto.processLine = async function (line, br, final) {
      const budget = escapeBudgetStore.getStore();
      if (budget) {
        if (this.currentNode.state === 'header' && line.length && ++budget.headerLines > HEADER_LINES) throw new RangeError('MIME header count');
        if (++budget.lines % 512 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        if (performance.now() >= budget.deadline) throw new RangeError('MIME parse deadline');
      }
      return origLine.call(this, line, br, final);
    };
    postalProto.renderTextContent = guardedRenderTextContent;
    return true;
  } catch {
    return false;
  }
})();
if (!escapeGuardInstalled) warnMissingEscapeGuard();
export const isPostalMimeEscapeGuardInstalled = () => escapeGuardInstalled && postalProto.renderTextContent === guardedRenderTextContent;
/** A mail app's SMTP submission on the wire: 25 MiB of attachments (SEND_LIMITS.attachmentBytes), base64 with line
 * breaks, is about 34.3 MiB, and the rest leaves room for its text and headers. The gateway advertises it as SIZE. */
export const SMTP_WIRE_LIMIT=36*1024*1024;
/** What the parser reads of a submission at once: submission-mime.ts lifts attachments out of larger ones. */
export const SUBMISSION_PARSE_LIMIT=8*1024*1024;
export async function parseInboundMime(raw: Uint8Array, mode:'receipt'|'submission'='receipt'): Promise<Email | null> {
  const submission=mode==='submission',budget=mimeBudget(submission?5000:MIME_PARSE_MS);
  if (raw.byteLength > (submission?SUBMISSION_PARSE_LIMIT:PARSE_LIMIT) || !withinMimeLimits(raw,submission?150_000:PARSE_LINE_LIMIT)) return null;
  if (!isPostalMimeEscapeGuardInstalled()) {
    warnMissingEscapeGuard();
    if (raw.byteLength > DEGRADED_PARSE_LIMIT) return null;
  }
  try {
    const mail = await escapeBudgetStore.run(budget, () => PostalMime.parse(raw, {
      attachmentEncoding: 'arraybuffer', maxHeadersSize: HEADER_LIMIT, maxNestingDepth: MIME_DEPTH,
      maxRfc822NestingDepth: 4, maxPartCount: 200, maxForwardedAddresses: 256,
    }));
    if(performance.now()>=budget.deadline)throw new RangeError('MIME parse deadline');
    return !mail.attachments.some(a=>a.rfc822DepthExceeded) ? mail : null;
  }
  catch { if(submission && performance.now()>=budget.deadline)throw new ApiError(503,'MIME_BUSY','Submission parser timed out.',undefined,true);return null; }
}

// A terminal write settles the receipt only as this attempt claimed it: still pending, with the same
// recipients. A reopen while the job ran holds the receipt until the job ends (155), and a stale or
// lapsed attempt must not retire the newer recipients. A failure also names the claim (settled_by):
// the database fails a pending receipt only for its running job on that lease (164).
const claimedBy=(recipients:string[])=>sql`${mailReceipts.status}='pending' AND ${mailReceipts.recipients}=${JSON.stringify(recipients)}::jsonb`;
const claimToken=(job:Parameters<JobHandler>[2])=>`${job.id}|${job.leaseFence??''}`;
// Billing's receive hold (an enforced prepaid workspace unpaid for 7 days): the raw message is parked under held/ in the
// same pool bucket, with no lifecycle rule, and the receipt waits as held/BILLING_HOLD until a credit releases it
// (billing_release_receive_holds). Thrown from the reservation callback so nothing is copied to the workspace.
const HELD_PREFIX='held/';
class BillingHold extends Error {}
/** Parks a receipt for billing: copies the raw message to held/ (unless it is already there), then one statement. */
async function parkHeld(runtime:Runtime,s3:Awaited<ReturnType<typeof mailboxS3>>,receipt:IngestInput,sourceKey:string,workspaceId:string,sesMessageId:string){
  try {
    if(!sourceKey.startsWith(HELD_PREFIX)){
      const {CopyObjectCommand}=await loadIngestS3();
      await s3.send(new CopyObjectCommand({Bucket:receipt.bucket,Key:HELD_PREFIX+sesMessageId,CopySource:`${receipt.bucket}/${sourceKey}`,CopySourceIfMatch:receipt.notification.stagingEtag as string|undefined,TaggingDirective:'REPLACE'}));
    }
  } catch (error) {
    if (error instanceof ModuleLoadError) throw error;
    if (error instanceof Error && ['NoSuchKey','NotFound'].includes(error.name)) throw new ApiError(404,'RAW_MESSAGE_MISSING','The staging object is missing.');
    throw new ApiError(503,'MAILBOX_HOLD_UNAVAILABLE','The received message could not be parked for the billing hold; retrying.',undefined,true);
  } finally { s3.destroy(); }
  // Nothing is parsed, stored, metered or delivered. The window bytes reserved for it stay reserved for the release.
  await runtime.db.execute(sql`UPDATE mail_receipts SET status='held',error='BILLING_HOLD',object_key=${HELD_PREFIX}||ses_message_id,budget_retry_at=NULL
    WHERE workspace_id=${workspaceId} AND ses_message_id=${sesMessageId} AND ${claimedBy(receipt.recipients)}`);
  log('info',{code:'BILLING_RECEIVE_HELD',workspaceId});
}
/** After a released receipt is stored, its parked copy goes (best effort; the row keeps no reference to it). */
async function dropHeld(runtime:Runtime,receipt:IngestInput,workspaceId:string,key:string){
  try {
    const s3=await mailboxS3(runtime,workspaceId,receipt.region,receipt.bucket,runtime.db,receipt.binding);
    try { const {DeleteObjectCommand}=await loadIngestS3(); await s3.send(new DeleteObjectCommand({Bucket:receipt.bucket,Key:key})); } finally { s3.destroy(); }
  } catch (error) { if (error instanceof ModuleLoadError) throw error; log('warn',{code:'BILLING_HELD_OBJECT_LEFT',workspaceId}); }
}
const ingestJob = async (runtime:Runtime, payload:Parameters<JobHandler>[1], job:Parameters<JobHandler>[2],reserveMime:(size:number)=>void,claim:{recipients?:string[];createdAt?:string}) => {
  const scope: Scope = { workspaceId: job.workspaceId };
  const sesMessageId = String(payload.sesMessageId ?? '');
  const receipt=job.ingest!==undefined?job.ingest:(await runtime.db.execute<{input:IngestInput|null}>(sql`SELECT ${ingestInput(runtime.config,scope.workspaceId,sesMessageId)} AS input`)).rows[0]?.input;
  if(!receipt)return;
  claim.recipients=receipt.recipients;claim.createdAt=receipt.createdAt;
  if(receipt.delivery?.drop)return settleRetiredReceipt(runtime,job,sesMessageId,receipt.recipients);
  const notification = receipt.notification as ReceivedNotification;
  const s3 = await mailboxS3(runtime,scope.workspaceId,receipt.region,receipt.bucket,runtime.db,receipt.binding);
  const sourceKey=receipt.bucket==='local:'?forwardedStagingKey(scope.workspaceId,sesMessageId):(receipt.objectKey.startsWith(HELD_PREFIX)?HELD_PREFIX:!runtime.config.multiTenant && (receipt.notification.legacy || receipt.objectKey.startsWith('raw/'))?'raw/':STAGING_PREFIX)+sesMessageId;
  const messageRowId = `msg_${(await digest(`${scope.workspaceId}:${sesMessageId}`)).slice(0, 32)}`;
  const verdicts: Verdicts = { spf: verdict(notification.receipt?.spfVerdict), dkim: verdict(notification.receipt?.dkimVerdict), dmarc: verdict(notification.receipt?.dmarcVerdict), spam: verdict(notification.receipt?.spamVerdict), virus: verdict(notification.receipt?.virusVerdict) };
  const spam=verdicts.spam!=='PASS';
  const quarantine=verdicts.virus!=='PASS'?'MAILBOX_VIRUS_QUARANTINED':spam && receipt.spamPolicy==='quarantine'?'MAILBOX_SPAM_QUARANTINED':null;
  if(quarantine){
    try {
      const {CopyObjectCommand}=await loadIngestS3();
      await s3.send(new CopyObjectCommand({Bucket:receipt.bucket,Key:'quarantine/'+sesMessageId,CopySource:`${receipt.bucket}/${sourceKey}`,CopySourceIfMatch:receipt.notification.stagingEtag as string|undefined,TaggingDirective:'REPLACE'}));
      log('warn',{code:quarantine,workspaceId:scope.workspaceId,virus:verdicts.virus??'missing',spam:verdicts.spam??'missing'});
      await runtime.db.update(mailReceipts).set({status:'failed',error:quarantine,processedAt:new Date().toISOString(),settledBy:claimToken(job)}).where(and(eq(mailReceipts.workspaceId,scope.workspaceId),eq(mailReceipts.sesMessageId,sesMessageId),claimedBy(receipt.recipients)));
      return;
    } finally {s3.destroy();}
  }
  const sesTimestamp = [notification.receipt?.timestamp, notification.mail?.timestamp].find(value => value && Number.isFinite(Date.parse(value)));
  const receivedAt = sesTimestamp ? new Date(sesTimestamp).toISOString() : receipt.createdAt;
  let plan=receipt.routing && matchRouting(receipt.routing,receipt.recipients,spam,verdicts.dmarc??'',receivedAt);
  // Every recipient dropped by route: settle with the job and its trace, without reading S3 or storing anything.
  if(plan?.recipients.length && !plan.grants?.length && plan.recipients.every(r=>r.dropped)){
    s3.destroy();
    const recorded=sql`recorded AS (UPDATE mail_receipts SET status='processed',processed_at=now(),routing=mail_routing_trace(${JSON.stringify(plan)}::jsonb) FROM settled WHERE workspace_id=${scope.workspaceId} AND ses_message_id=${sesMessageId} AND status='pending' AND recipients=${JSON.stringify(receipt.recipients)}::jsonb)`;
    if(job.recordWithSettlement)job.recordWithSettlement(recorded);else await runtime.db.execute(sql`WITH settled AS (SELECT 1),${recorded} SELECT 1`);return;
  }
  // An address-owned envelope can nevertheless route to another inbox or just a webhook.
  // Only retain it under e/ if every kept recipient actually delivers to its own inbox alone.
  const owners=receipt.routing?.owners;
  const needsDefault=plan?.recipients.some(r=>{
    const owner=owners?.[r.address]??owners?.[plusBase(r.address)];
    const p=receipt.routing?.programs,possible=p && [...p.attachments.filter(b=>b.target===r.address||b.target===owner?.id||r.inboxes.includes(b.target)).map(b=>p.rituals[b.ritual])].some(ir=>ir.refs.some(ref=>ref.startsWith('inbox:')&&p.refs[ref]!==owner?.id));
    return !r.dropped && (possible || r.limited || r.inboxes.length!==1 || r.inboxes[0]!==owner?.id);
  });
  const keptRoute=(p:typeof plan)=>p ? p.recipients.some(r=>r.inboxes.some(id=>receipt.routing?.boxes?.[id]?.kept)) : receipt.delivery?.lifecycle==='kept';
  const keptReceipt={...receipt,delivery:{...receipt.delivery!,lifecycle:'kept'}};
  const possibleKept=!!receipt.routing?.programs&&Object.values(receipt.routing.boxes??{}).some(b=>b.kept);
  const stores=(input:typeof receipt)=>receivedMailStore(runtime,scope.workspaceId,input!,s3,{messageId:messageRowId,sesMessageId},possibleKept);
  // Rules see parsed mail. Until they have run use the expiring class, not forever
  // storage for a speculative destination. Ordinary direct deliveries write raw once.
  const initiallyKept=!receipt.routing?.programs && keptRoute(plan);
  // A route can point at an existing persistent inbox after a BYO connection is
  // replaced. Don't try an unverified role, mark mail terminal or downgrade retention.
  const unverifiedKept=runtime.config.multiTenant && receipt.binding?.kind==='byo' && !receipt.binding.kept_policy_v1;
  if(initiallyKept&&unverifiedKept){s3.destroy();throw new JobDeferred(new Date(Date.now()+60000).toISOString());}
  const store=stores(initiallyKept?keptReceipt:needsDefault||receipt.delivery?.lifecycle==='kept'?{...receipt,delivery:undefined}:receipt);
  const keptStore=stores(keptReceipt);
  const mightKeep=initiallyKept||possibleKept;
  const readStarted=performance.now();
  let copied:Awaited<ReturnType<typeof copyWorkspaceRaw>>;
  try {
    copied=await copyWorkspaceRaw(s3,receipt.region,receipt.bucket,sourceKey,store.rawKey,receipt.recipients,initiallyKept?'kept':'raw',receipt.notification.stagingEtag as string|undefined,async size=>{
      reserveMime(size);
      // The window row before the receipt, the order every route statement takes them in (157).
      const reserved=await runtime.db.execute<{ok:boolean;fits:boolean;due:string|null;billing:BillingPosition|null}>(sql`WITH r AS MATERIALIZED (SELECT r.reserved_bytes FROM (SELECT 1) one
          LEFT JOIN LATERAL (SELECT FROM mail_receive_windows WHERE workspace_id=${scope.workspaceId} FOR UPDATE) w ON true
          CROSS JOIN LATERAL (SELECT reserved_bytes FROM mail_receipts WHERE workspace_id=${scope.workspaceId} AND ses_message_id=${sesMessageId} AND status='pending' FOR UPDATE) r),
        policy AS MATERIALIZED (SELECT messages,bytes FROM mail_receive_policy(${scope.workspaceId})),
        -- The byte budget refills continuously (354): a message takes its bytes now, or the next bytes free up to a
        -- quarter of an hour of refill ahead and waits for them (due); past that it waits for the next hour.
        debit AS (INSERT INTO mail_receive_windows AS w(workspace_id,window_at,messages,bytes,level_at,byte_level) SELECT ${scope.workspaceId},date_trunc('hour',now()),0,${size}::bigint,now(),${size}::bigint FROM r WHERE reserved_bytes IS NULL AND ${size}::bigint<=(SELECT bytes FROM policy)
          ON CONFLICT(workspace_id) DO UPDATE SET byte_level=mail_receive_level(w.byte_level,w.level_at,(SELECT bytes FROM policy))+excluded.byte_level,message_level=mail_receive_level(w.message_level,w.level_at,(SELECT messages FROM policy)),level_at=greatest(w.level_at,excluded.level_at),
            bytes=CASE WHEN w.window_at=excluded.window_at THEN w.bytes ELSE 0 END+excluded.bytes,messages=CASE WHEN w.window_at=excluded.window_at THEN w.messages ELSE 0 END,window_at=excluded.window_at
          WHERE mail_receive_level(w.byte_level,w.level_at,(SELECT bytes FROM policy))+excluded.byte_level<=(SELECT bytes FROM policy)*1.25 RETURNING w.byte_level AS level),
        charged AS (UPDATE mail_receipts SET reserved_bytes=${size} WHERE workspace_id=${scope.workspaceId} AND ses_message_id=${sesMessageId} AND EXISTS(SELECT FROM debit) RETURNING 1)
        ${mightKeep?sql`, candidate AS (INSERT INTO mail_candidate_uploads(batch,workspace_id,ses_message_id,bucket,region,message_id,keys) SELECT ${'raw:'+messageRowId},${scope.workspaceId},${sesMessageId},${keptStore.bucket},${receipt.region},${messageRowId},ARRAY[${keptStore.rawKey}] FROM r ON CONFLICT(batch) DO UPDATE SET check_at=now()+interval '1 hour')`:sql``}
        SELECT EXISTS(SELECT FROM charged UNION ALL SELECT FROM r WHERE reserved_bytes=${size}) AS ok,${size}::bigint<=bytes AND EXISTS(SELECT FROM r WHERE reserved_bytes IS NULL) AS fits,
          (SELECT to_char((now()+make_interval(secs=>(level-bytes)*3600/bytes)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM debit WHERE level>bytes) AS due,
          ${billed(runtime.config,scope.workspaceId)?sql`billing_position(${scope.workspaceId})`:sql`NULL::jsonb`} AS billing FROM policy`);
      if(!reserved.rows[0]?.ok){
        if(reserved.rows[0]?.fits) throw new JobDeferred(new Date((Math.floor(Date.now()/3600000)+1)*3600000).toISOString());
        throw new ApiError(422,'MAILBOX_BYTE_BUDGET','Receipt exceeds the workspace byte budget.');
      }
      // Charged ahead: the job runs again when those bytes have refilled, and then finds them reserved.
      if(reserved.rows[0]!.due) throw new JobDeferred(reserved.rows[0]!.due);
      const billing=reserved.rows[0]!.billing;
      // BYO workspaces pay SES themselves and are never held; their storage still bills.
      if(billing?.receiveHeld && receipt.binding?.kind!=='byo')throw new BillingHold();
    }, store.r2 ? store.objects : undefined);
  } catch (error) {
    if (error instanceof BillingHold) return parkHeld(runtime,s3,receipt,sourceKey,scope.workspaceId,sesMessageId);
    s3.destroy();
    if (error instanceof JobDeferred || error instanceof ModuleLoadError || error instanceof ApiError) throw error;
    if (error instanceof Error && ['NoSuchKey','NotFound'].includes(error.name)) throw new ApiError(404,'RAW_MESSAGE_MISSING','The staging object is missing.');
    if (error instanceof Error && error.name==='AccessDenied') throw new ApiError(403,'MAILBOX_RAW_ACCESS_DENIED','Access to the mailbox object was denied.');
    throw new ApiError(503, 'MAILBOX_RAW_UNAVAILABLE', 'The stored message could not be read from S3; retrying.', undefined, true);
  }
  const rawMs=performance.now()-readStarted,{bytes:raw,sizeBytes}=copied;
  const email = copied.large ? null : await parseInboundMime(raw);
  const status = email ? 'received' : 'unparsed';
  const common = notification.mail?.commonHeaders ?? {};

  const commonFrom = common.from?.[0] && withinFieldLimit(common.from[0]) ? flatten(addressParser(common.from[0]))[0] : undefined;
  const from = flatten(email?.from)[0] ?? { name: null, address: (commonFrom?.address ?? notification.mail?.source ?? '').trim().toLowerCase() };
  const messageId = normalizeMessageId(email?.messageId ?? common.messageId);
  const inReplyTo = normalizeMessageId(email?.inReplyTo);
  const refs = messageIdListCounted(email?.references);
  const references = refs.items;
  const subject = (email?.subject ?? common.subject ?? '').slice(0, 998);
  const text = cap(email?.text), html = cap(email?.html);
  const verifiedFrom = !!sesTimestamp && authenticatedFrom(email, from.address, notification.mail, verdicts);
  // The store reads years 1 to 9999. A Date header outside them says nothing about when the mail was sent.
  const sentMs = email?.date ? Date.parse(email.date) : NaN;
  const sentAt = sentMs >= -62135596800000 && sentMs <= 253402300799999 ? new Date(sentMs).toISOString() : null;

  // Attachments are uploaded before the database commit with deterministic keys, so retries overwrite rather than duplicate.
  const attachments: (typeof mailAttachments.$inferInsert)[] = [];
  const skipAttachments = (email?.attachments.length ?? 0) > MAX_ATTACHMENTS;
  if (skipAttachments) log('warn', { code: 'MAILBOX_ATTACHMENTS_SKIPPED', count: email!.attachments.length, limit: MAX_ATTACHMENTS });
  try {
    // Stable on retry. Reopening a processed receipt strictly grows its envelope, so a
    // cleanup already tagging the old batch can never touch the newly published keys.
    const batch=email?.attachments.length && !skipAttachments ? await digest(JSON.stringify([messageRowId,receipt.createdAt,receipt.recipients,...(store.r2?[store.bucket]:[])])) : null;
    const keys=await Promise.all((skipAttachments?[]:email?.attachments??[]).map(async(_,i)=>{const id=`matt_${(await digest(`${messageRowId}:${i}`)).slice(0,32)}`;return store.fileKey(batch!,id)}));
    if(keys.length)await runtime.db.execute(sql`INSERT INTO mail_candidate_uploads(batch,workspace_id,ses_message_id,bucket,region,message_id,keys) VALUES(${batch},${scope.workspaceId},${sesMessageId},${store.bucket},${receipt.region},${messageRowId},ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))) ON CONFLICT(batch) DO UPDATE SET check_at=now()+interval '1 hour'`);
    for (const [index, part] of (skipAttachments ? [] : email?.attachments ?? []).entries()) {
      const bytes = part.content instanceof ArrayBuffer ? part.content : typeof part.content === 'string' ? new TextEncoder().encode(part.content).buffer as ArrayBuffer : (part.content.buffer as ArrayBuffer).slice(part.content.byteOffset, part.content.byteOffset + part.content.byteLength);
      const attachmentId = `matt_${(await digest(`${messageRowId}:${index}`)).slice(0, 32)}`;
      const key = keys[index]!;
      const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(part.mimeType) ? part.mimeType : 'application/octet-stream';
      await store.objects.put(key, new Uint8Array(bytes), contentType);
      attachments.push({ id: attachmentId, ...scope, messageId: messageRowId, filename: (part.filename ?? `attachment-${index + 1}`).slice(0, 255), contentType, sizeBytes: bytes.byteLength, contentId: normalizeMessageId(part.contentId), disposition: part.disposition === 'inline' || part.related ? 'inline' as const : 'attachment' as const, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)), bucket: store.bucket, storageKey: key });
    }
  } catch (error) {
    s3.destroy();
    if (error instanceof ModuleLoadError) throw error;
    if (error instanceof Error && error.name==='AccessDenied') throw new ApiError(403,'MAILBOX_ATTACHMENT_ACCESS_DENIED','Access to mailbox attachment storage was denied.');
    throw new ApiError(503, 'MAILBOX_ATTACHMENT_UPLOAD_FAILED', 'An attachment could not be stored in S3; retrying.', undefined, true);
  }

  const toList = capAddresses(flatten(email?.to)), ccList = capAddresses(flatten(email?.cc)), replyToList = capAddresses(flatten(email?.replyTo));
  if (toList.count > INBOUND_ADDRESS_STORE_LIMIT) verdicts.toCount = toList.count;
  if (ccList.count > INBOUND_ADDRESS_STORE_LIMIT) verdicts.ccCount = ccList.count;
  if (replyToList.count > INBOUND_ADDRESS_STORE_LIMIT) verdicts.replyToCount = replyToList.count;
  if (refs.count > INBOUND_ADDRESS_STORE_LIMIT) verdicts.referencesCount = refs.count;
  const message:Parameters<typeof storeIncoming>[1]={
        id: messageRowId, ...scope, direction: 'inbound', region: receipt.region, sesMessageId, messageId, inReplyTo, references, subject,
         fromAddress: from.address, fromName: from.name, to: toList.items, cc: ccList.items, bcc: [], replyTo: replyToList.items,
        envelopeFrom: notification.mail?.source?.toLowerCase() ?? null, envelopeTo: receipt.recipients, sentAt, receivedAt,
        text: text.value, html: html.value, bodyTruncated: text.truncated || html.truncated || status === 'unparsed' || skipAttachments, snippet: snippetOf(text.value, html.value),
        mime:email?mimeIndex(raw):null, headers: headersOf(email), attachmentCount: attachments.length, sizeBytes, rawBucket: store.bucket, rawKey: store.rawKey, lifecycle: store.lifecycle,
        verdicts, spam, automated: automated(email, raw, from.address), status,
      };
  const verifiedAuthor=replyAuthorVerified(email,from.address,notification.mail,verdicts);
  for (const code of authorRefusals(email,from.address,notification.mail,verdicts)) log('warn', { code, workspaceId: scope.workspaceId });
  // A forward can be queued later than this first store (a reopened receipt, another receipt of the same email,
  // rules saved meanwhile) and reads these verdicts from the stored message. Forward eligibility is recorded for
  // every message; the author check by any workspace that routes, not only one whose rules already run.
  verdicts.forwardEligible=forwardEligibility(message,email?.headers.map(h=>h.key)??[]);
  try {
    if(receipt.routing)Object.assign(verdicts,{ritualVerified:verifiedAuthor});
    if(receipt.routing?.programs){const {ritualPipeline,projectEmail}=await import('./ritual-pipeline.js');const evaluated=await ritualPipeline(runtime,scope.workspaceId,receipt.routing,projectEmail(message,attachments,verifiedAuthor),undefined,false,receipt.createdAt);plan=evaluated.plan;Object.assign(verdicts,{ritualScores:evaluated.answers},evaluated.omenCalls?{omenCalls:evaluated.omenCalls}:{},evaluated.acted.length?{ritualsActed:evaluated.acted}:{});}
    if(!initiallyKept&&keptRoute(plan)){
      if(unverifiedKept)throw new JobDeferred(new Date(Date.now()+60000).toISOString());
      if(!copied.large)await keptStore.objects.put(keptStore.rawKey,raw,'message/rfc822');
      else await copyWorkspaceRaw(s3,receipt.region,receipt.bucket,sourceKey,keptStore.rawKey,receipt.recipients,'kept',receipt.notification.stagingEtag as string|undefined,undefined,keptStore.r2?keptStore.objects:undefined);
      Object.assign(message,{rawKey:keptStore.rawKey,rawBucket:keptStore.bucket,lifecycle:'kept'});
    }
  } finally { s3.destroy(); }
  const preview=message.lifecycle==='kept'?wirePreview(raw,sizeBytes):undefined;
  const {queued_count:runnable,wait_ms:waitMs,hold_ms:holdMs}=await storeIncoming(runtime.db,message,attachments,verifiedFrom,!receipt.notification.stagingEtag,verifiedAuthor,plan,receivingPolicy(runtime.config),runtime.config.multiTenant ? platformHosts(runtime.config) : null,preview,storeNotice(runtime.inboxWake,scope.workspaceId,wakeTargets([plan])));
  log('info', { code: 'MAILBOX_MESSAGE_INGESTED',workspaceId:scope.workspaceId,status,spam,rawMs,waitMs,holdMs,lagMs:Date.now()-Date.parse(receipt.createdAt), bytes:sizeBytes, attachments: attachments.length });
  // Committed: polls waiting on its inboxes read now (inbox-wake.ts).
  await runtime.inboxWake?.notify(scope.workspaceId, wakeTargets([plan]));
  if(sourceKey.startsWith(HELD_PREFIX))await dropHeld(runtime,receipt,scope.workspaceId,sourceKey);
  if (runnable > 0) try { await runtime.wake?.(runnable,'webhook'); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Mailbox webhook jobs remain durable.' }); }
};

/** Re-queues receipts whose ingest job was lost (for example after a failed attempt ceiling). Hourly. */
const recoveryPage='mailbox.recoverReceipts';
export async function recoverMailReceipts(runtime: Runtime,continuation=false) {
  const jobFor=sql`j.workspace_id=r.workspace_id AND j.type='mailbox.ingest' AND j.payload->>'sesMessageId'=r.ses_message_id`;
  // The durable reconcile: every pending receipt without a live job is queued again, at most every 30 minutes (this runs
  // hourly), until it is two days old (below SES's 3-day staging lifecycle); then it fails. The budget comes from the
  // receipt's timestamps, never from a counter a worker changes: first seen (created_at) and the sweep's own last re-queue
  // (last_recovered_at). A receipt first seen over an hour ago (past the normal retry sequence) gets one final attempt per
  // queue; mail_ingest_admit (205) applies the same rule to the jobs the backlog drain and hold release queue for it.
  // A pending receipt is one whose message is not stored for its recipients: ingest stores and settles in one statement.
  // recovery_attempts still counts every sweep, because migration 164's fence lets the sweep fail a receipt only with it.
  const result=await runtime.db.execute<{n:number}>(sql`WITH due AS (SELECT r.workspace_id,r.ses_message_id,EXISTS(SELECT FROM jobs j WHERE ${jobFor} AND j.attempts>=${MAX_ATTEMPTS} AND (j.status='failed' OR (j.status='running' AND j.lease_until<now()))) AS exhausted,
      r.created_at>now()-${INGEST_OUTAGE_MS/1000}*interval '1 second' AS young,r.created_at<now()-interval '1 hour' AS seasoned
    FROM mail_receipts r WHERE r.status='pending' AND coalesce(r.last_recovered_at,r.created_at)<now()-interval '30 minutes'
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE ${jobFor} AND (j.status='pending' OR (j.status='running' AND (j.lease_until>=now() OR j.attempts<${MAX_ATTEMPTS}))))
    ORDER BY coalesce(r.last_recovered_at,r.created_at),r.workspace_id,r.ses_message_id LIMIT 100 FOR UPDATE OF r SKIP LOCKED), recovered AS (
    UPDATE mail_receipts r SET recovery_attempts=r.recovery_attempts+1,last_recovered_at=now(),status=CASE WHEN d.young THEN 'pending' ELSE 'failed' END,
      error=CASE WHEN d.young THEN NULL WHEN d.exhausted THEN 'MAILBOX_INGEST_EXHAUSTED' ELSE 'MAILBOX_RECOVERY_EXHAUSTED' END,processed_at=CASE WHEN d.young THEN NULL ELSE now() END
    FROM due d WHERE r.workspace_id=d.workspace_id AND r.ses_message_id=d.ses_message_id RETURNING r.workspace_id,r.ses_message_id,r.status,d.seasoned),
    queued AS (INSERT INTO jobs(id,type,workspace_id,payload,attempts) SELECT public.row_id('job'),'mailbox.ingest',workspace_id,jsonb_build_object('sesMessageId',ses_message_id),
      CASE WHEN seasoned THEN ${MAX_ATTEMPTS-1}::int ELSE 0 END FROM recovered WHERE status='pending' ORDER BY workspace_id,ses_message_id)
    SELECT count(*)::int AS n FROM recovered`);
  if(result.rows[0]!.n===100){
    if(continuation) throw new JobDeferred(new Date().toISOString());
    await runtime.db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) VALUES(${recoveryPage},${recoveryPage},${runtime.config.workspaceId},'{}') ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,lease_until=NULL,last_error=NULL,available_at=now(),created_at=now() WHERE jobs.status NOT IN ('running','pending')`);
  }
}

/** Hourly mailbox upkeep: MX status and lost-receipt recovery. Each step is best-effort. Event retention is cleanup()'s. */
export async function mailboxHourly(runtime: Runtime) {
  for (const [code, work] of [['MAILBOX_DNS_REFRESH_FAILED', refreshMailboxDns], ['MAILBOX_RECEIPT_RECOVERY_FAILED', recoverMailReceipts], ['MAILBOX_STAGING_SWEEP_FAILED', scheduleMailRecovery]] as const) {
    try { await work(runtime); } catch (error) { log('warn', { code: error instanceof ApiError ? error.code : code }); }
  }
}

// Keep the aggregate parser input at the old single-message ceiling; larger streaming
// copies need the whole budget for the multipart Bcc scrub. Never wait on another request.
let mimeBytes=0;
const inProgress=new Set<string>();
/** Every recipient is a deleted inbox's reserved address: settle with a count, without reading S3 or storing. */
async function settleRetiredReceipt(runtime:Runtime,job:Parameters<JobHandler>[2],sesMessageId:string,recipients:string[]){
  const update=sql`retired AS (UPDATE mail_receipts SET status='processed',error='EPHEMERAL_RETIRED',processed_at=now(),dropped_recipients=jsonb_array_length(recipients) WHERE workspace_id=${job.workspaceId} AND ses_message_id=${sesMessageId} AND status='pending' AND recipients=${JSON.stringify(recipients)}::jsonb ${job.recordWithSettlement?sql`AND EXISTS(SELECT FROM settled)`:sql``})`;
  if(job.recordWithSettlement)job.recordWithSettlement(update);else await runtime.db.execute(sql`WITH ${update} SELECT 1`);
}
/** Queued by `mail_gc_batch` after the rows commit, so a retry never resurrects a row. Missing keys are fine. */
const deleteMailObjects:JobHandler=async(runtime,payload,job)=>{
  const keys=payload.keys;
  if(!Array.isArray(keys)||keys.length>1000||!keys.every(k=>typeof k==='string'))throw new ApiError(422,'JOB_PAYLOAD_INVALID','Invalid mail object list.');
  try{await withMailObjects(runtime,job.workspaceId,String(payload.region),String(payload.bucket),objects=>objects.delete(keys),{binding:job.deleteBinding});}
  catch(e){
    if(e instanceof ApiError || e instanceof ModuleLoadError)throw e;
    // The SES pool and BYO roles cannot delete; the job stays failed with its keys for the operator.
    if(e instanceof Error && e.name==='AccessDenied')throw new ApiError(403,'MAIL_DELETE_DENIED','This storage role cannot delete mail objects.');
    throw new ApiError(503,'MAIL_DELETE_UNAVAILABLE','Object deletion will retry.',undefined,true);
  }
};
async function finalizeIngestError(runtime: Runtime, payload: Record<string, unknown>, job: Parameters<JobHandler>[2], claim: { recipients?: string[]; createdAt?: string }, error: unknown): Promise<unknown> {
  if (error instanceof JobDeferred || error instanceof ModuleLoadError) return error;
  if (job.attempts < MAX_ATTEMPTS) {
    // A transport disconnect need not have a SQLSTATE or SDK error code. Only explicit permanent errors settle early.
    if (!(error instanceof ApiError)) return new ApiError(503, 'MAILBOX_INGEST_UNAVAILABLE', 'Mailbox ingestion temporarily unavailable.', undefined, true);
    if (error.retryable) return error;
    if (error.status >= 500 || error.status === 429) return new ApiError(503, error.code, 'Mailbox ingestion temporarily unavailable.', undefined, true);
  }
  // Out of attempts (about 81 minutes) on a transient failure (a storage, role or database outage) while SES's staged copy
  // lives: write nothing to the receipt. This job fails through its own lease-fenced settlement and the receipt stays
  // pending, so the hourly reconcile (recoverMailReceipts) queues it again until it is two days old. Workers never write
  // outage state, so a worker whose lease was retired has nothing to restore.
  else if ((!(error instanceof ApiError) || error.retryable || error.status >= 500 || error.status === 429) && claim.createdAt && Date.now() - Date.parse(claim.createdAt) < INGEST_OUTAGE_MS) {
    log('warn', { code: 'MAILBOX_INGEST_OUTAGE', cause: error instanceof ApiError ? error.code : 'MAILBOX_INGEST_FAILED', workspaceId: job.workspaceId, jobId: job.id });
    return new ApiError(503, error instanceof ApiError ? error.code : 'MAILBOX_INGEST_UNAVAILABLE', 'Mailbox ingestion temporarily unavailable; the hourly reconcile retries it.', undefined, true);
  }
  const code = error instanceof ApiError ? (error.code === 'MAILBOX_ATTACHMENT_UPLOAD_FAILED' ? 'ATTACHMENT_UPLOAD_FAILED' : error.code) : 'MAILBOX_INGEST_FAILED';
  await runtime.db.update(mailReceipts).set({ status: 'failed', error: code, processedAt: new Date().toISOString(), settledBy: claimToken(job) }).where(and(eq(mailReceipts.workspaceId, job.workspaceId), eq(mailReceipts.sesMessageId, String(payload.sesMessageId)), claim.recipients ? claimedBy(claim.recipients) : eq(mailReceipts.status, 'pending')));
  log('error', { code, workspaceId: job.workspaceId, jobId: job.id });
  return undefined;
}

const mapS3ReadError = (error: unknown) => {
  if (error instanceof JobDeferred || error instanceof ModuleLoadError || error instanceof ApiError) return error;
  if (error instanceof Error && ['NoSuchKey', 'NotFound'].includes(error.name)) return new ApiError(404, 'RAW_MESSAGE_MISSING', 'The staging object is missing.');
  if (error instanceof Error && error.name === 'AccessDenied') return new ApiError(403, 'MAILBOX_RAW_ACCESS_DENIED', 'Access to the mailbox object was denied.');
  return new ApiError(503, 'MAILBOX_RAW_UNAVAILABLE', 'The stored message could not be read from S3; retrying.', undefined, true);
};

/**
 * Batched inbound ingest for >= 2 jobs in the same workspace claimed together:
 * overlaps S3 HeadObject, runs one batched byte-window + billing check, overlaps S3 GetObject /
 * Bcc scrub / R2 PutObject / MIME parse / attachment upload / ritual evaluation, and commits all
 * ready messages under one ingest lane lock via mail_store_incoming_batch.
 */
async function ingestBatch(runtime: Runtime, items: JobBatchItem[]): Promise<JobBatchOutcome[]> {
  if (!items.length) return [];
  const workspaceId = items[0]!.job.workspaceId;
  const scope: Scope = { workspaceId };
  const outcomes = new Map<string, JobBatchOutcome>();
  const s3Clients = new Map<string, Awaited<ReturnType<typeof mailboxS3>>>();
  const getS3 = async (receipt: IngestInput) => {
    const k = `${receipt.region}|${receipt.bucket}|${receipt.binding?.id ?? 'shared'}`;
    let client = s3Clients.get(k);
    if (!client) {
      client = await mailboxS3(runtime, workspaceId, receipt.region, receipt.bucket, runtime.db, receipt.binding);
      s3Clients.set(k, client);
    }
    return client;
  };

  type BatchState = {
    item: JobBatchItem;
    sesMessageId: string;
    key: string;
    reserved: number;
    claim: { recipients?: string[]; createdAt?: string };
    receipt?: IngestInput;
    notification?: ReceivedNotification;
    sourceKey?: string;
    messageRowId?: string;
    verdicts?: Verdicts;
    spam?: boolean;
    sesTimestamp?: string;
    receivedAt?: string;
    plan?: ReturnType<typeof matchRouting> | null;
    initiallyKept?: boolean;
    unverifiedKept?: boolean;
    mightKeep?: boolean;
    store?: ReturnType<typeof receivedMailStore>;
    keptStore?: ReturnType<typeof receivedMailStore>;
    head?: RawObjectHead;
    rawMs?: number;
    entry?: IncomingBatchEntry;
    status?: 'received' | 'unparsed';
    sizeBytes?: number;
    attachmentsCount?: number;
  };

  const active: BatchState[] = [];
  for (const item of items) {
    const sesMessageId = String(item.payload.sesMessageId ?? '');
    const key = JSON.stringify([workspaceId, sesMessageId]);
    if (inProgress.has(key)) {
      outcomes.set(item.job.id, { id: item.job.id, error: new JobDeferred(new Date(Date.now() + 2000).toISOString()) });
      continue;
    }
    inProgress.add(key);
    active.push({ item, sesMessageId, key, reserved: 0, claim: { recipients: item.job.ingest?.recipients, createdAt: item.job.ingest?.createdAt } });
  }

  const failState = async (st: BatchState, error: unknown) => {
    const outErr = await finalizeIngestError(runtime, st.item.payload, st.item.job, st.claim, error);
    outcomes.set(st.item.job.id, outErr !== undefined ? { id: st.item.job.id, error: outErr } : { id: st.item.job.id });
  };

  try {
    // 1. Pre-storage routing, drop, quarantine, and retired checks.
    const toHead: BatchState[] = [];
    for (const st of active) {
      try {
        const receipt = st.item.job.ingest !== undefined
          ? st.item.job.ingest
          : (await runtime.db.execute<{ input: IngestInput | null }>(sql`SELECT ${ingestInput(runtime.config, workspaceId, st.sesMessageId)} AS input`)).rows[0]?.input;
        if (!receipt) { outcomes.set(st.item.job.id, { id: st.item.job.id }); continue; }
        st.receipt = receipt;
        st.claim.recipients = receipt.recipients;
        st.claim.createdAt = receipt.createdAt;
        if (receipt.delivery?.drop) {
          await settleRetiredReceipt(runtime, st.item.job, st.sesMessageId, receipt.recipients);
          outcomes.set(st.item.job.id, { id: st.item.job.id });
          continue;
        }
        const notification = receipt.notification as ReceivedNotification;
        const sourceKey = receipt.bucket === 'local:' ? forwardedStagingKey(workspaceId, st.sesMessageId) : (receipt.objectKey.startsWith(HELD_PREFIX) ? HELD_PREFIX : !runtime.config.multiTenant && (receipt.notification.legacy || receipt.objectKey.startsWith('raw/')) ? 'raw/' : STAGING_PREFIX) + st.sesMessageId;
        const messageRowId = `msg_${(await digest(`${workspaceId}:${st.sesMessageId}`)).slice(0, 32)}`;
        const verdicts: Verdicts = { spf: verdict(notification.receipt?.spfVerdict), dkim: verdict(notification.receipt?.dkimVerdict), dmarc: verdict(notification.receipt?.dmarcVerdict), spam: verdict(notification.receipt?.spamVerdict), virus: verdict(notification.receipt?.virusVerdict) };
        const spam = verdicts.spam !== 'PASS';
        const quarantine = verdicts.virus !== 'PASS' ? 'MAILBOX_VIRUS_QUARANTINED' : spam && receipt.spamPolicy === 'quarantine' ? 'MAILBOX_SPAM_QUARANTINED' : null;
        if (quarantine) {
          const s3 = await getS3(receipt);
          const { CopyObjectCommand } = await loadIngestS3();
          await s3.send(new CopyObjectCommand({ Bucket: receipt.bucket, Key: 'quarantine/' + st.sesMessageId, CopySource: `${receipt.bucket}/${sourceKey}`, CopySourceIfMatch: receipt.notification.stagingEtag as string | undefined, TaggingDirective: 'REPLACE' }));
          log('warn', { code: quarantine, workspaceId, virus: verdicts.virus ?? 'missing', spam: verdicts.spam ?? 'missing' });
          await runtime.db.update(mailReceipts).set({ status: 'failed', error: quarantine, processedAt: new Date().toISOString(), settledBy: claimToken(st.item.job) }).where(and(eq(mailReceipts.workspaceId, workspaceId), eq(mailReceipts.sesMessageId, st.sesMessageId), claimedBy(receipt.recipients)));
          outcomes.set(st.item.job.id, { id: st.item.job.id });
          continue;
        }
        const sesTimestamp = [notification.receipt?.timestamp, notification.mail?.timestamp].find(value => value && Number.isFinite(Date.parse(value)));
        const receivedAt = sesTimestamp ? new Date(sesTimestamp).toISOString() : receipt.createdAt;
        const plan = receipt.routing && matchRouting(receipt.routing, receipt.recipients, spam, verdicts.dmarc ?? '', receivedAt);
        if (plan?.recipients.length && !plan.grants?.length && plan.recipients.every(r => r.dropped)) {
          await runtime.db.execute(sql`UPDATE mail_receipts SET status='processed',processed_at=now(),routing=mail_routing_trace(${JSON.stringify(plan)}::jsonb) WHERE workspace_id=${workspaceId} AND ses_message_id=${st.sesMessageId} AND status='pending' AND recipients=${JSON.stringify(receipt.recipients)}::jsonb`);
          outcomes.set(st.item.job.id, { id: st.item.job.id });
          continue;
        }
        const owners = receipt.routing?.owners;
        const needsDefault = plan?.recipients.some(r => {
          const owner = owners?.[r.address] ?? owners?.[plusBase(r.address)];
          const p = receipt.routing?.programs, possible = p && [...p.attachments.filter(b => b.target === r.address || b.target === owner?.id || r.inboxes.includes(b.target)).map(b => p.rituals[b.ritual])].some(ir => ir.refs.some(ref => ref.startsWith('inbox:') && p.refs[ref] !== owner?.id));
          return !r.dropped && (possible || r.limited || r.inboxes.length !== 1 || r.inboxes[0] !== owner?.id);
        });
        const keptRoute = (p: typeof plan) => p ? p.recipients.some(r => r.inboxes.some(id => receipt.routing?.boxes?.[id]?.kept)) : receipt.delivery?.lifecycle === 'kept';
        const keptReceipt = { ...receipt, delivery: { ...receipt.delivery!, lifecycle: 'kept' } };
        const possibleKept = !!receipt.routing?.programs && Object.values(receipt.routing.boxes ?? {}).some(b => b.kept);
        const initiallyKept = !receipt.routing?.programs && keptRoute(plan);
        const unverifiedKept = runtime.config.multiTenant && receipt.binding?.kind === 'byo' && !receipt.binding.kept_policy_v1;
        if (initiallyKept && unverifiedKept) {
          outcomes.set(st.item.job.id, { id: st.item.job.id, error: new JobDeferred(new Date(Date.now() + 60000).toISOString()) });
          continue;
        }
        const s3 = await getS3(receipt);
        const stores = (input: IngestInput) => receivedMailStore(runtime, workspaceId, input, s3, { messageId: messageRowId, sesMessageId: st.sesMessageId }, possibleKept);
        st.notification = notification;
        st.sourceKey = sourceKey;
        st.messageRowId = messageRowId;
        st.verdicts = verdicts;
        st.spam = spam;
        st.sesTimestamp = sesTimestamp;
        st.receivedAt = receivedAt;
        st.plan = plan;
        st.initiallyKept = initiallyKept;
        st.unverifiedKept = unverifiedKept;
        st.mightKeep = initiallyKept || possibleKept;
        st.store = stores(initiallyKept ? keptReceipt : needsDefault || receipt.delivery?.lifecycle === 'kept' ? { ...receipt, delivery: undefined } : receipt);
        st.keptStore = stores(keptReceipt);
        toHead.push(st);
      } catch (error) {
        await failState(st, error);
      }
    }

    // 2. Parallel S3 HeadObject + isolate MIME byte-budget guard.
    const headed: BatchState[] = [];
    await Promise.all(toHead.map(async st => {
      const t0 = performance.now();
      try {
        const s3 = await getS3(st.receipt!);
        const head = await headWorkspaceRaw(s3, st.receipt!.bucket, st.sourceKey!, st.receipt!.notification.stagingEtag as string | undefined, st.store!.r2 ? st.store!.objects : undefined);
        const bytes = Math.min(PARSE_LIMIT, Math.max(128 * 1024, head.size));
        if (mimeBytes + bytes > PARSE_LIMIT) throw new JobDeferred(new Date(Date.now() + 2000).toISOString());
        mimeBytes += bytes;
        st.reserved = bytes;
        st.head = head;
        st.rawMs = performance.now() - t0;
        headed.push(st);
      } catch (error) {
        await failState(st, mapS3ReadError(error));
      }
    }));

    // 3. Single batched byte-window reservation + single billing_position check for the workspace.
    const toTransfer: BatchState[] = [];
    if (headed.length) {
      const reservePayload = headed.map(st => ({
        ses_message_id: st.sesMessageId,
        size: st.head!.size,
        ...(st.mightKeep ? {
          candidate_batch: `raw:${st.messageRowId}`,
          candidate_bucket: st.keptStore!.bucket,
          candidate_region: st.receipt!.region,
          candidate_message_id: st.messageRowId,
          candidate_key: st.keptStore!.rawKey,
        } : {}),
      }));
      let resRows: { ses_message_id: string; pending: boolean; ok: boolean; fits: boolean; due: string | null; receive_held: boolean }[] | null = null;
      try {
        resRows = (await runtime.db.execute<{ ses_message_id: string; pending: boolean; ok: boolean; fits: boolean; due: string | null; receive_held: boolean }>(
          sql`SELECT * FROM mail_reserve_ingest_batch(${workspaceId}, ${mailJson(reservePayload)}::jsonb, ${billed(runtime.config, workspaceId)})`,
        )).rows;
      } catch (error) {
        for (const st of headed) await failState(st, error);
      }
      const byMid = new Map((resRows ?? []).map(r => [r.ses_message_id, r]));
      for (const st of resRows ? headed : []) {
        const r = byMid.get(st.sesMessageId);
        if (!r || !r.pending) {
          // Another consumer already settled this receipt; complete cleanly without logging a budget error.
          outcomes.set(st.item.job.id, { id: st.item.job.id });
          continue;
        }
        if (!r.ok) {
          if (r.fits) outcomes.set(st.item.job.id, { id: st.item.job.id, error: new JobDeferred(new Date((Math.floor(Date.now() / 3600000) + 1) * 3600000).toISOString()) });
          else await failState(st, new ApiError(422, 'MAILBOX_BYTE_BUDGET', 'Receipt exceeds the workspace byte budget.'));
          continue;
        }
        if (r.due) {
          outcomes.set(st.item.job.id, { id: st.item.job.id, error: new JobDeferred(r.due) });
          continue;
        }
        if (r.receive_held && st.receipt!.binding?.kind !== 'byo') {
          try {
            const parkS3 = await mailboxS3(runtime, workspaceId, st.receipt!.region, st.receipt!.bucket, runtime.db, st.receipt!.binding);
            await parkHeld(runtime, parkS3, st.receipt!, st.sourceKey!, workspaceId, st.sesMessageId);
            outcomes.set(st.item.job.id, { id: st.item.job.id });
          } catch (error) {
            await failState(st, error);
          }
          continue;
        }
        toTransfer.push(st);
      }
    }

    // 4. Parallel S3 GetObject + scrub + R2 PutObject + MIME parse + attachments + ritual evaluation.
    const ready: BatchState[] = [];
    const hosts = runtime.config.multiTenant ? platformHosts(runtime.config) : null;
    await Promise.all(toTransfer.map(async st => {
      const t0 = performance.now();
      try {
        const receipt = st.receipt!, s3 = await getS3(receipt), store = st.store!, keptStore = st.keptStore!;
        const copied = await transferWorkspaceRaw(s3, receipt.region, receipt.bucket, st.sourceKey!, store.rawKey, receipt.recipients, st.initiallyKept ? 'kept' : 'raw', st.head!, store.r2 ? store.objects : undefined);
        st.rawMs = (st.rawMs ?? 0) + (performance.now() - t0);
        const { bytes: raw, sizeBytes } = copied;
        const email = copied.large ? null : await parseInboundMime(raw);
        const status = email ? 'received' : 'unparsed';
        const notification = st.notification!, common = notification.mail?.commonHeaders ?? {};
        const commonFrom = common.from?.[0] && withinFieldLimit(common.from[0]) ? flatten(addressParser(common.from[0]))[0] : undefined;
        const from = flatten(email?.from)[0] ?? { name: null, address: (commonFrom?.address ?? notification.mail?.source ?? '').trim().toLowerCase() };
        const messageId = normalizeMessageId(email?.messageId ?? common.messageId);
        const inReplyTo = normalizeMessageId(email?.inReplyTo);
        const refs = messageIdListCounted(email?.references);
        const references = refs.items;
        const subject = (email?.subject ?? common.subject ?? '').slice(0, 998);
        const text = cap(email?.text), html = cap(email?.html);
        const verifiedFrom = !!st.sesTimestamp && authenticatedFrom(email, from.address, notification.mail, st.verdicts!);
        const sentMs = email?.date ? Date.parse(email.date) : NaN;
        const sentAt = sentMs >= -62135596800000 && sentMs <= 253402300799999 ? new Date(sentMs).toISOString() : null;

        const attachments: (typeof mailAttachments.$inferInsert)[] = [];
        const skipAttachments = (email?.attachments.length ?? 0) > MAX_ATTACHMENTS;
        if (skipAttachments) log('warn', { code: 'MAILBOX_ATTACHMENTS_SKIPPED', count: email!.attachments.length, limit: MAX_ATTACHMENTS });
        try {
          const batch = email?.attachments.length && !skipAttachments ? await digest(JSON.stringify([st.messageRowId!, receipt.createdAt, receipt.recipients, ...(store.r2 ? [store.bucket] : [])])) : null;
          const keys = await Promise.all((skipAttachments ? [] : email?.attachments ?? []).map(async (_, i) => { const aid = `matt_${(await digest(`${st.messageRowId!}:${i}`)).slice(0, 32)}`; return store.fileKey(batch!, aid); }));
          if (keys.length) await runtime.db.execute(sql`INSERT INTO mail_candidate_uploads(batch,workspace_id,ses_message_id,bucket,region,message_id,keys) VALUES(${batch},${workspaceId},${st.sesMessageId},${store.bucket},${receipt.region},${st.messageRowId!},ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))) ON CONFLICT(batch) DO UPDATE SET check_at=now()+interval '1 hour'`);
          for (const [index, part] of (skipAttachments ? [] : email?.attachments ?? []).entries()) {
            const bytes = part.content instanceof ArrayBuffer ? part.content : typeof part.content === 'string' ? new TextEncoder().encode(part.content).buffer as ArrayBuffer : (part.content.buffer as ArrayBuffer).slice(part.content.byteOffset, part.content.byteOffset + part.content.byteLength);
            const attachmentId = `matt_${(await digest(`${st.messageRowId!}:${index}`)).slice(0, 32)}`;
            const key = keys[index]!;
            const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(part.mimeType) ? part.mimeType : 'application/octet-stream';
            await store.objects.put(key, new Uint8Array(bytes), contentType);
            attachments.push({ id: attachmentId, ...scope, messageId: st.messageRowId!, filename: (part.filename ?? `attachment-${index + 1}`).slice(0, 255), contentType, sizeBytes: bytes.byteLength, contentId: normalizeMessageId(part.contentId), disposition: part.disposition === 'inline' || part.related ? 'inline' as const : 'attachment' as const, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)), bucket: store.bucket, storageKey: key });
          }
        } catch (error) {
          if (error instanceof ModuleLoadError) throw error;
          if (error instanceof Error && error.name === 'AccessDenied') throw new ApiError(403, 'MAILBOX_ATTACHMENT_ACCESS_DENIED', 'Access to mailbox attachment storage was denied.');
          throw new ApiError(503, 'MAILBOX_ATTACHMENT_UPLOAD_FAILED', 'An attachment could not be stored in S3; retrying.', undefined, true);
        }

        const verdicts = st.verdicts!;
        const toList = capAddresses(flatten(email?.to)), ccList = capAddresses(flatten(email?.cc)), replyToList = capAddresses(flatten(email?.replyTo));
        if (toList.count > INBOUND_ADDRESS_STORE_LIMIT) verdicts.toCount = toList.count;
        if (ccList.count > INBOUND_ADDRESS_STORE_LIMIT) verdicts.ccCount = ccList.count;
        if (replyToList.count > INBOUND_ADDRESS_STORE_LIMIT) verdicts.replyToCount = replyToList.count;
        if (refs.count > INBOUND_ADDRESS_STORE_LIMIT) verdicts.referencesCount = refs.count;
        const message: Parameters<typeof storeIncoming>[1] = {
          id: st.messageRowId!, ...scope, direction: 'inbound', region: receipt.region, sesMessageId: st.sesMessageId, messageId, inReplyTo, references, subject,
          fromAddress: from.address, fromName: from.name, to: toList.items, cc: ccList.items, bcc: [], replyTo: replyToList.items,
          envelopeFrom: notification.mail?.source?.toLowerCase() ?? null, envelopeTo: receipt.recipients, sentAt, receivedAt: st.receivedAt!,
          text: text.value, html: html.value, bodyTruncated: text.truncated || html.truncated || status === 'unparsed' || skipAttachments, snippet: snippetOf(text.value, html.value),
          mime: email ? mimeIndex(raw) : null, headers: headersOf(email), attachmentCount: attachments.length, sizeBytes, rawBucket: store.bucket, rawKey: store.rawKey, lifecycle: store.lifecycle,
          verdicts, spam: st.spam!, automated: automated(email, raw, from.address), status,
        };
        const verifiedAuthor = replyAuthorVerified(email, from.address, notification.mail, verdicts);
        for (const code of authorRefusals(email, from.address, notification.mail, verdicts)) log('warn', { code, workspaceId });
        verdicts.forwardEligible = forwardEligibility(message, email?.headers.map(h => h.key) ?? []);
        let plan = st.plan;
        if (receipt.routing) Object.assign(verdicts, { ritualVerified: verifiedAuthor });
        if (receipt.routing?.programs) {
          const { ritualPipeline, projectEmail } = await import('./ritual-pipeline.js');
          const evaluated = await ritualPipeline(runtime, workspaceId, receipt.routing, projectEmail(message, attachments, verifiedAuthor), undefined, false, receipt.createdAt);
          plan = evaluated.plan;
          Object.assign(verdicts, { ritualScores: evaluated.answers }, evaluated.omenCalls ? { omenCalls: evaluated.omenCalls } : {}, evaluated.acted.length ? { ritualsActed: evaluated.acted } : {});
        }
        const keptRoute = (p: typeof plan) => p ? p.recipients.some(r => r.inboxes.some(id => receipt.routing?.boxes?.[id]?.kept)) : receipt.delivery?.lifecycle === 'kept';
        if (!st.initiallyKept && keptRoute(plan)) {
          if (st.unverifiedKept) throw new JobDeferred(new Date(Date.now() + 60000).toISOString());
          if (!copied.large) await keptStore.objects.put(keptStore.rawKey, raw, 'message/rfc822');
          else await transferWorkspaceRaw(s3, receipt.region, receipt.bucket, st.sourceKey!, keptStore.rawKey, receipt.recipients, 'kept', st.head!, keptStore.r2 ? keptStore.objects : undefined);
          Object.assign(message, { rawKey: keptStore.rawKey, rawBucket: keptStore.bucket, lifecycle: 'kept' });
        }
        const preview = message.lifecycle === 'kept' ? wirePreview(raw, sizeBytes) : undefined;
        st.entry = { m: message, files: attachments, verifiedFrom, allowCreate: !receipt.notification.stagingEtag, replyAuthorVerified: verifiedAuthor, plan, platformHosts: hosts, preview };
        st.status = status;
        st.sizeBytes = sizeBytes;
        st.attachmentsCount = attachments.length;
        ready.push(st);
      } catch (error) {
        await failState(st, mapS3ReadError(error));
      }
    }));

    // 5. Commit all ready messages in arrival order under one ingest lane lock and one transaction.
    if (ready.length) {
      ready.sort((a, b) => a.receivedAt!.localeCompare(b.receivedAt!) || a.sesMessageId.localeCompare(b.sesMessageId));
      const policy = receivingPolicy(runtime.config);
      let totalRunnable = 0;
      // The committed messages' plans, for the polls waiting on their inboxes (inbox-wake.ts).
      const stored: BatchState['entry'][] = [], reached = (st: BatchState) => { stored.push(st.entry); };
      const noticeOf = (states: BatchState[]) => storeNotice(runtime.inboxWake, workspaceId, wakeTargets(states.map(st => st.entry!.plan)));
      try {
        const storedRows = ready.length === 1
          ? [await storeIncoming(runtime.db, ready[0]!.entry!.m, ready[0]!.entry!.files, ready[0]!.entry!.verifiedFrom, ready[0]!.entry!.allowCreate, ready[0]!.entry!.replyAuthorVerified, ready[0]!.entry!.plan, policy, ready[0]!.entry!.platformHosts, ready[0]!.entry!.preview, noticeOf(ready))]
          : await storeIncomingBatch(runtime.db, workspaceId, ready.map(st => st.entry!), policy, noticeOf(ready));
        for (let i = 0; i < ready.length; i++) {
          const st = ready[i]!, row = storedRows[i];
          totalRunnable += row?.queued_count ?? 0;
          log('info', { code: 'MAILBOX_MESSAGE_INGESTED', workspaceId, status: st.status, spam: st.spam, rawMs: st.rawMs, waitMs: row?.wait_ms ?? 0, holdMs: row?.hold_ms ?? 0, lagMs: Date.now() - Date.parse(st.receipt!.createdAt), bytes: st.sizeBytes, attachments: st.attachmentsCount, batch: ready.length });
          outcomes.set(st.item.job.id, { id: st.item.job.id });
          reached(st);
          if (st.sourceKey!.startsWith(HELD_PREFIX)) await dropHeld(runtime, st.receipt!, workspaceId, st.sourceKey!);
        }
      } catch {
        // Isolate a single conflicting/invalid item (e.g. 40001 ownership/retention race) without failing siblings.
        for (const st of ready) {
          try {
            const e = st.entry!;
            const row = await storeIncoming(runtime.db, e.m, e.files, e.verifiedFrom, e.allowCreate, e.replyAuthorVerified, e.plan, policy, e.platformHosts, e.preview, noticeOf([st]));
            totalRunnable += row.queued_count;
            log('info', { code: 'MAILBOX_MESSAGE_INGESTED', workspaceId, status: st.status, spam: st.spam, rawMs: st.rawMs, waitMs: row.wait_ms, holdMs: row.hold_ms, lagMs: Date.now() - Date.parse(st.receipt!.createdAt), bytes: st.sizeBytes, attachments: st.attachmentsCount });
            outcomes.set(st.item.job.id, { id: st.item.job.id });
            reached(st);
            if (st.sourceKey!.startsWith(HELD_PREFIX)) await dropHeld(runtime, st.receipt!, workspaceId, st.sourceKey!);
          } catch (error) {
            await failState(st, error);
          }
        }
      }
      if (stored.length) await runtime.inboxWake?.notify(workspaceId, wakeTargets(stored.map(entry => entry!.plan)));
      if (totalRunnable > 0) try { await runtime.wake?.(totalRunnable, 'webhook'); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Mailbox webhook jobs remain durable.' }); }
    }
  } finally {
    for (const s3 of s3Clients.values()) s3.destroy();
    for (const st of active) { mimeBytes -= st.reserved; inProgress.delete(st.key); }
  }
  return items.map(i => outcomes.get(i.job.id) ?? { id: i.job.id });
}

const mailboxIngestHandler: JobHandler = Object.assign(
  async (runtime: Runtime, payload: Record<string, unknown>, job: Parameters<JobHandler>[2]) => {
    let reserved = 0;
    const key = JSON.stringify([job.workspaceId, payload.sesMessageId]), claim: { recipients?: string[]; createdAt?: string } = { recipients: job.ingest?.recipients, createdAt: job.ingest?.createdAt };
    if (inProgress.has(key)) throw new JobDeferred(new Date(Date.now() + 2000).toISOString());
    inProgress.add(key);
    try {
      await ingestJob(runtime, payload, job, size => {
        const bytes = Math.min(PARSE_LIMIT, Math.max(128 * 1024, size));
        if (mimeBytes + bytes > PARSE_LIMIT) throw new JobDeferred(new Date(Date.now() + 2000).toISOString());
        mimeBytes += bytes;
        reserved = bytes;
      }, claim);
    } catch (error) {
      const outErr = await finalizeIngestError(runtime, payload, job, claim, error);
      if (outErr !== undefined) throw outErr;
    } finally {
      mimeBytes -= reserved;
      inProgress.delete(key);
    }
  },
  { batch: ingestBatch },
);

const claimUnroutedJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  const mailboxId = String(payload.mailboxId ?? '');
  if (!mailboxId) return;
  const { drainClaimUnrouted } = await import('./mailbox-store.js');
  const res = await drainClaimUnrouted(runtime, job.workspaceId, mailboxId);
  if (!res.done) throw new JobDeferred(new Date(Date.now() + 250).toISOString());
  // If an alias or rule was added while this job was running, queueClaimUnrouted marked rescan:true.
  const { rows: [again] } = await runtime.db.execute<{ rescan: boolean }>(sql`UPDATE jobs SET payload=payload-'rescan' WHERE id=${job.id} AND payload->>'rescan'='true' RETURNING true AS rescan`);
  if (again?.rescan) throw new JobDeferred(new Date(Date.now() + 100).toISOString());
});

export const mailboxIngestJobs: Record<string, JobHandler> = { ...stagingJobs, 'mail.archiveSent': retryDatabaseFailures(async (r, p, j) => (await import('./mailbox-send.js')).archiveSentMessage(r, j.workspaceId, String(p.messageId))), 'mail.deleteObjects': deleteMailObjects, [recoveryPage]: retryDatabaseFailures(async runtime => recoverMailReceipts(runtime, true)), 'mailbox.claimUnrouted': claimUnroutedJob, 'mailbox.ingest': mailboxIngestHandler };
