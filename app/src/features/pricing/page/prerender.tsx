import { renderToStaticMarkup } from 'react-dom/server'
import { PricePageView } from './page'
import { Television } from './set'
import type { PageDoc } from './shape'

// A page drawn by page.tsx, as HTML, for app/price-pages.ts to write as the page's own file. Rendered in Node at build
// time: nothing here may need a browser. set: /compare with the television over it.
export const renderPage = (doc: PageDoc, set = false) => renderToStaticMarkup(<PricePageView doc={doc} set={set ? <Television doc={doc} /> : undefined} />)
