// (With extensions: the build's config imports this file.)

// The comparisons' new look, on the dev stage only until Ryan has seen it: VITE_PRICE_PAGES=verdict (the dev stage's
// deploy sets it) draws the 34 comparisons from their data (page/) and adds /compare; anything else keeps today's
// boards and no /compare, so a production build is what it was. vite.config.ts reads it. To be replaced by the one
// switch the price pages' plumbing exports (seo/pricing-pages) once it lands.
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
export const VERDICT_PAGES = env.VITE_PRICE_PAGES === 'verdict'
