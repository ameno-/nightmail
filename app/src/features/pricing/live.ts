/** The price pages (/pricing and /compare/*) wait for a legal review. While false, nothing on the site links to them and
 *  their HTML asks search engines not to index them (app/price-pages.ts). Set it to true to publish them. */
export const PRICE_PAGES_LIVE = false
/** A competitor's own logo and brand colour on its comparison (mailchimp.tsx: Mailchimp's logo beside Nightmail's, its
 *  yellow on the chart). Off: the pages name the competitor in plain text and draw it in the neutral series. Intuit's
 *  trademark page (intuit.com/legal/trademark, read 22 Nov 2026) permits its marks "in plain text" and says a logo "is
 *  strictly not permitted without a written license", and a reference must not use the logo's colours; Mailchimp's
 *  brand assets page asks for written consent to combine its graphics with any other. So this stays off until there is
 *  a licence or the legal review clears it. */
export const COMPETITOR_BRAND = false
