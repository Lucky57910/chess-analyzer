import { useCallback, useEffect, useMemo, useState } from 'react'
import GameList from '../components/GameList'
import Icon from '../components/Icon'
import StatsSummary from '../components/StatsSummary'
import Button from '../components/ui/Button'
import { Card } from '../components/ui/Card'
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
    key: 'kind',
    label: 'Type',
    options: [
      ['', 'Toutes'],
      ['rated', 'Classées'],
      ['training', 'Entraînement'],
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

const NO_FILTERS = { result: '', time_class: '', color: '', kind: '', status: '', search: '' }

/**
 * Search always, the five dropdowns on request.
 *
 * Open, this block is a search field and five labelled selects: on a phone
 * that is most of a screen, permanently, above a list nobody has filtered yet.
 * Collapsed it is one field and a button carrying the number of filters that
 * are on, so the archive starts where it can be seen. Nothing was removed —
 * the selects are one tap away, and the count means a filter left on cannot be
 * forgotten about.
 */
function FilterBar({ filters, onChange, searchInput, onSearch, onReset, active }) {
  const [open, setOpen] = useState(false)
  const count = FILTER_FIELDS.filter(({ key }) => filters[key]).length

  return (
    <Card className="flex flex-col gap-3 p-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Icon
            name="search"
            size={16}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint"
          />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Chercher un adversaire ou une ouverture"
            aria-label="Chercher un adversaire ou une ouverture"
            className="min-h-11 w-full rounded-lg border border-line-strong bg-canvas pr-3 pl-9 text-body text-text placeholder:text-faint"
          />
        </div>
        <Button
          size="sm"
          variant={count ? 'primary' : 'secondary'}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          Filtres{count ? ` (${count})` : ''}
        </Button>
      </div>

      {open && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {FILTER_FIELDS.map(({ key, label, options }) => (
            <label key={key} className="flex flex-col gap-1 text-label text-faint">
              {label}
              <select
                value={filters[key]}
                onChange={(e) => onChange(key, e.target.value)}
                className="min-h-11 rounded-lg border border-line-strong bg-canvas px-2 text-body text-text"
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
      )}

      {active && (
        <Button size="sm" variant="ghost" icon="close" onClick={onReset} className="self-start">
          Réinitialiser les filtres
        </Button>
      )}
    </Card>
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
      <Card className="p-6">
        <h2 className="text-lead font-medium">Reliez votre compte Chess.com</h2>
        <p className="mt-1 text-body text-muted">
          Renseignez votre pseudo Chess.com dans les réglages pour importer vos parties.
        </p>
        <Button to="/settings" variant="primary" className="mt-4">
          Aller aux réglages
        </Button>
      </Card>
    )
  }

  const queued = (status?.pending ?? 0) + (status?.running ?? 0)
  const hasMore = games.length < total

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Parties</h1>
          {status && (
            <p className="text-label text-faint">
              {status.done} analysées
              {queued > 0 && ` · ${queued} en file`}
              {status.error > 0 && ` · ${status.error} en échec`}
            </p>
          )}
        </div>
        <Button size="sm" icon="refresh" onClick={onSync} disabled={syncing || running}>
          {syncing ? 'Import…' : 'Synchroniser'}
        </Button>
      </div>

      {/* The queue is the user's decision now: it costs battery and it only
          runs while they are looking at it, so it does not start itself. */}
      {(queued > 0 || running) && (
        <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="flex-1 text-body">
            {running ? (
              <>
                <span className="text-text">Analyse en cours</span>
                <span className="text-faint">
                  {' · '}
                  {processed} partie(s) terminée(s)
                  {progress && ` · position ${progress.done}/${progress.total}`}
                </span>
              </>
            ) : (
              <span className="text-muted">{queued} partie(s) en attente d’analyse.</span>
            )}
          </div>
          <Button size="sm" variant="primary" onClick={running ? stop : start}>
            {running ? 'Arrêter' : 'Analyser'}
          </Button>
        </Card>
      )}

      {error && (
        <p className="rounded-lg border border-blunder/40 bg-blunder/10 px-3 py-2 text-body text-blunder">
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
        <div className="flex items-baseline justify-between text-label text-faint">
          <span>
            {total > 0
              ? `${games.length} sur ${total} partie${total > 1 ? 's' : ''}`
              : 'Aucune partie'}
          </span>
          {loading && <span role="status">Chargement…</span>}
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
          <Button
            onClick={() => setPages((p) => p + 1)}
            disabled={loading}
            icon="chevronDown"
            className="self-center"
          >
            Charger {Math.min(PAGE_SIZE, total - games.length)} de plus
          </Button>
        )}
      </div>
    </div>
  )
}
