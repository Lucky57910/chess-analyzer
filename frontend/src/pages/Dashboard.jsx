import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import GameList from '../components/GameList'
import StatsSummary from '../components/StatsSummary'
import { useQueue } from '../hooks/useQueue'
import { useSettings } from '../hooks/useSettings'
import { api } from '../utils/api'

const FILTERS = [
  { label: 'Toutes', value: {} },
  { label: 'Blitz', value: { time_class: 'blitz' } },
  { label: 'Rapide', value: { time_class: 'rapid' } },
  { label: 'Défaites', value: { result: 'loss' } },
]

export default function Dashboard() {
  const { username } = useSettings()
  const { running, processed, progress, status, start, stop, refreshStatus } = useQueue()
  const [games, setGames] = useState([])
  const [stats, setStats] = useState(null)
  const [filter, setFilter] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const [g, s] = await Promise.all([
        api.games({ limit: 25, ...FILTERS[filter].value }),
        api.stats(),
      ])
      setGames(g)
      setStats(s)
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [filter])

  useEffect(() => {
    load()
  }, [load])

  // Reload as the queue finishes games. `processed` changes once per game, so
  // this follows the work instead of polling a clock the way the server
  // version had to.
  useEffect(() => {
    if (processed > 0) load()
  }, [processed, load])

  async function onSync() {
    setSyncing(true)
    setError(null)
    try {
      await api.sync(1)
      await refreshStatus()
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setSyncing(false)
    }
  }

  if (!username) {
    return (
      <div className="rounded-lg border border-ink-800 bg-ink-900 p-6">
        <h2 className="text-lg font-medium">Reliez votre compte Chess.com</h2>
        <p className="mt-1 text-sm text-ink-300">
          Renseignez votre pseudo Chess.com dans les réglages pour importer vos parties.
        </p>
        <Link
          to="/settings"
          className="mt-4 inline-block rounded-md bg-accent px-3 py-2 text-sm font-medium text-ink-950"
        >
          Aller aux réglages
        </Link>
      </div>
    )
  }

  const queued = (status?.pending ?? 0) + (status?.running ?? 0)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Dernières parties</h1>
        <div className="flex items-center gap-3 text-sm text-ink-500">
          {status && (
            <span>
              {status.done} analysées
              {queued > 0 && ` · ${queued} en file`}
              {status.error > 0 && ` · ${status.error} en échec`}
            </span>
          )}
          <button
            type="button"
            onClick={onSync}
            disabled={syncing || running}
            className="rounded-md border border-ink-700 px-3 py-1.5 text-ink-300 hover:bg-ink-800 disabled:opacity-50"
          >
            {syncing ? 'Import…' : 'Synchroniser'}
          </button>
        </div>
      </div>

      {/* The queue is the user's decision now: it costs battery and it only
          runs while they are looking at it, so it does not start itself. */}
      {(queued > 0 || running) && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-800 bg-ink-900 px-4 py-3">
          <div className="flex-1 text-sm">
            {running ? (
              <>
                <span className="text-ink-100">Analyse en cours</span>
                <span className="text-ink-500">
                  {' · '}
                  {processed} partie(s) terminée(s)
                  {progress && ` · position ${progress.done}/${progress.total}`}
                </span>
              </>
            ) : (
              <span className="text-ink-300">
                {queued} partie(s) en attente d’analyse.
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={running ? stop : start}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-ink-950"
          >
            {running ? 'Arrêter' : 'Analyser'}
          </button>
        </div>
      )}

      {error && (
        <p className="rounded-md border border-blunder/40 bg-blunder/10 px-3 py-2 text-sm text-blunder">
          {error}
        </p>
      )}

      <StatsSummary stats={stats} />

      <div className="flex gap-2">
        {FILTERS.map((f, i) => (
          <button
            key={f.label}
            type="button"
            onClick={() => setFilter(i)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              i === filter ? 'bg-ink-700 text-ink-100' : 'text-ink-500 hover:bg-ink-800'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <GameList
        games={games}
        emptyLabel={
          status?.total
            ? 'Aucune partie pour ce filtre.'
            : 'Aucune partie importée. Lancez une synchronisation.'
        }
      />
    </div>
  )
}
