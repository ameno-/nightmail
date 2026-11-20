import { ApiError, digest, type Runtime } from './core.js';
import type { EmailSnapshot } from './db/sending.js';
import { VISIBLE_WORDS } from './screened-html.js';
import { formattedSender } from './sending.js';
import { SEND_LIMITS } from './send-limits.js';

// Opt-in content screen for live transactional mail (`screen: true`): asks Jev, TypeSafe AI's decision
// model (directly or through OpenCode's inference gateway, per JEV_ENDPOINT), how likely a message is advertising smuggled into a transactional template (for example a
// gambling ad set as a workspace name in an invitation). The dispatcher decides what to do with the score.

const MAX_BODY = 8000;
// Link signals (every host a message links or loads, and link labels that name another host) repeat in each request.
const MAX_SIGNALS = SEND_LIMITS.screen.linkHosts, MAX_SIGNAL_BYTES = SEND_LIMITS.screen.linkHostBytes, OVERLAP = 256;
/** Requests the longest text a limit admits needs: windows of a request less the most signals, overlapping by 256 bytes
 *  and a few bytes less at UTF-8 boundaries. With the most signals (3,000 bytes) a window holds 4,999 bytes of text and
 *  each later one 4,737 new, so 64 KiB (the message limit) takes at most 14 and 128 KiB (a campaign copy's) 28. A message
 *  with few hosts gets wider windows (its own signals, not the most, are subtracted) and needs fewer: about 9 and 18. */
export const chunksFor = (limitBytes: number) => { const width = MAX_BODY - MAX_SIGNAL_BYTES - 1; return 1 + Math.ceil(Math.max(0, limitBytes - width) / (width - OVERLAP - 6)); };
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const DEADLINE_MS = 500;
const QUESTIONS = {
  spam: {
    type: 'noul',
    instructions: 'For transactional mail, detect unsolicited advertising smuggled into a receipt, invitation or notification. For marketing, do not flag ordinary subscribed promotions: flag deceptive impersonation, credential theft, scams or unrelated malicious pitches.',
    criteria: {
      true: 'The message exists to advertise or lure the recipient to a third-party site, contact or offer unrelated to the sending service',
      false: 'A genuine transactional message: invitation, receipt, code, notification or similar, even if a name in it is unusual',
    },
  },
};

export type ScreenResult = { spam: number; model: string };
// Bulk invitations repeat identical content, so one verdict serves every copy for an hour.
// Insertion order is age order: the first key is always the oldest entry.
const cache = new Map<string, { expires: number; result: ScreenResult }>();
const flights=new WeakMap<Runtime['storage'],Map<string,Promise<ScreenResult>>>();

// The text as a reader sees it: compatibility forms folded, and the characters that draw nothing (format controls,
// combining marks, Hangul fillers and other default-ignorable code points) removed.
const normalize = (s: string) => s.normalize('NFKC').replace(/[\p{Cf}\p{Mn}\p{Default_Ignorable_Code_Point}]/gu, '');
function copy(s = '') {
  const sentences = normalize(s).split(/\n+|(?<=[.!?])\s+/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [...new Set(sentences)].join(' ');
}
const bytes = (n: number) => n.toLocaleString('en-US');
function refused(message: string, details?: Record<string, unknown>, index?: number) {
  const error = new ApiError(422, 'CONTENT_TOO_LARGE_TO_SCREEN', message, index === undefined ? undefined : `emails.${index}`);
  if (details) error.details = [{ ...details, ...(index === undefined ? {} : { index }) }];
  return error;
}
const unreadable = () => refused('Shorten the message so Hosted sending can screen it.');
/** Over the screened-text limit: the measured size and the limit, so the sender knows how much to cut. */
export const tooLarge = (screenedBytes: number, limitBytes: number, scope: 'message' | 'campaign' = 'message', index?: number) =>
  refused(`The screened text is ${bytes(screenedBytes)} UTF-8 bytes; Hosted sending screens at most ${bytes(limitBytes)} per ${scope}. It counts the HTML's text (with its alt and title text), the text part and raw MIME. Shorten the copy by ${bytes(screenedBytes - limitBytes)} bytes.`,
    { screenedBytes, limitBytes }, index);
const tooManyHosts = (linkHosts: number, index?: number) =>
  refused(`The message links to or loads ${linkHosts} distinct hosts (counting link labels that name another host); Hosted sending screens at most ${MAX_SIGNALS}, with ${bytes(MAX_SIGNAL_BYTES)} bytes of host names in all. Link to fewer domains.`,
    { linkHosts, linkHostLimit: MAX_SIGNALS }, index);
// Repeat link signals and a little preceding context in each window. Split on
// UTF-8 boundaries; a clean result is meaningful only after the last window.
function completeBodies(content: string, links: string, limitBytes: number, scope: 'message' | 'campaign' = 'message') {
  const bytes = Buffer.from(content), prefix = links ? links+'\n' : '', most = chunksFor(limitBytes);
  if (bytes.length > limitBytes) throw tooLarge(bytes.length, limitBytes, scope);
  if (Buffer.byteLength(links) > MAX_SIGNAL_BYTES) throw tooManyHosts(links.split('\n').length);
  const bodies: string[] = [], width = MAX_BODY - Buffer.byteLength(prefix);
  let start = 0;
  do {
    if (bodies.length === most) throw tooLarge(bytes.length, limitBytes, scope);
    let end = Math.min(bytes.length, start + width);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    bodies.push(prefix + bytes.toString('utf8', start, end));
    if (end === bytes.length) break;
    start = end - OVERLAP;
    while ((bytes[start]! & 0xc0) === 0x80) start--;
  } while (true);
  return bodies;
}
function host(value: string) {
  try { return new URL(value.startsWith('//') ? 'https:'+value : value).hostname.toLowerCase(); } catch { return ''; }
}
const INLINE=new Set(['a','abbr','b','bdi','bdo','big','cite','code','data','del','dfn','em','font','i','ins','kbd','label','mark','q','s','samp','small','span','strike','strong','sub','sup','time','tt','u','var','wbr','img','input','button','select','textarea','output','meter','progress','picture','source','svg','text','tspan','math','mi','mo','mn','ruby','rt','rp','nobr']);
/**
 * An HTML body as the screen reads it: the text a client lays out, every host it links or loads, anchors whose text
 * names another host than their href, and its links and images (for the support lint, src/deliverability.ts).
 */
export async function readHtml(html: string, visit?: (tag: string) => void) {
  const { boundedHtmlFragment } = await import('./bounded-html.js');
  if (html.length>512*1024) throw unreadable();
  const fragment=boundedHtmlFragment(html,'fragment',{clients:true});
  if (!fragment) throw unreadable();
  const hosts=new Set<string>(), mismatches=new Set<string>(), links:string[]=[], images:{ alt: boolean }[]=[];
  // Text as a client lays it out: inline runs stay one word, block elements end the line, and text a client shows
  // beside the flow (alt, title) follows on its own lines, as does a table row whose cells hold short pieces read
  // glued, the way a recipient reads a word laid out across adjacent cells.
  const lines:string[]=[], aside:string[]=[], rows:string[][]=[]; let line='';
  const flush=()=>{ if(line.trim()) lines.push(line); line=''; };
  const walk=(node:typeof fragment.childNodes[number], anchor:string)=>{
    if ('value' in node) {
      line+=node.value;
      if(anchor) for(const word of normalize(node.value).split(/\s+/)) {
        if(!word.includes('.') || word.length>2048)continue;
        const label=host(word.includes('://')?word:'https://'+word);
        if(label && label!==anchor) mismatches.add(`${label} → ${anchor}`);
      }
      return;
    }
    const children='childNodes' in node ? node.childNodes : [];
    if (!('tagName' in node)) { for (const child of children) walk(child,anchor); return; }
    const tag=node.tagName;
    visit?.(tag);
    if (['style','script','template','head','title','xml'].includes(tag)) return;
    let display='';
    for (const a of node.attrs) {
      if (['href','src','srcset','background','action','style'].includes(a.name)) {
        for(const m of normalize(a.value).matchAll(/(?:https?:)?\/\/[^\s,)'"<>]+/gi)) { const h=host(m[0]); if(h) hosts.add(h); }
        if(tag==='a' && a.name==='href') { anchor=host(normalize(a.value)); links.push(normalize(a.value)); }
      }
      if (a.name==='style') display=/(?:^|;)\s*display\s*:\s*([a-z-]+)/i.exec(a.value)?.[1]?.toLowerCase() ?? '';
      if (['alt','title'].includes(a.name) && a.value.trim()) aside.push(a.value);
    }
    if (tag==='img') images.push({ alt: node.attrs.some(a=>a.name==='alt' && !!a.value.trim()) });
    const inline=display ? display.startsWith('inline') : INLINE.has(tag);
    if (!inline) flush();
    const start=lines.length;
    if (tag==='tr') rows.push([]);
    for (const child of children) walk(child,anchor);
    if (!inline) flush();
    if (tag==='td' || tag==='th') rows[rows.length-1]?.push(lines.slice(start).join(' '));
    if (tag==='tr') { const cells=rows.pop()!; if (cells.length>1 && cells.some(cell=>cell.trim() && cell.trim().length<=4)) aside.push(cells.join('')); }
  };
  for (const child of fragment.childNodes) walk(child,'');
  flush();
  return { text: [...lines,...aside].join('\n'), hosts, mismatches, links, images };
}
export function screenTextSignals(visible: string, text?: string, rawPart?: string) {
  // Preserve order and repetitions in mandatory input; deduplicating sentences
  // could change the meaning or make an over-limit message appear to fit.
  const project=(s='')=>normalize(s).replace(/\s+/g,' ').trim();
  const plain=project(text), raw=project(rawPart), rendered=project(visible);
  const words=(v:string)=>new Set(v.toLowerCase().match(VISIBLE_WORDS));
  function overlap(text:string, html:string) {
    const a=words(text), b=words(html), common=[...a].filter(w=>b.has(w)).length;
    return a.size && b.size ? common/(a.size+b.size-common) : undefined;
  }
  return { content:[rendered,plain,raw].filter(Boolean).join('\n'), textHtmlOverlap:overlap(plain,rendered) };
}
export type ScreenMeasure = { signals: string[]; content: string; textHtmlOverlap?: number; screenedBytes: number };
/** What the screen reads of a message, measured without asking the classifier: the same text and link signals it sends. */
export async function measureScreen(snapshot: Pick<EmailSnapshot, 'html' | 'text' | 'raw'>): Promise<ScreenMeasure> {
  const read=snapshot.html ? await readHtml(snapshot.html) : undefined;
  const signals=read ? [...read.mismatches,...read.hosts] : [];
  const {content,textHtmlOverlap}=screenTextSignals(read?.text ?? '',snapshot.text,snapshot.raw);
  return { signals, content, textHtmlOverlap, screenedBytes: Buffer.byteLength(content) };
}
/** Refuses a message the screen cannot read within a limit, with the measured size; `index` names a batch item. */
export function assertScreenable(measure: ScreenMeasure, limitBytes: number, scope: 'message' | 'campaign' = 'message', index?: number) {
  if (measure.signals.length>MAX_SIGNALS || Buffer.byteLength(measure.signals.join('\n'))>MAX_SIGNAL_BYTES) throw tooManyHosts(measure.signals.length,index);
  if (measure.screenedBytes>limitBytes) throw tooLarge(measure.screenedBytes,limitBytes,scope,index);
}
async function body(snapshot: EmailSnapshot, limitBytes: number, scope: 'message' | 'campaign' = 'message') {
  const measure=await measureScreen(snapshot);
  assertScreenable(measure,limitBytes,scope);
  return { bodies:completeBodies(measure.content,measure.signals.join('\n'),limitBytes,scope), textHtmlOverlap:measure.textHtmlOverlap };
}
export async function jevQuestions(endpoint:string,apiKey:string,model:string,state:unknown,questions:unknown,deadline:number):Promise<unknown> {
  // The deadline includes reading the response body. Never retry inside a send lease.
  let response: Response;
  try {
    response = await fetch(endpoint, {
      // Never follow a redirect: the key and the message body go only to the configured endpoint. Workers
      // reject redirect: 'error', so use 'manual'; a 3xx is not ok and counts as unavailable below.
      method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, state, questions }), signal: AbortSignal.timeout(deadline),
    });
  } catch {
    throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'The content classifier could not be reached.', undefined, true);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', `The content classifier failed with HTTP ${response.status}.`, undefined, true);
  }
  const reader=response.body?.getReader(); if(!reader)return null;
  const chunks:Uint8Array[]=[];let bytes=0;for(;;){const {value,done}=await reader.read();if(done)break;if((bytes+=value.length)>32768){await reader.cancel();return null}chunks.push(value)}
  try{return JSON.parse(Buffer.concat(chunks).toString())}catch{return null}
}
async function evaluate(endpoint: string, apiKey: string, model: string, state: unknown): Promise<ScreenResult> {
  const parsed = await jevQuestions(endpoint,apiKey,model,state,QUESTIONS,DEADLINE_MS) as { model?: unknown; answers?: { spam?: { noul?: unknown } } } | null;
  const spam = parsed?.answers?.spam?.noul;
  if (typeof spam !== 'number' || !Number.isFinite(spam) || spam<0 || spam>1) throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'The content classifier returned no valid spam score.', undefined, true);
  return { spam, model: typeof parsed?.model === 'string' ? parsed.model : model };
}

// The classifier's input for a snapshot: what screenSnapshot sends it, request by request.
function classifierState(snapshot: EmailSnapshot, required: boolean, textHtmlOverlap: number | undefined) {
  const sender=copy(formattedSender(snapshot.from, snapshot.fromName)), subject=copy(snapshot.subject), recipients=snapshot.to.length+snapshot.cc.length+snapshot.bcc.length;
  return (body: string) => ({email:{from:required?sender:sender.slice(0,100),kind:snapshot.kind,subject:required?subject:subject.slice(0,200),body},signals:{recipients,textHtmlOverlap}});
}
/** Spam probability for one snapshot, or null when the installation has no classifier configured. A campaign test has
 *  the campaign limit. `reserve` is told how many requests a classification will make before the first one. */
export async function screenSnapshot(runtime: Runtime, snapshot: EmailSnapshot, required=false, reserve?: (requests: number) => Promise<void>): Promise<ScreenResult | null> {
  const settings = runtime.config.screen;
  if (!settings) return null;
  const from = formattedSender(snapshot.from, snapshot.fromName);
  const recipients=snapshot.to.length+snapshot.cc.length+snapshot.bcc.length;
  const key = await digest(JSON.stringify([runtime.config.workspaceId,settings.endpoint,settings.model,required,from,snapshot.kind,snapshot.subject,snapshot.text,snapshot.html,snapshot.raw,recipients]));
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.result;
  if (hit) cache.delete(key);
  // Concurrent copies share one request; failures are not cached so the next copy retries.
  let pending=flights.get(runtime.storage);if(!pending){pending=new Map();flights.set(runtime.storage,pending);}
  const existing=pending.get(key);if(existing)return existing;
  const limits=runtime.config.screenLimits, test=!!snapshot.testCampaignId;
  const lookup=body(snapshot,test ? limits.campaignBytes : limits.messageBytes,test ? 'campaign' : 'message').then(async ({bodies,textHtmlOverlap})=>{
    await reserve?.(bodies.length);
    const state=classifierState(snapshot,required,textHtmlOverlap);
    let highest: ScreenResult | undefined;
    for (const body of bodies) {
      const result=await evaluate(settings.endpoint,settings.apiKey,settings.model,state(body));
      if (!highest || result.spam>highest.spam) highest=result;
    }
    return highest!;
  });pending.set(key,lookup);
  try{const result=await lookup;cache.set(key,{expires:now+TTL_MS,result});
    while(cache.size>MAX_ENTRIES)cache.delete(cache.keys().next().value!);return result;
  }finally{pending.delete(key);}
}

// A Hosted campaign is screened copy by copy, exactly as single messages are, but each distinct copy only once
// (src/sending.ts campaignVerdicts): a copy's verdict is keyed by the copy as it is delivered (copyKey), so recipients
// whose copies are the same share it.

/** A campaign's screening state, on its review (sending_campaign_reviews.screen). */
export type CampaignScreen = {
  /** The review content it belongs to (sending_campaign_reviews.content_hash). */
  contentHash: string; probation: boolean;
  /** The campaign's own copy, placeholders unresolved, screened first as an early refusal. */
  template: { key: string; spam: number; model: string } | null;
  /** Recipients whose copies have verdicts, in send order, and how many of them were refused as spam. */
  screenedThrough: number; recipients: number; rejected: number;
  /** Classifier outages in a row, for the wait before the next attempt; whether the refused share paused it once. */
  failures: number; quarantined: boolean;
};
/**
 * A campaign copy's verdict key: the classifier and model, and the copy exactly as it is delivered (sender, reply-to,
 * subject, HTML, text and raw parts, its headers and attachments), built with the slots Nightmail adds per recipient
 * (the unsubscribe footer's link and the List-Unsubscribe headers) generated for the placeholder link
 * (src/sending.ts screenedAs) rather than the recipient's. The recipient's address isn't part of it.
 */
export async function copyKey(runtime: Runtime, snapshot: EmailSnapshot): Promise<string> {
  const settings = runtime.config.screen;
  return digest(JSON.stringify([settings?.endpoint ?? null, settings?.model ?? null, snapshot.kind, snapshot.from, snapshot.fromName ?? null, snapshot.replyTo,
    snapshot.subject, snapshot.html ?? null, snapshot.text ?? null, snapshot.raw ?? null, snapshot.headers, snapshot.attachments, snapshot.tracking]));
}
/** What the classifier is sent for one campaign copy, request by request: what screenSnapshot sends for that copy as
 *  required Hosted mail to its one recipient, with the campaign limit. */
export type ScreenInput = { requests: unknown[] };
/** A campaign copy's screen input, refused past the campaign limit. */
export async function screenInput(runtime: Runtime, snapshot: EmailSnapshot): Promise<ScreenInput> {
  const { bodies, textHtmlOverlap } = await body(snapshot, runtime.config.screenLimits.campaignBytes, 'campaign');
  const state = classifierState({ ...snapshot, to: ['recipient'], cc: [], bcc: [] }, true, textHtmlOverlap);
  return { requests: bodies.map(state) };
}
/** One request of a campaign copy's screen. */
export async function screenWindow(runtime: Runtime, input: ScreenInput, window: number): Promise<ScreenResult> {
  const settings = runtime.config.screen;
  if (!settings) throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'Hosted content screening is unavailable.', undefined, true);
  return evaluate(settings.endpoint, settings.apiKey, settings.model, input.requests[window]);
}
