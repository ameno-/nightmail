import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router'
import { StaticTheme } from '../../lib/theme'
import { LegalPage } from '.'

// A legal page as the app draws it, as HTML (app/site-pages.ts paints it in the page's own file, #page-shell) before any
// of the app's code, which takes this one's place once it's up (index.tsx, useShellTakeover). Rendered in Node at build
// time: nothing here may need a browser. The page is the same in either theme but for its theme switch (a moon or a sun,
// and what it says it does), so the switch is drawn for each, and the painted page's CSS shows the one for the theme
// public/theme.js chose (site-pages.ts, THEME_SWITCH).
export function renderLegalShell(path: string): string {
  const [light, dark] = (['light', 'dark'] as const).map(theme => renderToStaticMarkup(<StaticTheme theme={theme}>
    <MemoryRouter initialEntries={[path]}><Routes><Route path="/legal/:doc?" element={<LegalPage />} /></Routes></MemoryRouter>
  </StaticTheme>))
  const switchOf = (html: string) => /<button [^>]*class="[^"]*\btheme-toggle\b[^"]*"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0]
  const forLight = switchOf(light!), forDark = switchOf(dark!)
  if (!forLight || !forDark || light!.replace(forLight, '') !== dark!.replace(forDark, '')) throw new Error(`${path} isn't drawn the same in both themes but for its theme switch.`)
  return light!.replace(forLight, forLight.replace('<button ', '<button data-theme-only="light" ') + forDark.replace('<button ', '<button data-theme-only="dark" '))
}
