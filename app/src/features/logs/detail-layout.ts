import { SHELL_COMPACT, useMediaQuery } from '../../lib/media'

// A sent email's layout by window, one rule for the page and its skeleton. Below 900 px (the compact shell) the page
// scrolls as one column: delivery, the preview as tall as the email, then the checks (stack). From 1200 px the preview
// fills the window's height beside a details column with the delivery and the checks (column); between, the preview takes
// the width and the checks open beside it from its toolbar (panel).
export type DetailMode = 'stack' | 'panel' | 'column'
export function useDetailLayout() {
  const compact = useMediaQuery(SHELL_COMPACT), column = useMediaQuery('(min-width: 1200px)')
  const mode: DetailMode = compact ? 'stack' : column ? 'column' : 'panel'
  return { mode }
}
