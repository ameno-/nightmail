// Renders every email Nightmail sends a customer about their account, for review: today's (standing.ts noticeText,
// billing/notify.ts noticeEmail, called as the jobs call them) and the proposed set (src/notices.ts), each through the
// product's own mail-client emulation (src/email-preview). Nothing is sent and no database is read.
//   node --import tsx scripts/render-notices.ts <out-dir>
// Writes <out-dir>/notices.json: each email's subject, text and HTML, and one emulated document per picture.
// app/scripts/notice-shots.mjs turns those into PNGs and contact sheets.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { noticeEmail, type NoticeContext } from '../src/billing/notify.js';
import { microCents } from '../src/billing/money.js';
import type { NoticeKind as BillingKind } from '../src/billing/types.js';
import { publicOrigin } from '../src/brand.js';
import { emulate, type Client } from '../src/email-preview/index.js';
import { customerNotice, type NoticeInput } from '../src/notices.js';
import { evaluateLadder, type Reason, type Step, type Window } from '../src/standing-model.js';
import { noticeText } from '../src/standing.js';

const out = process.argv[2];
if (!out) throw new Error('Usage: node --import tsx scripts/render-notices.ts <out-dir>');
const workspace = 'Driftwood', origin = publicOrigin, from = 'system@nightmail.dev';
const date = (iso: string) => new Date(iso + 'T12:00:00Z');
const escapeHtml = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// A message with only a text part, as a mail client shows it: its lines kept, in the client's own font.
const textAsHtml = (text: string) => '<!doctype html><html><head></head><body><div style="white-space:pre-wrap">' + escapeHtml(text) + '</div></body></html>';

type Email = { name: string; title: string; set: 'today' | 'proposed'; to: string; subject: string; text: string; html: string | null };
type Shot = { file: string; email: string; client: Client; device: 'desktop' | 'mobile'; theme: 'light' | 'dark'; part: 'html' | 'text'; document: string };
const emails: Email[] = [], shots: Shot[] = [];
const shot = (file: string, email: Email, client: Client, device: Shot['device'], theme: Shot['theme'], part: Shot['part'] = email.html ? 'html' : 'text') =>
  shots.push({ file, email: email.name, client, device, theme, part, document: emulate(part === 'html' ? email.html! : textAsHtml(email.text), { client, device, theme }).html });

// ---------- today ----------
const window = (w: Partial<Window>): Window => ({ accepted: 0, bounces: 0, complaints: 0, marketingAccepted: 0, marketingBounces: 0, marketingComplaints: 0, ...w });
const ladder = (day: Partial<Window>) => evaluateLadder({ day: window(day), week: window(day), screened: 0, rejected: 0 }).reasons;
const standing = (name: string, title: string, step: Step, reasons: Reason[], quarantine: { campaign: string; message: string } | null = null) => {
  const email: Email = { name, title, set: 'today', to: 'owners and admins', html: null, ...noticeText({ workspace, step, reasons, quarantine, origin, marketingHeld: step === 'restrict' }) };
  emails.push(email); shot('today-' + name + '.png', email, 'gmail-web', 'desktop', 'light');
};
standing('warned', 'Standing drops to warn', 'warn', ladder({ accepted: 4200, bounces: 96 }));
standing('restricted', 'Standing drops to restrict', 'restrict', ladder({ accepted: 5000, bounces: 210, marketingAccepted: 4400, marketingBounces: 204 }));
standing('paused', 'Standing drops to pause', 'pause', ladder({ accepted: 6000, complaints: 21 }));
// ingestTenantStatus's reason when SES gives no cause of its own.
standing('paused-by-amazon', 'Amazon pauses the SES tenant', 'pause', [{ code: 'SES_TENANT_PAUSED', metric: 'external', value: 0, count: 0, threshold: 0, minimum: 0, window: null, step: 'pause', message: 'AWS paused the SES tenant.' }]);
// campaignHealth's message for BOUNCE_RATE_HIGH (sending.ts).
standing('campaign-paused', 'A campaign pauses itself (Hosted)', 'ok', [], { campaign: 'Autumn catalogue', message: 'Paused automatically: 2.61% of 1840 accepted emails bounced (limit 2%). Review the audience before resuming.' });

const usd = (dollars: number) => microCents(BigInt(Math.round(dollars * 100)) * 1_000_000n);
const billing = (name: string, title: string, kind: BillingKind, context: Partial<NoticeContext>) => {
  const email: Email = { name, title, set: 'today', to: 'owners and admins', html: null,
    ...noticeEmail(kind, { workspace, link: origin + '/settings#billing', totalUc: usd(0), freeLeft: 0, unpaidSince: null, receiveHold: true, data: {}, ...context }) };
  emails.push(email); shot('today-' + name + '.png', email, 'gmail-web', 'desktop', 'light');
};
billing('balance-low', 'Balance falls under the low mark', 'low_balance', { totalUc: usd(4.2) });
billing('out-of-credit', 'Balance reaches $0', 'sends_paused', { unpaidSince: date('2026-11-29') });
billing('recharge-failed', 'Auto-recharge is declined', 'recharge_failed', { totalUc: usd(3.1), data: { last4: '4242', code: 'card_declined' } });
billing('receive-hold-soon', 'Five days in debt', 'receive_hold_soon', { totalUc: usd(-1.84), unpaidSince: date('2026-11-29') });
billing('receive-held', 'Seven days in debt', 'receive_held', { totalUc: usd(-1.84), unpaidSince: date('2026-11-29') });
billing('credit-expiring', '30 days before credit expires', 'credit_expiring', { totalUc: usd(40), data: { remainingUc: String(usd(12)), expiresAt: '2026-12-22T00:00:00Z' } });

// ---------- proposed ----------
const proposed = (name: string, title: string, to: string, input: NoticeInput) => {
  const email: Email = { name, title, set: 'proposed', to, ...customerNotice(origin, input) };
  emails.push(email);
  for (const [device, client] of [['desktop', 'apple-mail-macos'], ['mobile', 'apple-mail-ios']] as const) for (const theme of ['light', 'dark'] as const)
    shot(name + '-' + (device === 'mobile' ? 'phone' : 'desktop') + (theme === 'dark' ? '-dark' : '') + '.png', email, client, device, theme);
  return email;
};
const members = 'owners and admins';
const paused = proposed('paused', 'Sending is paused (any cause, Amazon included)', members, { kind: 'paused', workspace });
proposed('restricted', 'Marketing is put on hold', members, { kind: 'restricted', workspace });
proposed('warned', 'A warning', members, { kind: 'warned', workspace });
proposed('resumed', 'A pause ends', members, { kind: 'resumed', workspace });
proposed('campaign-paused', 'A campaign pauses itself', members, { kind: 'campaign_paused', workspace, campaign: { id: 'cmp_8f3k2n', name: 'Autumn catalogue' } });
proposed('domain-unverified', 'A domain stops verifying', members, { kind: 'domain_unverified', workspace, domain: { id: 'dom_41xq7c', name: 'driftwood.example' } });
proposed('limit-reached', 'The daily limit is reached', members, { kind: 'limit_reached', workspace });
proposed('evaluation-passed', 'The new-sender evaluation ends well', members, { kind: 'evaluation_finished', workspace, limited: false });
proposed('evaluation-limited', 'The new-sender evaluation ends with a limit', members, { kind: 'evaluation_finished', workspace, limited: true });
proposed('balance-low', 'Balance is low', members, { kind: 'low_balance', workspace, balance: '$4.20', emails: 21000 });
proposed('out-of-credit', 'Balance is empty', members, { kind: 'out_of_credit', workspace, receivingUntil: date('2026-12-06') });
proposed('recharge-failed', 'Auto-recharge is declined', members, { kind: 'recharge_failed', workspace, last4: '4242', decline: 'the bank declined it', balance: '$3.10' });
proposed('receive-hold-soon', 'Two days before received mail is held', members, { kind: 'receive_hold_soon', workspace, owed: '$1.84', since: date('2026-11-29'), holdAt: date('2026-12-06') });
proposed('receive-held', 'Received mail is held', members, { kind: 'receive_held', workspace, owed: '$1.84', since: date('2026-11-29') });
proposed('credit-expiring', '30 days before credit expires', members, { kind: 'credit_expiring', workspace, amount: '$12.00', expiresAt: date('2026-12-22') });
proposed('invitation', 'A teammate is invited', 'the invited address', { kind: 'invitation', workspace, inviter: { name: 'Mara Lindqvist', email: 'mara@driftwood.example' }, role: 'admin', expiresAt: date('2026-11-29'),
  acceptUrl: origin + '/overview?invitation=inv_6t2m9d' });
proposed('waitlist', 'A waitlisted address is let in', 'the waitlisted address', { kind: 'waitlist_admitted' });

// ---------- the template, before and after, and the paused email in other clients ----------
const today = emails.find(e => e.set === 'today' && e.name === 'paused')!;
shot('template-today.png', today, 'gmail-web', 'desktop', 'light');
shot('template-text-part.png', paused, 'gmail-web', 'desktop', 'light', 'text');
shot('template-html-part.png', paused, 'gmail-web', 'desktop', 'light');
for (const [client, device, theme] of [['gmail-web', 'desktop', 'light'], ['outlook-web', 'desktop', 'light'], ['outlook-web', 'desktop', 'dark'], ['yahoo-web', 'desktop', 'light'],
  ['gmail-ios', 'mobile', 'dark'], ['gmail-android', 'mobile', 'dark'], ['samsung-email', 'mobile', 'dark']] as const)
  shot('client-' + client + (theme === 'dark' ? '-dark' : '') + '.png', paused, client, device, theme);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'notices.json'), JSON.stringify({ from, emails, shots }, null, 1));
console.log(emails.length + ' emails, ' + shots.length + ' pictures to take: ' + join(out, 'notices.json'));
