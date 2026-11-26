import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { GetStartedButton } from '../../home/get-started'
import type { Start } from '../board'
import { PricePageView } from './page'
import { Television } from './set'
import type { PageDoc } from './shape'

// A page drawn by page.tsx, as HTML, for app/price-pages.ts to paint before any of the app's code, with Get started as a
// visitor sees it (as the boards' prerender.tsx paints theirs); the app's page then takes its place (pricing.tsx).
// Rendered in Node at build time: nothing here may need a browser. set: /compare with the television over it.
const visitor: Start = { signedIn: false, button: className => <GetStartedButton className={className} /> }
export const renderPage = (doc: PageDoc, set = false) => renderToStaticMarkup(<MemoryRouter initialEntries={[doc.path]}>
  <PricePageView doc={doc} start={visitor} set={set ? <Television doc={doc} /> : undefined} />
</MemoryRouter>)
