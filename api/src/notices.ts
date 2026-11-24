import { addresses, productName } from './brand.js';

// Every email Nightmail sends a customer about their account, in one template. A notice is three short plain
// paragraphs (what happened, what it means for their mail right now, what to do next), one link and one line saying
// why it was sent. customerNotice() is pure and returns the subject with a text part and an HTML part that carry the
// same words; the HTML part sets a line length, the link as a button and its own dark colours, and nothing else (no
// images, no background). A notice never says how a check works: no scores, rates, thresholds or provider names.
//
// Words a customer chose (a workspace's name, a campaign's) are shown through shownName, an address through
// plainAddress and a domain through hostName, and nowhere but where a template puts them. The invitation goes to an
// address outside the workspace, so every word of it is this file's: it names the inviter by address and the
// workspace not at all (the page its link opens shows that, through shownName).
//
// The jobs that send them: standing.notify (standing.ts), billing.notify (billing/notify.ts) and account.notify
// (account-notices.ts). scripts/render-notices.ts renders every one in a mail client, for review.

export type Notice = { subject: string; text: string; html: string };
type Parts = { subject: string; lines: string[]; action: { label: string; url: string }; why: string };

const escapeHtml = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const NAME_LENGTH = 40, PHONE_DIGITS = 7;
// A word that would read as somewhere to go: an address, a URL, or labels joined by a dot (a host).
const pointsSomewhere = (word: string) => word.includes('@') || word.includes('://') || /[\p{L}\p{N}][.\u3002][\p{L}\p{N}]/u.test(word);
// The writing systems a word may be in, one at a time. Latin is its letters only (no click letters, modifier letters or
// later additions that draw as punctuation); Chinese, Japanese and Korean write one word in several scripts. A word in
// two of these, or in none (a script whose letters draw as dots, slashes or Latin capitals), is not shown.
const SCRIPTS = [/^[A-Za-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u01bf\u01c4-\u024f\u1e00-\u1eff]+$/, /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30fc]+$/u,
  ...['Cyrillic', 'Greek', 'Arabic', 'Hebrew', 'Armenian', 'Georgian', 'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Thai', 'Lao', 'Khmer', 'Myanmar', 'Ethiopic']
    .map(script => new RegExp(`^\\p{Script=${script}}+$`, 'u'))];
const oneScript = (word: string) => { const letters = word.replace(/[\p{M}\p{Pd}0-9_'’&]+/gu, ''); return !letters || SCRIPTS.some(script => script.test(letters)); };
/**
 * A name a customer chose (a workspace's, a campaign's) as the product shows it in its own voice: a few plain words on
 * one line. Compatibility forms are folded (full-width letters and dots become the ordinary ones) and invisible
 * characters go. Words that read as an address, a URL or a host are left out whole. Of the rest only letters, digits,
 * spaces, dashes, underscores, apostrophes and "&" stay, each word in one writing system (SCRIPTS). A name with enough
 * digits for a phone number loses every word that has one. At most NAME_LENGTH characters; '' when nothing is left.
 */
export function shownName(value: string): string {
  const words = value.normalize('NFKC').replace(/\p{Cf}+/gu, '').replace(/[\p{C}\p{Z}]+/gu, ' ').split(' ')
    .filter(word => !pointsSomewhere(word))
    .flatMap(word => word.replace(/[^\p{L}\p{M}\p{N}\p{Pd}_'’&]+/gu, ' ').split(' '))
    .filter(word => (word === '&' || /[\p{L}\p{N}]/u.test(word)) && oneScript(word));
  const phone = (words.join('').match(/\p{N}/gu)?.length ?? 0) >= PHONE_DIGITS;
  const letters = [...words.filter(word => !phone || !/\p{N}/u.test(word)).join(' ')];
  return letters.length > NAME_LENGTH ? letters.slice(0, NAME_LENGTH).join('').trimEnd() + '…' : letters.join('');
}
/** An email address an account email may print: plain ASCII, lowercased, or null. */
export const plainAddress = (value: string) => value.length <= 254 && /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value) ? value.toLowerCase() : null;
/** A domain's name an account email may print: a host's letters, digits, hyphens and dots, or null. */
const hostName = (value: string) => value.length <= 253 && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value) ? value.toLowerCase() : null;
const day = (value: Date) => value.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const count = (value: number) => value.toLocaleString('en-US');
const owes = (workspace: string, owed: string, since: Date | null) => since ? `${workspace} has owed ${owed} since ${day(since)}.` : `${workspace} owes ${owed}.`;

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
  | Workspace & { kind: 'paused' | 'restricted' | 'warned' | 'limit_reached' }
  /** limit: false for a workspace no daily limit applies to (exempt), which is told nothing about one. */
  | Workspace & { kind: 'resumed'; limit?: boolean; /** Marketing stays on hold after this resume. */ marketingHeld?: boolean }
  | Workspace & { kind: 'campaign_paused'; campaign: { id: string; name: string } }
  | Workspace & { kind: 'domain_unverified'; domain: { id: string; name: string } }
  | Workspace & { kind: 'evaluation_finished'; limited: boolean }
  | Workspace & { kind: 'low_balance'; balance: string; emails: number }
  | Workspace & { kind: 'out_of_credit'; receivingUntil: Date | null }
  | Workspace & { kind: 'recharge_failed'; last4: string | null; decline: string; balance: string }
  | Workspace & { kind: 'receive_hold_soon'; owed: string; since: Date | null; holdAt: Date | null }
  | Workspace & { kind: 'receive_held'; owed: string; since: Date | null }
  | Workspace & { kind: 'credit_expiring'; amount: string; expiresAt: Date | null }
  | { kind: 'invitation'; inviter: { email: string }; role: 'owner' | 'admin' | 'member'; expiresAt: Date; acceptUrl: string }
  | { kind: 'waitlist_admitted' };
export type NoticeKind = NoticeInput['kind'];

/**
 * The notice for one moment in a customer's account. `origin` is the dashboard's (PUBLIC_URL). Pausing has one email
 * whatever paused the workspace: the ladder, a review or the provider.
 */
export function customerNotice(origin: string, n: NoticeInput): Notice {
  const base = origin.replace(/\/$/, ''), w = 'workspace' in n ? shownName(n.workspace) || 'your workspace' : '';
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
      `There is a problem with recent mail from ${w}.`,
      'Nothing is held and your mail still sends. If it continues, marketing mail will be put on hold.',
      'The dashboard shows which mail caused it. The warning clears on its own once things improve.'] });
    case 'resumed': return notice({ subject: `Sending has resumed for ${w}`, action: dashboard, why: members, lines: [
      `Sending from ${w} is on again.`,
      `Mail that was still held is being sent, and ${n.marketingHeld ? 'new transactional mail goes out again. Marketing mail stays on hold a little longer.' : 'new mail goes out again.'}${n.limit === false ? '' : ' For now the daily limit may be lower than before.'}`,
      ...(n.limit === false ? n.marketingHeld ? ['The dashboard shows when marketing can resume.'] : [] : [n.marketingHeld ? 'The dashboard shows the limit and when marketing can resume.' : 'The dashboard shows the limit.'])] });
    case 'limit_reached': return notice({ subject: `${w} has reached its daily sending limit`, action: dashboard, why: members, lines: [
      `${w} has reached its daily sending limit.`,
      'Mail over the limit is refused for now. Room frees up over the next 24 hours, and mail already accepted is still delivered.',
      'The dashboard shows the limit and what raises it.'] });
    case 'evaluation_finished': return notice(n.limited
      ? { subject: `The evaluation of ${w} is finished`, action: dashboard, why: members, lines: [
        `The first emails from ${w} showed some problems, so it keeps a daily limit for now.`,
        'Mail within the limit sends as usual. The limit rises on its own as your later mail goes well.',
        'The dashboard shows the limit and what would raise it.'] }
      : { subject: `${w} has passed its evaluation`, action: dashboard, why: members, lines: [
        `The first emails from ${w} were delivered well, so its starting limit is lifted.`,
        'You can send more now. Over the next day the amount grows on its own as your mail keeps being delivered.',
        'The dashboard shows how much you can send right now.'] });
    case 'campaign_paused': {
      const name = shownName(n.campaign.name), campaign = name ? `the campaign "${name}"` : 'a campaign';
      return notice({ subject: name ? `The campaign "${name}" is paused` : 'A campaign is paused', action: { label: 'Open the campaign', url: `${base}/campaigns/${encodeURIComponent(n.campaign.id)}/review` }, why: members, lines: [
        `${productName} paused ${campaign} before it finished, because of a problem with its recipients or its content.`,
        'People it already reached keep their email. Nobody else is sent to until you resume it. Your other mail is not affected.',
        'The campaign’s page shows what to check before you resume or cancel it.'] });
    }
    case 'domain_unverified': {
      const host = hostName(n.domain.name), name = host ?? 'the domain';
      return notice({ subject: `${host ?? 'A domain'} is no longer verified`, action: { label: 'Open the domain', url: `${base}/domains/${encodeURIComponent(n.domain.id)}` }, why: members, lines: [
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
    case 'receive_hold_soon': return notice({ subject: `Received mail for ${w} will be held ${n.holdAt ? `from ${day(n.holdAt)}` : 'soon'}`, action: billing('Add credit'), why: members, lines: [
      owes(w, n.owed, n.since),
      `Sending is paused. ${n.holdAt ? `From ${day(n.holdAt)}` : 'Soon'}, new received mail is stored but not delivered to inboxes, webhooks or IMAP. Nothing is deleted.`,
      'Add credit in Billing before then and nothing is held.'] });
    case 'receive_held': return notice({ subject: `Received mail for ${w} is being held`, action: billing('Add credit'), why: members, lines: [
      owes(w, n.owed, n.since),
      'New received mail is stored but not delivered to inboxes, webhooks or IMAP. Earlier mail stays readable, and nothing is deleted.',
      'Add credit in Billing and held mail is delivered in the order it arrived.'] });
    case 'credit_expiring': return notice({ subject: `${n.amount} of credit for ${w} expires ${n.expiresAt ? `on ${day(n.expiresAt)}` : 'soon'}`, action: billing('Open Billing'), why: members, lines: [
      `${n.amount} of a top-up to ${w} is still unused, and prepaid credit expires 12 months after purchase.`,
      `Nothing changes for your mail. Usage spends the oldest credit first. Whatever is left of this credit ${n.expiresAt ? `on ${day(n.expiresAt)}` : 'then'} leaves the balance and is not refunded.`,
      'There is nothing you need to do. Billing shows the balance.'] });
    case 'invitation': {
      // To someone outside the workspace, so nothing in it is the workspace's to choose: the subject is fixed, the
      // inviter is their address, and the workspace's name is not here at all. The page the link opens shows it.
      const inviter = plainAddress(n.inviter.email);
      return notice({ subject: `You are invited to a ${productName} workspace`, action: { label: 'Accept the invitation', url: n.acceptUrl },
        why: `${productName} sent this because ${inviter ?? 'someone'} entered your address. If you were not expecting it, ignore it: nothing happens unless you accept.`, lines: [
          `${inviter ?? 'Someone'} invited you to join a workspace on ${productName} as ${n.role === 'member' ? 'a member' : `an ${n.role}`}.`,
          `The invitation is for this address only and expires on ${day(n.expiresAt)}.`,
          'To accept, sign in with this address.'] });
    }
    case 'waitlist_admitted': return notice({ subject: `You can sign in to ${productName} now`, action: { label: 'Sign in', url: `${base}/overview` },
      why: `${productName} sent this once, because this address joined the waitlist.`, lines: [
        `You asked to join ${productName} with this address. It is open to you now.`,
        'Sign in with an emailed link to this address, or its Google account. Your account is created then.'] });
  }
}
