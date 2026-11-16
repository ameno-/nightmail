import { LOCKUP, MONOGRAM, WORDMARK } from '../lib/marks'

/**
 * The brand's marks wherever the app shows them (docs/brand.md; the outlines are lib/marks.ts): the lockup, which is
 * the NM monogram on its tile with the NIGHTMAIL wordmark one stem to its right, and the tile alone. Each is one inline
 * SVG in `currentColor`: .nightmail-logo (styles/app.css) gives it the brand's ink on a pale theme and its paper on a
 * dark one, and sizes the lockup by its cap height (13 px, so 158 px across). The outlines are never stretched or
 * respaced: a size is one number, the height. The dashboard's own shell carries no logo: onboarding, the legal pages,
 * the support chat and the homepage do.
 */
type Props = { className?: string; title?: string }
const a11y = (title?: string) => title ? { role: 'img', 'aria-label': title } as const : { 'aria-hidden': true } as const
const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ')

export function NightmailWordmark({ className, title }: Props) {
  return <svg className={classes('nightmail-logo nightmail-wordmark', className)} viewBox={`0 0 ${LOCKUP.w} ${LOCKUP.h}`} {...a11y(title)}>
    <path d={MONOGRAM.d} />
    <path d={WORDMARK.d} transform={`translate(${MONOGRAM.w + LOCKUP.gap} 0)`} />
  </svg>
}

/** `size`: the tile's side in pixels; without one, the stylesheet sizes it. */
export function NightmailMark({ size, className, title }: Props & { size?: number }) {
  return <svg className={classes('nightmail-logo', className)} viewBox={`0 0 ${MONOGRAM.w} ${MONOGRAM.h}`} width={size} height={size} {...a11y(title)}>
    <path d={MONOGRAM.d} />
  </svg>
}
