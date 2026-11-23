// The comparison pages' own module, loaded only by /compare/* (index.tsx): the board and the stylesheets it needs (its
// own, and the homepage's machines' and end band's), so the calculator at /pricing never loads them. Here, not in
// board.tsx, the page gets its way in: the homepage's own button (home/start.tsx), Get started for a visitor, which
// signs in as the homepage's does and opens Overview, or Open dashboard for someone signed in. (board.tsx stays free of
// the session and the dashboard's prefetching, so the pre-merge check can render it.)
import { useSession } from '../../data/context'
import type { HomeStart } from '../home'
import { StartButton } from '../home/start'
import { ComparisonBoard, type Start } from './board'
import type { Comparison } from './prices'
import '../home/machines.css'
import './board.css'
export { BoardEnd } from './board'

export function ComparisonScene({ comparison, frame }: { comparison: Comparison; frame?: string | null }) {
  const session = useSession()
  const start: HomeStart = session?.identity ? { signedIn: true }
    : { signedIn: false, onSignIn: () => session?.signIn(), onSignInIntent: event => session?.signInIntent(event), busy: session?.signingIn ?? false }
  const way: Start = { signedIn: start.signedIn, button: className => <StartButton start={start} className={className} /> }
  return <ComparisonBoard comparison={comparison} start={way} frame={frame} />
}
