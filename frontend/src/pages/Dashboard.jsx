import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import GameList from '../components/GameList'
import StatsSummary from '../components/StatsSummary'
import { useQueue } from '../hooks/useQueue'
import { useSettings } from '../hooks/useSettings'
import { api } from '../utils/api'

const PAGE_SIZE = 25

/** Debounce on the search box, so typing does not scan the archive per key. */
const SEARCH_DELAY_MS = 250

const FILTER_FIELDS = [
  {
    key: 'result',
    label: 'Résultat',
    options: [
      ['', 'Tous'],
      ['win', 'Victoires'],
      ['draw', 'Nulles'],
      ['loss', 'Défaites'],
    ],
  },
  {
    key: 'time_class',
    label: 'Cadence',
    options: [
      ['', 'Toutes'],
      ['bullet', 'Bullet'],
      ['blitz', 'Blitz'],
      ['rapid', 'Rapide'],
      ['daily', 'Par jour'],
    ],
  },
  {
    key: 'color',
    label: 'Couleur',
    options: [
      ['', 'Les deux'],
      ['white', 'Blancs'],
      ['black', 'Noirs'],
    ],
  },
  {
    key: 'status',
    label: 'Analyse',
    options: [
      ['', 'Toutes'],
      ['done', 'Analysées'],
      ['pending', 'En attente'],
      ['error', 'En échec'],
    ],
  },
]

const NO_FILTERS = { result: '', time_class: '', color: '', status: '', search: '' }

function FilterBar({ filters, onChange, searchInput, onSearch, onReset, active }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-ink-800 bg-ink-900 p-3">
      <input
        type="search"
        value={searchInput}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Chercher un adversaire ou une ouverture"
        className="w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500"
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {FILTER_FIELDS.map(({ key, label, options }) => (
          <label key={key} className="flex flex-col gap-1 text-xs text-ink-500">
            {label}
            <select
              value={filters[key]}
              onChange={(e) => onChange(key, e.target.value)}
              className="rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100"
            >
              {options.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {active && (
        <button
          type="button"
          onClick={onReset}
          className="self-start text-xs text-ink-300 underline underline-offset-2 hover:text-ink-100"
        >
          Réinitialiser les filtres
        </button>
      )}
    </div>
  )
}

export default function Dashboard() {
  const { username } = useSettings()
  const { running, processed, progress, status, start, stop, refreshStatus } = useQueue()
  const [games, setGames] = useState([])
  const [total, setTotal] = useState(0)
  const [pages, setPages] = useState(1)
  const [filters, setFilters] = useState(NO_FILTERS)
  const [searchInput, setSearchInput] = useState('')
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState(null)

  // Typing is not a query. The box drives `filters.search` only once the user
  // has stopped, because every keystroke would otherwise be a LIKE scan of the
  // whole archive on a phone.
  useEffect(() => {
    if (searchInput === filters.search) return undefined
    const id = setTimeout(() => {
      setPages(1)
      setFilters((f) => ({ ...f, search: searchInput }))
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(id)
  }, [searchInput, filters.search])

  /**
   * Every loaded page is re-fetched as one query rather than appended.
   *
   * It costs a few hundred rows off an indexed local table, and it buys back
   * the whole class of bugs that offset-based appending has here: a game
   * finishing analysis, or a sync arriving, shifts nothing and duplicates
   * nothing, because the list is never stitched together from snapshots taken
   * at different times.
   */
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .gamesPage({ limit: pages * PAGE_SIZE, offset: 0, ...filters })
      .then(({ games: rows, total: count }) => {
        if (cancelled) return
        setGames(rows)
        setTotal(count)
        setError(null)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `processed` changes once per analysed game, which is the signal to redraw
    // the rows the queue has just filled in; `refresh` is the same signal after
    // an import.
  }, [filters, pages, processed, refresh])

  const loadStats = useCallback(() => {
    api
      .stats()
      .then(setStats)
      .catch((err) => setError(err.message))
  }, [])

  useEffect(() => {
    loadStats()
  }, [loadStats, processed])

  const active = useMemo(
    () => Object.entries(filters).some(([, value]) => value !== ''),
    [filters],
  )

  function onFilter(key, value) {
    setPages(1)
    setFilters((f) => ({ ...f, [key]: value }))
  }

  function onReset() {
    setPages(1)
    setSearchInput('')
    setFilters(NO_FILTERS)
  }

  async function onSync() {
    setSyncing(true)
    setError(null)
    try {
      await api.sync(1)
      await refreshStatus()
      setPages(1)
      setRefresh((n) => n + 1)
      loadStats()
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
  const hasMore = games.length < total

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Parties</h1>
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

      <FilterBar
        filters={filters}
        onChange={onFilter}
        searchInput={searchInput}
        onSearch={setSearchInput}
        onReset={onReset}
        active={active}
      />

      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between text-xs text-ink-500">
          <span>
            {total > 0
              ? `${games.length} sur ${total} partie${total > 1 ? 's' : ''}`
              : 'Aucune partie'}
          </span>
          {loading && <span>Chargement…</span>}
        </div>

        <GameList
          games={games}
          emptyLabel={
            active
              ? 'Aucune partie pour ces filtres.'
              : status?.total
                ? 'Aucune partie.'
                : 'Aucune partie importée. Lancez une synchronisation.'
          }
        />

        {hasMore && (
          <button
            type="button"
            onClick={() => setPages((p) => p + 1)}
            disabled={loading}
            className="self-center rounded-md border border-ink-700 px-4 py-2 text-sm text-ink-300 hover:bg-ink-800 disabled:opacity-50"
          >
            Charger {Math.min(PAGE_SIZE, total - games.length)} de plus
          </button>
        )}
      </div>
    </div>
  )
}
