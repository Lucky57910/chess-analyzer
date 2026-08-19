import { Navigate, Route, Routes } from 'react-router-dom'
import Navigation from './components/Navigation'
import { useAuth } from './hooks/useAuth'
import Dashboard from './pages/Dashboard'
import GameAnalysis from './pages/GameAnalysis'
import Login from './pages/Login'
import Settings from './pages/Settings'
import Stats from './pages/Stats'

function Protected({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <p className="p-8 text-sm text-ink-500">Chargement…</p>
  if (!user) return <Navigate to="/login" replace />
  return (
    <>
      <Navigation />
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <Protected>
            <Dashboard />
          </Protected>
        }
      />
      <Route
        path="/games/:gameId"
        element={
          <Protected>
            <GameAnalysis />
          </Protected>
        }
      />
      <Route
        path="/stats"
        element={
          <Protected>
            <Stats />
          </Protected>
        }
      />
      <Route
        path="/settings"
        element={
          <Protected>
            <Settings />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
