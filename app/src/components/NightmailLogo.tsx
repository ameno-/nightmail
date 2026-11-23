import { STAMP, STAMP_SMALL, WORDMARK } from '../lib/marks'

/**
 * The brand's marks wherever the app shows them (docs/brand.md; the outlines are lib/marks.ts): the NIGHTMAIL wordmark,
 * alone, at the head of the dashboard and of the pages around it, and the Moon stamp where a square mark is needed (the
 * support chat's avatar). Each is one inline SVG in `currentColor`: .nightmail-logo (styles/app.css) gives it the
 * brand's ink on a pale theme and its paper on a dark one, and sizes the wordmark by its cap height (13 px, so 139 px
 * across). The outlines are never stretched or respaced: a size is one number, the height.
 */
type Props = { className?: string; title?: string }
const a11y = (title?: string) => title ? { role: 'img', 'aria-label': title } as const : { 'aria-hidden': true } as const
const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ')

export function NightmailWordmark({ className, title }: Props) {
  return <svg className={classes('nightmail-logo nightmail-wordmark', className)} viewBox={`0 0 ${WORDMARK.w} ${WORDMARK.h}`} {...a11y(title)}>
    <path fillRule="evenodd" d={WORDMARK.d} />
  </svg>
}

/** `size`: the stamp's side in pixels (under 32, its small drawing); without one, the stylesheet sizes it. */
export function NightmailMark({ size, className, title }: Props & { size?: number }) {
  const stamp = size !== undefined && size < 32 ? STAMP_SMALL : STAMP
  return <svg className={classes('nightmail-logo', className)} viewBox={`0 0 ${stamp.w} ${stamp.h}`} width={size} height={size} {...a11y(title)}>
    <path fillRule="evenodd" d={stamp.d} />
  </svg>
}
