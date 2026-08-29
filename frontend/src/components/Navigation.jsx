import { Link, NavLink } from 'react-router-dom'
import Icon from './Icon'
import { useQueue } from '../hooks/useQueue'
import { useSettings } from '../hooks/useSettings'

/**
 * Four destinations, in two places.
 *
 * On a phone they sit at the bottom, where a thumb reaches: this app is used
 * one-handed on a couch, and a row of small links pinned to the top edge is
 * the least reachable strip of a 6-inch screen. On a desktop they sit in the
 * header, where the pointer already is.
 *
 * The overview used to be reachable only by tapping the title, which is a
 * convention on the web and nothing at all on Android. It is a destination
 * now, so this is four items — the maximum a bottom bar should hold is five.
 */
const DESTINATIONS = [
  { to: '/', icon: 'home', label: 'Accueil', end: true },
  { to: '/games', icon: 'games', label: 'Parties' },
  { to: '/stats', icon: 'stats', label: 'Statistiques', short: 'Stats' },
  { to: '/settings', icon: 'settings', label: 'Réglages' },
]

/** What the analysis queue is doing, said the same way in both bars. */
function QueueState() {
  const { running, status } = useQueue()
  const queued = (status?.pending ?? 0) + (status?.running ?? 0)

  if (running) {
    return (
      <span className="flex items-center gap-1.5 text-label text-accent" aria-live="polite">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        Analyse…
      </span>
    )
  }
  if (queued > 0) {
    return <span className="text-label text-faint">{queued} en attente</span>
  }
  return null
}

const topLink = ({ isActive }) =>
  `flex min-h-11 items-center gap-2 rounded-lg px-3 text-body transition-colors ${
    isActive ? 'bg-line-strong text-text' : 'text-muted hover:bg-raised hover:text-text'
  }`

export default function Navigation() {
  const { username } = useSettings()

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 pt-safe backdrop-blur">
      <nav className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2">
        <Link
          to="/"
          className="mr-2 flex items-center gap-2 rounded-lg py-1 text-lead font-semibold tracking-tight transition-opacity hover:opacity-80"
        >
          <Icon name="knight" size={22} className="text-accent" />
          <span className="text-text">Chess Analyzer</span>
        </Link>

        {/* Desktop only: on a phone these live in the bottom bar instead, and
            having both would be the same four links twice on one screen. */}
        <div className="hidden items-center gap-1 lg:flex">
          {DESTINATIONS.filter((d) => d.to !== '/').map((d) => (
            <NavLink key={d.to} to={d.to} className={topLink}>
              {d.label}
            </NavLink>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <QueueState />
          {username && <span className="hidden text-label text-faint sm:inline">{username}</span>}
        </div>
      </nav>
    </header>
  )
}

/**
 * The bottom bar, phones only.
 *
 * Icon *and* label on every tab: an icon-only bar makes the user learn four
 * glyphs before they can navigate, and two of these ideas — "parties" and
 * "statistiques" — have no glyph anyone would guess.
 */
export function BottomBar() {
  const link = ({ isActive }) =>
    `flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 text-[11px] transition-colors ${
      isActive ? 'text-accent' : 'text-faint hover:text-muted'
    }`

  return (
    <nav
      aria-label="Navigation principale"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-safe backdrop-blur lg:hidden"
    >
      <div className="mx-auto flex min-h-14 max-w-md items-stretch gap-1 px-2 py-1">
        {DESTINATIONS.map((d) => (
          <NavLink key={d.to} to={d.to} end={d.end} className={link}>
            {({ isActive }) => (
              <>
                <Icon name={d.icon} size={21} strokeWidth={isActive ? 2.1 : 1.75} />
                {d.short ?? d.label}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
