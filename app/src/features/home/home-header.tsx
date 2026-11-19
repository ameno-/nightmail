import type { ReactNode, Ref } from 'react'
import { ThemeToggle } from '../../components/ThemeToggle'
import { NightmailMark } from '../../components/NightmailLogo'
import { productName } from '../../../../api/src/brand'

/** The homepage's header, over the sorter and over the factory: the monogram, the docs, whatever the page adds
 * (`children`: the way into the dashboard, a button, the sound), and the theme switch. */
export function HomeHeader({ ref, children }: { ref?: Ref<HTMLElement>; children?: ReactNode }) {
  return <header className="srt-header" ref={ref}>
    {/* The monogram alone: the wordmark is on the machine, over the price. */}
    <a className="srt-mark" href="/" aria-label={`${productName.toLowerCase()} home`}><NightmailMark /></a>
    <nav className="srt-nav" aria-label="Site">
      <a href="/docs">API docs</a>
      {children}
      <ThemeToggle />
    </nav>
  </header>
}
