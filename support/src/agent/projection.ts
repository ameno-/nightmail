// Customer-safe projection (design §4.1): every support-route response passes through here before the model sees it.
// The model's context is, in effect, shown to the customer, so it gets only what the customer may see: no grant or
// operator internals, third-party text fenced as untrusted, and a bounded size.

/** Fields support routes return that are about Nightmail's side of the conversation, never the customer's data. */
const DROP = new Set(['grant', 'operatorId', 'operator', 'ticketRef', 'token', 'tokenHash', 'internal', 'ipNetwork', 'userAgent', 'actorLabel', 'retainUntil', 'watch', 'watchFlag', 'handoffId', 'via']);
/** Text written by other people (recipients, mail servers, the customer's own content): data, never instructions. */
const UNTRUSTED = new Set(['subject', 'diagnostic', 'diagnosticCode', 'text', 'html', 'snippet', 'lastError', 'pauseReason', 'reason', 'message', 'name', 'previewText', 'replyText', 'body']);
/**
 * Internal IDs of people and actors: the model never needs them (a conversation names its person itself), so they are
 * removed wherever they appear: these keys, and an `id` inside a user, actor, subject or member object. Workspace, domain,
 * campaign, delivery, request and target IDs stay: the tools take them.
 */
const PERSON_KEYS = new Set(['userId', 'user_id', 'actorId', 'actor_id', 'memberId', 'member_id', 'member']);
const PERSON_OBJECTS = new Set(['user', 'actor', 'subject', 'member']);
const HIDDEN = Symbol('hidden');
export const RESULT_LIMIT = 8192;

/** `hidden`: values removed wherever they appear (the conversation's own person and ID), whatever field holds them. */
export function project(value: unknown, depth = 0, key = '', hidden: readonly string[] = []): unknown {
  if (depth > 8) return '[…]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map(v => project(v, depth + 1, key, hidden)).filter(v => v !== HIDDEN);
    return value.length > 50 ? [...items, `[${value.length - 50} more not shown]`] : items;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP.has(k) || PERSON_KEYS.has(k) || (k === 'id' && PERSON_OBJECTS.has(key))) continue;
      const projected = project(v, depth + 1, k, hidden);
      if (projected !== HIDDEN) out[k] = projected;
    }
    return out;
  }
  if (typeof value === 'string' && hidden.includes(value)) return HIDDEN;
  if (typeof value === 'string') {
    const capped = value.length > 2000 ? `${value.slice(0, 2000)}… [${value.length - 2000} more characters]` : value;
    return UNTRUSTED.has(key) && capped.length > 0 && /[A-Za-z]{3}/.test(capped) ? `<untrusted>${capped.replaceAll('</untrusted>', '')}</untrusted>` : capped;
  }
  return value;
}

/** The tool result as the model reads it: projected JSON, at most RESULT_LIMIT bytes, without the `hidden` values. */
export function toolResult(value: unknown, hidden: readonly string[] = []): string {
  const projected = project(value, 0, '', hidden), text = JSON.stringify(projected === HIDDEN ? null : projected);
  if (text.length <= RESULT_LIMIT) return text;
  return `${text.slice(0, RESULT_LIMIT - 120)}… [truncated: ask for a narrower window, one workspace or the next page]`;
}
