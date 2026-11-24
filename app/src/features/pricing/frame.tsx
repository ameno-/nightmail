import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { NightmailWordmark } from '../../components/NightmailLogo'
import { productName } from '../../../../api/src/brand'

/** A price page as a scene (index.tsx; prerender.tsx paints the same before the app's code): it runs to the window's
 *  top edge, the same in either theme, the wordmark a quiet link in its corner with a link past it to the board for a
 *  keyboard, and `end` its own footer (board.tsx, BoardEnd), the homepage's. (No styles imported here: board.css.) */
export function SceneFrame({ children, end }: { children: ReactNode; end: ReactNode }) {
  return <div className="price-page price-page--board">
    <a className="skip-link" href="#price-main">Skip to the comparison</a>
    <header className="price-corner"><Link className="wordmark" to="/" aria-label={`${productName.toLowerCase()} home`}><NightmailWordmark /></Link></header>
    <main className="price-main" id="price-main" tabIndex={-1}>{children}</main>
    {end}
  </div>
}
