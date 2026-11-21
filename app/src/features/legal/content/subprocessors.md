---
title: Subprocessors
description: The providers that process personal data for Nightmail, what each one does, and where.
updated: 20 November 2026
effective: 13 November 2026
---

These providers process personal data for Nightmail on behalf of **Anomaly Innovations, Inc.** ("Anomaly"), as described in our [Privacy Policy](/legal/privacy).

## Current subprocessors

| Provider | What it does for Nightmail | Data | Where |
| --- | --- | --- | --- |
| **Amazon Web Services** | Sends and receives mail (Amazon SES); stores incoming mail briefly before processing, quarantined mail and mail held for unpaid balances (S3); delivery events (SNS and SQS); runs the IMAP and SMTP gateway (ECS); gateway logs; secrets | All mail content and metadata | United States: Ohio (us-east-2) and Northern Virginia (us-east-1) |
| **Cloudflare** | Runs the API, website and dashboard (Workers, Durable Objects and Queues); stores received mail and attachments (R2); connects to the database (Hyperdrive); renders campaign previews (Browser Rendering); runs the support agent and keeps its conversations, tickets and screenshots (Workers, Durable Objects, D1 and R2); request logs; DNS and edge network; DNS lookups about customer domains | All | Received-mail storage: Eastern North America. Request processing: Cloudflare's global network. |
| **PlanetScale** | Main database (Postgres): accounts, workspaces, logs, contacts, received message text and billing | All | United States: AWS Ohio (us-east-2) |
| **Stripe** | Card payments, receipts, saved cards and fraud checks (Radar) | Billing contact and payment data | United States |
| **Anthropic** | Claude, the AI model behind the support agent ([Privacy Policy, section 5.6](/legal/privacy#ai-support-agent)). Doesn't train on support conversations. | Support conversations and screenshots, what the agent looks up in the account, and message content only with the customer's permission | United States |
| **Google** | Google Workspace, Anomaly's staff email: support tickets and the emails that notify staff about them | Support requests and tickets | Google's data centers worldwide |
| **TypeSafe AI** | Jev classifier: the spam screen and AI decisions. Doesn't retain or train on the content. | Parts of message content ([Privacy Policy, section 5.1](/legal/privacy#what-is-screened)) | United States |

## Other recipients

- **Anomaly account (account.anoma.ly)** is Anomaly's own sign-in service. It shares your name, email address, account identifiers and sign-in method with Nightmail.
- **GitHub** and **Google** are the sign-in providers behind your Anomaly account; each one's own privacy policy applies to your account there.
- **Domain tools.** Nightmail looks up public DNS records (through Cloudflare's resolver) and domain registration data (RDAP) for customer domains. If you use one-click DNS setup (Domain Connect), you're sent to your DNS provider.
- **Services customers connect.** Webhooks, Slack and Discord endpoints, forwarding addresses, MCP clients, mail clients and a customer's own AWS account receive data because the customer chose them. They aren't our subprocessors.

## Changes

We update this page before a new subprocessor starts processing personal data. Business customers with a signed Data Processing Addendum get notice of changes as that addendum describes. Questions: [privacy@nightmail.dev](mailto:privacy@nightmail.dev).
