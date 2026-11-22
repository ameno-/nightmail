import { addresses, productName } from './brand.js';

// Every email Nightmail sends a customer about their account, in one template. A notice is three short plain
// paragraphs (what happened, what it means for their mail right now, what to do next), one link and one line saying
// why it was sent. customerNotice() is pure and returns the subject with a text part and an HTML part that carry the
// same words; the HTML part sets a line length, the link as a button and its own dark colours, and nothing else (no
// images, no background). A notice never says how a check works: no scores, rates, thresholds or provider names.
//
// Proposal (emails/customer-notices): nothing sends these yet. standing.ts (noticeText) and billing/notify.ts
// (noticeEmail) still write today's emails; scripts/render-notices.ts renders both sets side by side.

export type Notice = { subject: string; text: string; html: string };
type Parts = { subject: string; lines: string[]; action: { label: string; url: string }; why: string };

const escapeHtml = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
/** A customer's name (workspace, campaign, person) on one bounded line, so a subject is always a valid header. */
export const oneLine = (v: string, fallback: string) => v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 100) || fallback;
const day = (value: Date) => value.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const count = (value: number) => value.toLocaleString('en-US');

// The dashboard's ink, muted text and primary button (app/src/styles/tokens.css), light and dark. Colours a client
// can't override stay readable on its own canvas: the page sets no background.
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DARK = '@media (prefers-color-scheme:dark){.nm-text{color:#ededed!important}.nm-why{color:#a3a3a3!important;border-top-color:#2e2e2e!important}.nm-action{background:#314770!important;border-color:#556f9d!important;color:#ffffff!important}}';

/** One notice as an email: the same words as text and as HTML. */
export function notice(p: Parts): Notice {
  const text = `${p.lines.join('\n\n')}\n\n${p.action.label}: ${p.action.url}\n\n${p.why}\n`;
  const paragraphs = p.lines.map(line => `<p style="margin:0 0 14px">${escapeHtml(line)}</p>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(p.subject)}</title><style>${DARK}</style></head>`
    + `<body style="margin:0;padding:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px 16px 28px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px"><tr><td class="nm-text" style="font:15px/1.6 ${FONT};color:#171717">`
    + `${paragraphs}<p style="margin:22px 0 0"><a class="nm-action" href="${escapeHtml(p.action.url)}" style="display:inline-block;padding:8px 16px;border:1px solid #223459;border-radius:6px;background:#223459;color:#ffffff;font-weight:500;text-decoration:none">${escapeHtml(p.action.label)}</a></p>`
    + `<p class="nm-why" style="margin:32px 0 0;padding-top:14px;border-top:1px solid #e4e4e4;font-size:13px;line-height:1.5;color:#5d5d5d">${escapeHtml(p.why)}</p>`
    + '</td></tr></table></td></tr></table></body></html>';
  return { subject: p.subject, text, html };
}

type Workspace = { workspace: string };
export type NoticeInput =
  | Workspace & { kind: 'paused' | 'restricted' | 'warned' | 'resumed' | 'limit_reached' }
  | Workspace & { kind: 'campaign_paused'; campaign: { id: string; name: string } }
  | Workspace & { kind: 'domain_unverified'; domain: { id: string; name: string } }
  | Workspace & { kind: 'evaluation_finished'; limited: boolean }
  | Workspace & { kind: 'low_balance'; balance: string; emails: number }
  | Workspace & { kind: 'out_of_credit'; receivingUntil: Date | null }
  | Workspace & { kind: 'recharge_failed'; last4: string | null; decline: string; balance: string }
  | Workspace & { kind: 'receive_hold_soon'; owed: string; since: Date; holdAt: Date }
  | Workspace & { kind: 'receive_held'; owed: string; since: Date }
  | Workspace & { kind: 'credit_expiring'; amount: string; expiresAt: Date }
  | Workspace & { kind: 'invitation'; inviter: { name: string; email: string }; role: 'owner' | 'admin' | 'member'; expiresAt: Date; acceptUrl: string }
  | { kind: 'waitlist_admitted' };
export type NoticeKind = NoticeInput['kind'];

/**
 * The notice for one moment in a customer's account. `origin` is the dashboard's (PUBLIC_URL). Pausing has one email
 * whatever paused the workspace: the ladder, a review or the provider.
 */
export function customerNotice(origin: string, n: NoticeInput): Notice {
  const base = origin.replace(/\/$/, ''), w = 'workspace' in n ? oneLine(n.workspace, 'your workspace') : '';
  const members = `${productName} sent this to the owners and admins of ${w}. To reach us, write to ${addresses.support}.`;
  const dashboard = { label: 'Open the dashboard', url: `${base}/overview` }, billing = (label: string) => ({ label, url: `${base}/settings#billing` });
  switch (n.kind) {
    case 'paused': return notice({ subject: `Sending is paused for ${w}`, action: dashboard, why: members, lines: [
      `${productName} has paused all sending from ${w} because of a problem with its recent mail.`,
      'Nothing is going out. Queued mail is held for 72 hours, then canceled. Receiving, inboxes and the dashboard keep working.',
      'The dashboard shows what went wrong and what happens next.'] });
    case 'restricted': return notice({ subject: `Marketing mail is on hold for ${w}`, action: dashboard, why: members, lines: [
      `${productName} has put marketing mail from ${w} on hold because of a problem with its recent mail.`,
      'Campaigns are paused and new marketing mail is refused. Receipts, password resets and other transactional mail still send.',
      'The dashboard shows what to fix and when marketing can resume.'] });
    case 'warned': return notice({ subject: `A warning about mail from ${w}`, action: dashboard, why: members, lines: [
      `Recent mail from ${w} has had too many bounces or spam complaints.`,
      'Nothing is held and your mail still sends. If it continues, marketing mail will be put on hold.',
      'The dashboard shows which mail caused it. The warning clears on its own once things improve.'] });
    case 'resumed': return notice({ subject: `Sending has resumed for ${w}`, action: dashboard, why: members, lines: [
      `Sending from ${w} is on again.`,
      'New mail goes out as usual, and mail that was still held is being sent. For the next two days the daily limit may be lower than before.',
      'The dashboard shows the limit.'] });
    case 'limit_reached': return notice({ subject: `${w} has reached its daily sending limit`, action: dashboard, why: members, lines: [
      `${w} has sent as much mail as its daily limit allows.`,
      'New mail is refused for now. Room frees up over the next 24 hours, and mail already accepted is still delivered.',
      'The dashboard shows the limit and what raises it.'] });
    case 'evaluation_finished': return notice(n.limited
      ? { subject: `The evaluation of ${w} is finished`, action: dashboard, why: members, lines: [
        `The first emails from ${w} had delivery problems, so it keeps a daily limit for now.`,
        'Mail within the limit sends as usual. The limit rises on its own as delivery improves.',
        'The dashboard shows the limit and what would raise it.'] }
      : { subject: `${w} has passed its evaluation`, action: dashboard, why: members, lines: [
        `The first emails from ${w} were delivered well, so its starting limit is lifted.`,
        'You can send more now. Over the next few days the amount grows on its own as your mail keeps being delivered.',
        'The dashboard shows how much you can send right now.'] });
    case 'campaign_paused': {
      const name = oneLine(n.campaign.name, 'A campaign');
      return notice({ subject: `The campaign "${name}" is paused`, action: { label: 'Open the campaign', url: `${base}/campaigns/${encodeURIComponent(n.campaign.id)}/review` }, why: members, lines: [
        `${productName} paused the campaign "${name}" before it finished, because of a problem with its recipients or its content.`,
        'People it already reached keep their email. Nobody else is sent to until you resume it. Your other mail is not affected.',
        'The campaign’s page shows what to check before you resume or cancel it.'] });
    }
    case 'domain_unverified': {
      const name = oneLine(n.domain.name, 'A domain');
      return notice({ subject: `${name} is no longer verified`, action: { label: 'Open the domain', url: `${base}/domains/${encodeURIComponent(n.domain.id)}` }, why: members, lines: [
        `${productName} can no longer find the DNS records that verify ${name}.`,
        `Mail from addresses at ${name} is refused until the records are back. Your other domains are not affected.`,
        'The domain’s page lists the records to publish.'] });
    }
    case 'low_balance': return notice({ subject: `The balance of ${w} is low`, action: billing('Add credit'), why: members, lines: [
      `The prepaid balance of ${w} is ${n.balance}, enough for about ${count(n.emails)} more emails.`,
      'Sending and receiving continue. When the balance reaches $0, sending pauses.',
      'You can add credit, or turn on auto-recharge, in Billing.'] });
    case 'out_of_credit': return notice({ subject: `${w} is out of credit`, action: billing('Add credit'), why: members, lines: [
      `The prepaid balance of ${w} has run out, and this month’s free emails are used.`,
      `Sending is paused until credit is added. Campaigns wait and continue on their own. Received mail still arrives${n.receivingUntil ? ` until ${day(n.receivingUntil)}` : ''}, and nothing is deleted.`,
      'Add credit in Billing and sending resumes within a minute.'] });
    case 'recharge_failed': return notice({ subject: `Auto-recharge failed for ${w}`, action: billing('Update the card'), why: members, lines: [
      `${productName} could not charge the card${n.last4 ? ` ending ${n.last4}` : ''}: ${n.decline}.`,
      `Auto-recharge is off until the card is updated. The balance is ${n.balance}, and sending continues until it reaches $0.`,
      'Update the card in Billing, then turn auto-recharge back on.'] });
    case 'receive_hold_soon': return notice({ subject: `Received mail for ${w} will be held from ${day(n.holdAt)}`, action: billing('Add credit'), why: members, lines: [
      `${w} has owed ${n.owed} since ${day(n.since)}.`,
      `Sending is paused. From ${day(n.holdAt)}, new received mail is stored but not delivered to inboxes, webhooks or IMAP. Nothing is deleted.`,
      'Add credit in Billing before then and nothing is held.'] });
    case 'receive_held': return notice({ subject: `Received mail for ${w} is being held`, action: billing('Add credit'), why: members, lines: [
      `${w} has owed ${n.owed} since ${day(n.since)}.`,
      'New received mail is stored but not delivered to inboxes, webhooks or IMAP. Earlier mail stays readable, and nothing is deleted.',
      'Add credit in Billing and held mail is delivered in the order it arrived.'] });
    case 'credit_expiring': return notice({ subject: `${n.amount} of credit for ${w} expires on ${day(n.expiresAt)}`, action: billing('Open Billing'), why: members, lines: [
      `${n.amount} of a top-up to ${w} is still unused, and prepaid credit expires 12 months after purchase.`,
      `Nothing changes for your mail. Usage spends the oldest credit first. Whatever is left of this credit on ${day(n.expiresAt)} leaves the balance and is not refunded.`,
      'There is nothing you need to do. Billing shows the balance.'] });
    case 'invitation': {
      const inviter = oneLine(n.inviter.name, n.inviter.email);
      return notice({ subject: `${inviter} invited you to ${w} on ${productName}`, action: { label: 'Accept the invitation', url: n.acceptUrl },
        why: `${productName} sent this because ${inviter} entered your address. If you were not expecting it, ignore it: nothing happens unless you accept.`, lines: [
          `${inviter} (${n.inviter.email}) invited you to join the workspace ${w} on ${productName} as ${n.role === 'member' ? 'a member' : `an ${n.role}`}.`,
          `The invitation is for this address only and expires on ${day(n.expiresAt)}.`,
          'To accept, sign in with this address.'] });
    }
    case 'waitlist_admitted': return notice({ subject: `You can sign in to ${productName} now`, action: { label: 'Sign in', url: `${base}/overview` },
      why: `${productName} sent this once, because this address joined the waitlist.`, lines: [
        `You asked to join ${productName} with this address. It is open to you now.`,
        'Nothing has been set up yet. Your account is created when you sign in.'] });
  }
}
