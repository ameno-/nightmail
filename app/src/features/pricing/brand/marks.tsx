import { NightmailWordmark } from '../../../components/NightmailLogo'

// Nightmail's wordmark and Mailchimp's logo, side by side over the Mailchimp comparison (../mailchimp.tsx), only while
// COMPETITOR_BRAND (../live.ts) is on: this module is loaded only then, so a build with it off ships no logo file.
//
// Mailchimp's logo is as its brand assets page gives it: https://mailchimp.com/about/brand-assets/, read 22 Nov 2026.
// The page offers EPS and PNG. These are its EPS files, "Mailchimp Logo 50-50 Black.eps" and "Mailchimp Logo 50-50
// White.eps" (the reverse version it asks for on a dark background), converted to SVG with Ghostscript 10.08 (pdfwrite)
// and pdftocairo 25.04 and not changed otherwise: not recoloured, stretched or cropped. The page asks for plenty of space
// around the logo (.cmp-marks, pricing.css).
// (The reverse version is drawn with an outline, so its box is a little taller: 1000 × 295 against 1000 × 280.)
const LOGO = {
  light: { src: new URL('./mailchimp-logo-black.svg', import.meta.url).href, width: 200, height: 56 },
  dark: { src: new URL('./mailchimp-logo-white.svg', import.meta.url).href, width: 200, height: 59 },
}

export default function Marks() {
  return <p className="cmp-marks">
    <NightmailWordmark title="Nightmail" />
    <span>vs</span>
    {(['light', 'dark'] as const).map(theme => <img key={theme} className={`cmp-marks__theirs cmp-marks__theirs--${theme}`} {...LOGO[theme]} alt="Intuit Mailchimp" />)}
  </p>
}
