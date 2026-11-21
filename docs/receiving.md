# Receiving

Receiving is where mail that arrives at your domains is received, processed and delivered. Every screen uses one model, in that order:

- an **address** is where mail is received (the API's **routes**: addresses, wildcards, catch-alls and agent inboxes);
- a **rule** is where it is processed;
- a **destination** is where it is delivered (the API's **endpoints**: an inbox, Slack, Discord, a webhook or a forward).

The API keeps its names; only the dashboard's words are these. The words below are the words on screen (`app/src/features/inbound/concepts.ts`); change both together.

![Receiving: the Addresses tab, each address reading left to right from the address to its rules to where its mail goes](images/receiving/routes.png)

- [Concepts](#concepts)
- [Kinds of address](#kinds-of-address)
- [What happens to mail](#what-happens-to-mail)
- [An address's page](#an-addresss-page)
- [Catch-all](#catch-all)
- [Test and Try it](#test-and-try-it)
- [Where everything is](#where-everything-is)
- [API, SDK and MCP](#api-sdk-and-mcp)

## Concepts

| | What it is | Example |
|---|---|---|
| **Addresses** (routes) | Every address that receives mail, and where its mail goes. | `support@acme.com → triage → Inbox, Slack support` |
| **Rules** | Short scripts that run on an address's mail: label it, filter it, or send it on. | If the subject mentions a refund, label it and post it to Slack. |
| **Destinations** (endpoints) | Places mail can be delivered: Slack, Discord, a webhook or a forward. A rule calls one by name; an address can deliver to a webhook or a forward, and a webhook can also subscribe to events. | `endpoints.support({ text: email.subject })` |

Rules and destinations are described in full in [rules.md](rules.md); agent inboxes in [inboxes.md](inboxes.md). A destination is listed by its name, its type and where it points (`crm · Webhook · ••••/crm`), never by the call a rule makes; a webhook subscribed to received mail is used by *All new mail*.

## Kinds of address

The Addresses tab lists every kind in one table and filters by kind; a kind with nothing in it is left out. Each row is one line: **Address | Rules | Destinations | Unread | Last mail**. Rules are their plain sentences (the first, and how many more); an address without one offers **Add a rule**, on a phone too.

| Filter | What it shows | Example |
|---|---|---|
| All | Every address that receives mail, and where its mail goes. | `support@acme.com → triage → Inbox, Slack support` |
| Exact | Each keeps its own mail, on its page; it can send its mail elsewhere instead. | `support@acme.com` |
| Wildcards | A wildcard (the API's pattern) catches many addresses with `*`. | `reply+*@acme.com` catches `reply+4821@acme.com` |
| Catch-alls | What happens to mail for an address that doesn't exist. | `*@acme.com` |
| Agent inboxes | Expiring addresses that agents and tests create and read over the API or MCP. | |
| Auto-created | Addresses a catch-all created for new recipients. | |

Under each address, a few words say what the row is: *No inbox of its own* (a route for an address without an inbox), *Wildcard*, *Catch-all*, *Agent inbox* or *Created by the catch-all*.

An address that has no rule yet says so in its row (**No rule · add**), so what an address could do is always visible next to what it does.

## What happens to mail

**Destinations** lists where an address's mail ends up: routing first, then what its rules can send it to, marked *via a rule* (a rule may send only some mail there).

| On screen | Meaning | API (`to[].type`) |
|---|---|---|
| Inbox | The address keeps the thread. | `inbox` |
| Webhook, Slack, Discord, Forward | A destination. | `webhook`, `slack`, `discord`, `forward` |
| Stored, no inbox | Kept and readable over the API by message ID, but in no inbox. | `store` |
| Dropped | Not stored. | `drop` |
| New address per recipient | The domain's catch-all creates an address for each new recipient. | `create_address` |

A route can deliver to inboxes, webhooks and confirmed forwards (`forward:<name>` or the endpoint's `con_…` ID), and a forward from a route sends each message whole, as a rule's call does ([rules.md](rules.md#forward-confirmation)). Slack and Discord posts are sent by a rule, which writes the message they post. A route refuses a forward its recipient hasn't confirmed; one they stop later stays on the route and gets nothing.

The list is complete: routing targets and rule targets always show, and webhooks subscribed to an address's received mail show active ones first, then paused ones. An address with more than 50 subscribers shows the first 50 and says how many more there are, with a link to every one (the Destinations tab, filtered to that address).

## An address's page

An address's page has three tabs:

| Tab | What's there |
|---|---|
| **Mail** | Its conversations: search, the view picker (Inbox, Starred, Archive, Spam, Trash, All), reading, replying and New message. A message sent from another address opens on that address's page. |
| **Where mail goes** | Address → Rules → Destinations: what it receives; the rules that run, in order, in plain words (attach, detach with Undo, New rule); where its mail is delivered (**Change**, "Where should this mail go?": Deliver to these destinations, store it or drop it). **Test** runs an email to it through its rules. |
| **Settings** | Its domain and dates, display name, aliases and wildcards (edited here only), and Delete address. |

Switching tabs keeps the open conversation and a reply being written.

Mail is the first tab: opening an address shows its mail. Every address's received mail together is in Logs, filtered to Received; `/receiving/inbox` opens there, and `/receiving/inbox?address=…` opens that address's Mail tab.

![An address's page](images/receiving/address.png)

## Catch-all

Catch-all: what happens to mail for an address that doesn't exist on this domain. It is set per domain on its Domains page, and the Addresses tab shows it as a Catch-alls row.

| Option | API (`catchAll`) |
|---|---|
| Store it, no inbox | `store` |
| Create an address | `create_address` |

An explicit `*@host` route takes precedence over the domain's catch-all. Domains show sending and receiving on one page; Receiving doesn't list domains of its own.

![A domain's page: sending status, then receiving status, its addresses and the catch-all](images/receiving/domain.png)

## Test and Try it

**Test**, on an address's Where mail goes tab, runs an email through your routes and rules with the dry run (`testRules`). Pick recent mail, a sample email (when nothing has arrived yet, the sample stands in) or paste a message. Each rule's source appears with its conditions; one at a time they light up true or false, AI decision answers fill in, then the actions (`→ junk`, `→ Slack support`) and the result: which inboxes and endpoints get the mail, its labels, and whether it's junk.

![Test: a rule's conditions evaluated true and false, the AI decision score, its actions and where the mail ends up](images/receiving/trace.png)

**Try it** in the rule editor does the same for the rule you're writing, unsaved, as if it were attached to the address the email was sent to. Each AI decision gets a slider (default 0.5) for the answer the AI would give; the AI is never asked. Nothing is sent or saved in either. With reduced motion, the whole trace shows at once.

## Where everything is

Everything is at most two clicks from Receiving.

| Task | Where |
|---|---|
| See every address and where its mail goes | Receiving → Addresses |
| Create an address | Receiving → New address |
| Read and answer an address's mail | Receiving → the address → Mail |
| Read every address's mail | Logs → Received |
| Add an alias or wildcard, attach a rule, change where its mail is delivered | Receiving → the address → Where mail goes |
| Add a ready-made rule or write one | Receiving → Rules → New rule |
| Turn a rule off, edit or delete it | Receiving → Rules → its switch or ⋯ menu |
| Edit, attach or try a script | Receiving → Rules → the rule (Edit as code for a ready-made one) |
| Create, test, pause or delete a destination | Receiving → Destinations |
| Subscribe a webhook to inbound events | Receiving → Destinations → the webhook |
| See every webhook that gets an address's mail | Receiving → the address → Where mail goes → Deliver → more webhooks |
| Create an agent inbox | Receiving → Addresses → Agent inboxes → New agent inbox |
| Test what would happen to an email | Receiving → the address → Where mail goes → Test |
| Set up receiving or change a catch-all | Domains → the domain |

Older links keep working: `/receiving/routing` and `?tab=routes` open Addresses, `/receiving/endpoints`, `/receiving/webhooks` and `?tab=endpoints` open the Destinations tab, `/receiving/inbox` opens Logs' received mail (or with `?address=` that address's Mail tab), and every `/receiving/rituals…` link (and `?tab=rituals`) opens the same page under `/receiving/rules`.

## API, SDK and MCP

The Receiving screen is one read: `getInboundOverview` (`GET /v1/inbound/overview`) returns a page of routes merged across kinds, each with the rules that run on it and where its mail goes, plus counts per kind, the rules, up to 100 endpoints and 100 inbound webhooks (`endpointsTruncated` says when there are more; read them all with `listInboundEndpoints`, following `nextCursor`) and the domains. Each route's `to` is complete except for webhook subscribers beyond 50; then `toTruncated` is true, `toTotal` counts every target and `toMore` is the `listInboundWebhooks?addressId=…&eventType=message.received` path that lists them all. Filter with `kind` (`address`, `inbox`, `route`, `pattern`, `catch_all`, comma-separated), `origin` (address rows only: `api` or `auto`), `domain` and `q`; page with `cursor`. It costs two database statements whatever the number of routes.

Access matches the other receiving reads: members and scoped keys see only their own addresses; the full view needs a manage credential, and with an MCP sign-in (approval) an owner or admin. Over MCP it is offered exactly to the approvals REST allows. Webhook, Slack and Discord URLs are write-only: only the last four characters are returned.

| Task | Operation (also the MCP tool name) |
|---|---|
| Everything on the Addresses tab | `getInboundOverview` |
| Addresses, aliases and patterns | `listInboundAddresses`, `createInboundAddress`, `updateInboundAddress` (`aliases`, `rules`); deprecated, see below |
| An address's mail and folders | `listInboxMessages`, `getInboxMessage`, `listInboxFolders`, `moveInboxMessage` and the other inbox mail operations, with the address ID |
| Routes | `listRoutes`, `createRoute`, `updateRoute`, `deleteRoute`, `testRouting` |
| Catch-all | `updateInboundDomain` (`catchAll`) |
| Rules and Try it | `saveRule`, `attachRules`, `testRules` (trace rows carry a step-by-step `timeline`) |
| Destinations (endpoints) | `listInboundEndpoints` (every endpoint, named or not, a page at a time; `addressId` keeps the webhooks that get an address's received mail), `listEndpoints`, `createEndpoint`, `updateEndpoint`, `testEndpoint`, `deleteEndpoint` |
| Inbound webhooks | `listInboundWebhooks` (`cursor`, `limit`, `addressId`, `eventType`), `getInboundWebhook`, `createInboundWebhook`, `updateInboundWebhook` |

Every address is an inbox. It has folders, UIDs and one writer for its thread and message state, like an agent inbox, so the inbox mail and folder operations (`/v1/inboxes/{id}/messages`, `/v1/inboxes/{id}/folders`) take an address ID too. A temporary address (`ttlSeconds`) is an inbox whose lease is `expiresAt` alone: it stops receiving then and is kept. An address can still start threads and keep its own send limits, which an agent inbox can't. The address operations (`listInboundAddresses`, `createInboundAddress`, `getInboundAddress`, `updateInboundAddress`, `deleteInboundAddress`) are deprecated aliases until the domain cutover, which removes them and lets `/v1/inboxes` list and create addresses too. Until then `/v1/inboxes` and `getInbox` show agent inboxes only, because the `Inbox` response can't describe an address without a breaking change. Deleting an address releases it: its threads and folders go, and its stored mail is kept.

Endpoints and webhooks are one model. Every endpoint, whatever its type, is one row with one ID (`mwh_…` for a webhook, `con_…` for Slack, Discord and forwards); a webhook's `key` is its endpoint name. `/v1/endpoints` lists and changes named endpoints of every type, and `/v1/inbound/webhooks` lists and changes webhooks, named or not. Both go through the same writer (`api/src/endpoints.ts`), so names, caps (32 active webhooks with event subscriptions, 500 active route-only webhooks, 500 Slack, Discord and forward endpoints), the in-use checks and pause and resume are the same through either.

Attachments follow their message. A webhook payload's attachment link (`downloadUrl` in the inbound format, `url` in a nightmail message's attachments) is `downloadInboundAttachment`: it answers `307` to a download link that works for five minutes. Any credential that can read the message can follow it, by the same rule as `getInboundAttachment`: an inbound key for the address the mail reached, a member's session or an agent token. `rawUrl` is the delivery record (raw MIME names every recipient), so it needs access to every address: an owner or admin session, or an unrestricted manage API key.

```sh
curl "$BANE/v1/inbound/overview?kind=address,route&origin=api&q=support" -H "Authorization: Bearer $KEY"
```
