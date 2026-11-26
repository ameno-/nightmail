// (With extensions: the build's config imports this file.)

// The comparisons' look: drawn from their data (page/), with /compare, in every build. VITE_PRICE_PAGES=board gives
// back the boards and no /compare, the way back while the new look settles in; the boards' code goes in a later
// clean-up. vite.config.ts reads it. To be replaced by the one switch the price pages' plumbing exports
// (seo/pricing-pages) once it lands.
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
export const VERDICT_PAGES = env.VITE_PRICE_PAGES !== 'board'
