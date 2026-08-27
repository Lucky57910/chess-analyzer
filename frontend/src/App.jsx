import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Navigation from './components/Navigation'
import { useSettings } from './hooks/useSettings'

// Split per route: the charting library only travels with the pages that draw
// a chart, which matters more now that everything ships inside an APK.
const Dashboard = lazy(() => import('./pages/Dashboard'))
const GameAnalysis = lazy(() => import('./pages/GameAnalysis'))
const Settings = lazy(() => import('./pages/Settings'))
const Stats = lazy(() => import('./pages/Stats'))

const Loading = <p className="p-8 text-sm text-ink-500">Chargement…</p>

/**
 * There is no longer anything to protect.
 *
 * The login screen and the route guard existed because the games lived on a
 * public server. They live on this phone now, behind its lock screen, so the
 * shell just renders.
 */
function Shell({ children }) {
  const { loading, error } = useSettings()

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-lg font-medium text-blunder">Base de données inaccessible</h1>
        <p className="mt-2 text-sm text-ink-300">{error}</p>
        <p className="mt-4 text-xs text-ink-500">
          Fermez puis rouvrez l’application. Si le problème persiste, l’espace de stockage du
          téléphone est peut-être plein.
        </p>
      </main>
    )
  }
  if (loading) return Loading

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
    <Routes>
      <Route
        path="/"
        element={
          <Shell>
            <Dashboard />
          </Shell>
        }
      />
      <Route
        path="/games/:gameId"
        element={
          <Shell>
            <GameAnalysis />
          </Shell>
        }
      />
      <Route
        path="/stats"
        element={
          <Shell>
            <Stats />
          </Shell>
        }
      />
      <Route
        path="/settings"
        element={
          <Shell>
            <Settings />
          </Shell>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
