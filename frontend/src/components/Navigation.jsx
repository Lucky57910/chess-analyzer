import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

const linkClass = ({ isActive }) =>
  `rounded-md px-3 py-1.5 text-sm transition-colors ${
    isActive ? 'bg-ink-700 text-ink-100' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
  }`

export default function Navigation() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

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
          <span className="hidden sm:inline">
            {user?.username}
            {user?.chess_com_username && (
              <span className="text-ink-500"> · {user.chess_com_username}</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              logout()
              navigate('/login')
            }}
            className="rounded-md border border-ink-700 px-3 py-1.5 hover:bg-ink-800"
          >
            Déconnexion
          </button>
        </div>
      </nav>
    </header>
  )
}
