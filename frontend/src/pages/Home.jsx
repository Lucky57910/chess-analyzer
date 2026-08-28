import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Area, AreaChart, ResponsiveContainer, Tooltip } from 'recharts'
import GameList from '../components/GameList'
import StatsSummary from '../components/StatsSummary'
import { formatBucket } from '../data/stats.js'
import { useQueue } from '../hooks/useQueue'
import { useSettings } from '../hooks/useSettings'
import { JUDGMENT_CLASS, JUDGMENT_LABEL } from '../utils/chess'
import { api } from '../utils/api'

const PHASE_LABEL = { opening: 'l’ouverture', middlegame: 'le milieu de partie', endgame: 'la finale' }

/** Days of history behind the small curve. Enough to see a direction. */
const CURVE_DAYS = 30

/**
 * A block of the home screen.
 *
 * Every one of them is a link or holds a button, which is the rule this screen
 * is built on: a dashboard that only restates numbers gets read once and
 * ignored afterwards. If a block has nothing to do, it does not belong here.
 */
function Card({ to, title, children, action }) {
  const body = (
    <div className="flex flex-col gap-1.5 rounded-lg border border-ink-800 bg-ink-900 px-4 py-3 transition-colors hover:border-ink-700">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-ink-300">{title}</h2>
        {action && <span className="shrink-0 text-xs text-accent">{action}</span>}
      </div>
      {children}
    </div>
  )
  return to ? (
    <Link to={to} className="block">
      {body}
    </Link>
  ) : (
    body
  )
}

export default function Home() {
  const { username } = useSettings()
  const { running, processed, progress, status, start } = useQueue()
  const [insights, setInsights] = useState(null)
  const [mistakes, setMistakes] = useState(null)
  const [curve, setCurve] = useState([])
  const [recent, setRecent] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!username) return
    Promise.all([
      api.insights({ kind: 'rated' }),
      api.mistakes('rated'),
      api.smoothedTrends(3, CURVE_DAYS, 'rated'),
      api.gamesPage({ limit: 3 }),
    ])
      .then(([i, m, c, page]) => {
        setInsights(i)
        setMistakes(m)
        setCurve(c)
        setRecent(page.games)
        setError(null)
      })
      .catch((err) => setError(err.message))
    // Follows the queue: a game finishing analysis changes every number here.
  }, [username, processed])

  if (!username) {
    return (
      <div className="rounded-lg border border-ink-800 bg-ink-900 p-6">
        <h1 className="text-lg font-medium">Reliez votre compte Chess.com</h1>
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

  if (error) return <p className="text-sm text-blunder">{error}</p>

  const queued = (status?.pending ?? 0) + (status?.running ?? 0)
  const comparison = insights?.comparison
  const summary = comparison?.current

  // The move number the damage lands on most often, and the phase that costs
  // the most. Both are already computed for the statistics screen; here they
  // become one sentence rather than two charts.
  const worstMoveNumber = (mistakes?.by_move_number ?? []).reduce(
    (worst, row) => (worst === null || row.count > worst.count ? row : worst),
    null,
  )
  const weakness = [
    summary?.weakest_phase ? `vous perdez le plus dans ${PHASE_LABEL[summary.weakest_phase]}` : null,
    worstMoveNumber ? `et vos fautes se concentrent autour du coup ${worstMoveNumber.move_number}` : null,
  ]
    .filter(Boolean)
    .join(' ')

  // The most recent of the mistakes worth replaying, not the largest: an error
  // from last night is a habit you can still catch.
  const replayable = [...(insights?.costly_mistakes ?? [])].sort((a, b) =>
    String(b.played_at ?? '').localeCompare(String(a.played_at ?? '')),
  )[0]

  const hasCurve = curve.some((point) => point.blunders_per_game !== null)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Vue d’ensemble</h1>
        {comparison && (
          <span className="text-xs text-ink-500">
            {comparison.days} derniers jours · {summary.games} partie
            {summary.games > 1 ? 's' : ''} classée{summary.games > 1 ? 's' : ''}
          </span>
        )}
      </div>

      {summary ? (
        <StatsSummary stats={summary} comparison={comparison} />
      ) : (
        <p className="rounded-lg border border-dashed border-ink-700 p-6 text-center text-sm text-ink-500">
          Aucune partie classée sur la période. Lancez une synchronisation depuis l’onglet Parties.
        </p>
      )}

      {/* The queue costs battery and only runs in the foreground, so the one
          thing this screen exists to prompt is starting it. */}
      {queued > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-accent/10 px-4 py-3">
          <div className="flex-1 text-sm">
            {running ? (
              <span className="text-ink-100">
                Analyse en cours · {processed} terminée(s)
                {progress && ` · position ${progress.done}/${progress.total}`}
              </span>
            ) : (
              <>
                <span className="text-ink-100">
                  {queued} partie{queued > 1 ? 's' : ''} en attente d’analyse
                </span>
                <span className="text-ink-500"> · les statistiques les ignorent jusque-là.</span>
              </>
            )}
          </div>
          {!running && (
            <button
              type="button"
              onClick={start}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-ink-950"
            >
              Analyser
            </button>
          )}
        </div>
      )}

      {hasCurve && (
        <Card to="/stats" title="Gaffes par partie" action="Voir les statistiques">
          <div className="h-20">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={curve} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                <Tooltip
                  formatter={(value) => [`${value} gaffes / partie`, '']}
                  labelFormatter={(key) => formatBucket(key, 'smooth')}
                  contentStyle={{
                    background: 'var(--color-ink-900)',
                    border: '1px solid var(--color-ink-700)',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="blunders_per_game"
                  stroke="var(--color-blunder)"
                  fill="var(--color-blunder)"
                  fillOpacity={0.25}
                  strokeWidth={2}
                  connectNulls
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-ink-500">
            Lissé sur la semaine autour de chaque jour, {CURVE_DAYS} derniers jours.
          </p>
        </Card>
      )}

      {weakness && (
        <Card to="/stats" title="Votre point faible" action="Détail">
          <p className="text-sm text-ink-100 first-letter:uppercase">{weakness}.</p>
        </Card>
      )}

      {replayable && (
        <Card
          to={`/games/${replayable.game_id}`}
          title="La dernière erreur à rejouer"
          action="Ouvrir la partie"
        >
          <p className="text-sm">
            <span className="font-mono text-ink-500">{replayable.move_number}.</span>{' '}
            <span className="font-mono text-ink-100">{replayable.san}</span>{' '}
            <span className={JUDGMENT_CLASS[replayable.judgment]}>
              {JUDGMENT_LABEL[replayable.judgment]}
            </span>{' '}
            <span className="text-ink-500">
              contre {replayable.opponent} — il fallait jouer {replayable.best_move_san}
            </span>
          </p>
        </Card>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-ink-300">Dernières parties</h2>
          <Link to="/games" className="text-xs text-accent">
            Tout l’historique
          </Link>
        </div>
        <GameList games={recent} emptyLabel="Aucune partie importée." />
      </div>
    </div>
  )
}
