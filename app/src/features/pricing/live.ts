/** The price pages (/pricing and /compare/*) wait for a legal review. While false, nothing on the site links to them and
 *  their HTML asks search engines not to index them (app/price-pages.ts). Set it to true to publish them. */
export const PRICE_PAGES_LIVE = false
