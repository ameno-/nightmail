// Dashboard analytics (docs/analytics.md): the event vocabulary and the scrubbers that both the dashboard
// (app/src/lib/analytics.ts) and the ingest (src/analytics.ts) apply, so what leaves a browser and what is stored follow
// one set of rules. No imports: the dashboard bundles this file.

export const ANALYTICS_PATH = '/internal/v1/analytics';
/** sign_in is written by the API alone, at the sign-in callback: it links a signed-out page's session to the account. */
export const ANALYTICS_EVENT_TYPES = ['page_view', 'page_hide', 'click', 'dialog_open', 'dialog_close', 'form_submit', 'form_invalid', 'api_error', 'track', 'sign_in', 'bot_view'] as const;
export type AnalyticsEventType = typeof ANALYTICS_EVENT_TYPES[number];
/** The funnel steps the dashboard reports with track(). focus_chosen names the picks, the lead first: focus/agents/developer,
 *  or focus/skip; or landing/agents[/<comparison page slug>] for a focus a landing link brought. */
export const FUNNEL_STEPS = ['signed_up', 'domain_added', 'domain_verified', 'first_send', 'key_created', 'inbox_created', 'campaign_sent', 'byo_connected', 'focus_chosen'] as const;
export type FunnelStep = typeof FUNNEL_STEPS[number];
/** Why a field failed the browser's own validation: a ValidityState flag, never the value. */
export const VALIDITY_REASONS = ['badInput', 'customError', 'patternMismatch', 'rangeOverflow', 'rangeUnderflow', 'stepMismatch', 'tooLong', 'tooShort', 'typeMismatch', 'valueMissing'] as const;
export const VIEWPORTS = ['phone', 'tablet', 'desktop'] as const;
export const ANALYTICS_LIMITS = { bodyBytes: 32 * 1024, events: 50, label: 40 } as const;

/** The return-URL parameter that carries a signed-out page's session ID through sign-in (src/account-login.ts). The
 *  callback removes it before redirecting, so the browser never opens a URL with it. */
export const ANALYTICS_SESSION_PARAM = 'analyticsSession';
/** A session or event ID: random letters and digits, held in a page's memory. */
export const analyticsId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(value) ? value : null;

/** A data-analytics name: lowercase words joined by - and /, such as domains/add. Code names it, so it is never data. */
export const analyticsName = (value: unknown) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}(?:\/[a-z0-9-]{1,32}){0,5}$/.test(value) ? value : null;

/** Label text, truncated, with anything shaped like data replaced: addresses, links, domains, IDs, tokens and digits. */
export function scrubLabel(value: unknown, max: number = ANALYTICS_LIMITS.label): string | null {
  if (typeof value !== 'string') return null;
  const text = value.slice(0, 400).normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\S*@\S*/g, '[email]')
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/gi, '[url]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
    .replace(/\b[a-z]{1,12}_[a-z0-9_]{6,}\b/gi, '[id]')
    .replace(/(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,}\b/gu, '[domain]')
    .replace(/\S{25,}/g, run => /\d/.test(run) ? '[token]' : run)
    .replace(/\p{N}+/gu, '#')
    .replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max).trim() : null;
}

const SEGMENT = /^(?::[a-z][A-Za-z]{0,20}|\*|[a-z][a-z-]{0,30}|v\d)$/;
/** A path as a route template: any segment that isn't a lowercase word or a :param becomes :id. No query or fragment. */
export function routeTemplate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  const segments = value.split(/[?#]/, 1)[0]!.slice(1).split('/');
  if (segments.length > 10) return null;
  return '/' + segments.map(segment => segment === '' || SEGMENT.test(segment) ? segment : ':id').join('/');
}

/** An API request as its method and route template: POST /v1/domains/:id/verify. */
export function operationTemplate(value: unknown): string | null {
  const match = typeof value === 'string' ? /^(GET|HEAD|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(value) : null;
  const path = match && routeTemplate(match[2]);
  return path ? match![1] + ' ' + path : null;
}

/** A form field or an API error's field path: array indexes become #, and anything that isn't a name becomes ?. */
export function fieldName(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return value.split(/[.[\]]+/).filter(Boolean).slice(0, 6).map(part => /^\d+$/.test(part) ? '#' : /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(part) ? part : '?').join('.') || null;
}

/** The viewport class, at the shell's breakpoints: a phone below 640 px, a tablet below 900. */
export const viewportClass = (width: number): typeof VIEWPORTS[number] => width < 640 ? 'phone' : width < 900 ? 'tablet' : 'desktop';
