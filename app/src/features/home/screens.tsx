import type { ReactNode } from 'react'

// What the homepage's machines show on their screens (machines.tsx), in the page's own text, styled by machines.css
// (.mx-*). The comparison pages show the same screens on their feature cards (pricing/features.tsx). No CSS here: the
// price pages' pre-merge check renders them in node.
export type Kind = 'send' | 'campaign' | 'receive' | 'agent' | 'route'

// What each machine's screen shows. Sample mail is the homepage's own cast; the API's, the MCP's and the rules' names
// are the product's (POST /v1/emails/send answers 202 with the email queued; the agent's three tools; a rule as the
// rules guide writes one).
const LOG: [string, string, string, string][] = [
  ['02:14', 'Received', 'Your pager wants to be friends', 'Slack'],
  ['02:11', 'Sent', 'Sending version six. It is the last one.', ''],
  ['02:09', 'Received', 'Your webhook is answering in Latin', 'Webhook'],
  ['02:02', 'Delivered', 'We label the sausages by mood now', ''],
  ['01:58', 'Received', 'Turn a one-star canteen review into notes', 'Discord'],
  ['01:40', 'Received', 'Your hot desk is now cold', ''],
]
const Mail = ({ from, subject, when, open }: { from: string; subject: string; when: string; open?: boolean }) =>
  <div className="mx-row" data-open={open || undefined}><b>{from}</b><time>{when}</time><span>{subject}</span></div>
/** The rules' screen: the rule over its log's tape, the log `copies` times over (the tape runs half its length and starts
 *  again, so it can be shown as tall as that half). */
export const routeScreen = (copies: number) => <div className="mx-route">
  <pre className="mx-rule mx-rule-wide">{'export default function route(email, ctx) {\n  if (ctx.junk) return\n  endpoints.slack({ text: email.subject })\n}'}</pre>
  <pre className="mx-rule mx-rule-narrow">{'export default\nfunction route(email, ctx) {\n  if (ctx.junk) return\n  endpoints.slack({\n    text: email.subject,\n  })\n}'}</pre>
  <div className="mx-tape"><div className="mx-roll">{Array.from({ length: copies }, (_, copy) => LOG.map(([at, status, subject, to]) =>
    <p key={`${copy}${at}`} className="mx-log"><time>{at}</time><span data-status={status}>{status}</span><b>{subject}</b><em>{to}</em></p>))}</div></div>
</div>

export const SCREENS: Record<Kind, ReactNode> = {
  send: <div className="mx-code">
    <p><b>POST</b> /v1/emails/send</p>
    <pre>{'{\n  "from": "shop@acme.example",\n  "to": "dana@example.com",\n  "subject": "6 mugs, 7 handles"\n}'}</pre>
    <p className="mx-answer"><b>202</b> Accepted</p>
    <pre className="mx-dim">{'{ "status": "queued" }'}</pre>
  </div>,
  campaign: <div className="mx-card">
    <p className="mx-card-head"><span>Campaign</span><span className="mx-sent">Sent</span></p>
    <p className="mx-card-title">We label the sausages by mood now</p>
    <p className="mx-dim">Counter Six Butcher to Regulars</p>
    <span className="mx-meter"><i /></span>
    <dl className="mx-bill">
      <div><dt>Recipients</dt><dd>50,000</dd></div>
      <div><dt>Rate</dt><dd>$0.20 per 1,000</dd></div>
      <div className="mx-total"><dt>Cost</dt><dd>$10.00</dd></div>
    </dl>
  </div>,
  receive: <div className="mx-mail">
    <div className="mx-list">
      <p className="mx-list-head"><b>Inbox</b><span>hello@acme.example</span></p>
      <Mail from="On-Call Pager" subject="Your pager wants to be friends" when="02:14" />
      <Mail open from="Zahir Bhatt" subject="Re: can you send me the file again" when="02:11" />
      <Mail from="Handle Concern" subject="Order confirmed: 6 mugs, 7 handles" when="01:52" />
    </div>
    <div className="mx-thread">
      <p className="mx-thread-head">Re: can you send me the file again</p>
      <p className="mx-msg"><b>Zahir Bhatt</b>This is the fifth time. Each version is a different version.</p>
      <p className="mx-msg mx-mine"><b>hello@acme.example</b>Sending version six. It is the last one.</p>
    </div>
  </div>,
  agent: <div className="mx-agent">
    <p className="mx-call">listInboxMessages</p>
    <p className="mx-dim">1 new, from Bertram Quaife</p>
    <p className="mx-call">getInboxMessage</p>
    <p className="mx-quote">Turn a one-star canteen review into notes: “the soup was a warning.”</p>
    <p className="mx-call">replyToInboundThread</p>
    <p className="mx-draft"><span>1. Label the soup.</span></p>
  </div>,
  route: routeScreen(2),
}
