import { NavLink } from 'react-router-dom'
import { useQueue } from '../hooks/useQueue'
import { useSettings } from '../hooks/useSettings'

const linkClass = ({ isActive }) =>
  `rounded-md px-3 py-1.5 text-sm transition-colors ${
    isActive ? 'bg-ink-700 text-ink-100' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
  }`

export default function Navigation() {
  const { username } = useSettings()
  const { running, status } = useQueue()

  const queued = (status?.pending ?? 0) + (status?.running ?? 0)

  return (
    <header className="border-b border-ink-800 bg-ink-900">
      <nav className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-3">
        <span className="mr-4 text-lg font-semibold tracking-tight">
          ♞ <span className="text-ink-100">Chess Analyzer</span>
        </span>
        <NavLink to="/" end className={linkClass}>
          Parties
        </NavLink>
        <NavLink to="/stats" className={linkClass}>
          Statistiques
        </NavLink>
        <NavLink to="/settings" className={linkClass}>
          Réglages
        </NavLink>

        <div className="ml-auto flex items-center gap-3 text-sm text-ink-300">
          {/* The queue only runs while the app is open, so its state belongs
              where it is visible from every screen. */}
          {running && (
            <span className="flex items-center gap-1.5 text-accent">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              Analyse…
            </span>
          )}
          {!running && queued > 0 && (
            <span className="text-ink-500">{queued} en attente</span>
          )}
          {username && <span className="hidden text-ink-500 sm:inline">{username}</span>}
        </div>
      </nav>
    </header>
  )
}
