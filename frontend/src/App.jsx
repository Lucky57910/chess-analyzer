import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Navigation from './components/Navigation'
import WakeUpBanner from './components/WakeUpBanner'
import { useAuth } from './hooks/useAuth'
import Login from './pages/Login'

// Split per route: the first paint is the login screen, and the charting
// library only travels with the pages that actually draw a chart.
const Dashboard = lazy(() => import('./pages/Dashboard'))
const GameAnalysis = lazy(() => import('./pages/GameAnalysis'))
const Settings = lazy(() => import('./pages/Settings'))
const Stats = lazy(() => import('./pages/Stats'))

const Loading = <p className="p-8 text-sm text-ink-500">Chargement…</p>

function Protected({ children }) {
  const { user, loading } = useAuth()
  if (loading) return Loading
  if (!user) return <Navigate to="/login" replace />
  return (
    <>
      <Navigation />
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Suspense fallback={Loading}>{children}</Suspense>
      </main>
    </>
  )
}

export default function App() {
  return (
    <>
      <WakeUpBanner />
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
    </>
  )
}
