/** The price pages (/pricing and /compare/*) are public: the homepage's footer and each other's link to them, the
 *  sitemap lists them, and search engines may index them (app/price-pages.ts). Set it to false to take them off the
 *  site again (their addresses keep working, with noindex). */
export const PRICE_PAGES_LIVE = true

/** The price pages as their footers and the homepage's name them, in this order. (Here, not in pages.ts, so the
 *  homepage can link them without loading the prices.) */
export const PRICE_LINKS = [['/pricing', 'Pricing'], ['/compare/mailchimp', 'vs Mailchimp'], ['/compare/resend', 'vs Resend']] as const
