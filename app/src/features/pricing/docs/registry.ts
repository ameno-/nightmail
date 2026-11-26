// (With extensions: the build's config imports this file, through prices.ts and pages.ts.)

// Which vendors have pages of their own beside their comparison (docs/): a pricing page (/pricing/<slug>, what the vendor
// costs: vendor-pricing.ts). A comparison whose vendor has one takes a head-to-head title (prices.ts, searchWords) and
// the vendor's pages link one another, so adding a slug here changes all of them in the same build. Only vendors with
// search demand and enough data for a page of their own (docs/index.ts refuses a thin one); the nine agent-inbox vendors
// are priced on /email-for-ai-agents instead. No imports: prices.ts reads it.

/** The vendors with a pricing page, by their comparison's slug (compare/index.ts), in the order the pages list them. */
export const PRICING_VENDORS: readonly string[] = ['sendgrid', 'resend', 'mailchimp']

/** The pages a vendor has besides its comparison, by its slug. */
export const ownPages = (slug: string) => PRICING_VENDORS.includes(slug) ? [`/pricing/${slug}`] : []
