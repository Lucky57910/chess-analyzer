import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import StatsSummary, {
  ACCURACY_NOTE,
  CP_NOTE,
  JUDGMENT_NOTE,
  SCORE_NOTE,
} from '../components/StatsSummary'
import { formatBucket } from '../data/stats.js'
import { JUDGMENT_CLASS, JUDGMENT_LABEL } from '../utils/chess'
import { api } from '../utils/api'

const PHASE_LABEL = { opening: 'Ouverture', middlegame: 'Milieu', endgame: 'Finale' }
const axis = { fill: 'var(--color-ink-500)', fontSize: 11 }

const PERIOD_LABEL = { day: 'Jour', week: 'Semaine', month: 'Mois' }

/**
 * How many buckets to ask for, per granularity.
 *
 * A single number cannot serve all three: 16 buckets is four months by week and
 * barely two weeks by day, which is exactly the window a daily view exists to
 * widen. These are chosen so each period covers a comparable stretch of time.
 */
const TREND_BUCKETS = { day: 60, week: 26, month: 24 }

/** "3 semaines", "1 jour", "8 mois" - `mois` does not take the plural. */
function bucketCount(n, period) {
  const noun = { day: 'jour', week: 'semaine', month: 'mois' }[period]
  return `${n} ${noun}${n > 1 && period !== 'month' ? 's' : ''}`
}

/**
 * The two honest ways to count mistakes over time.
 *
 * Per game is what the player feels. Per 100 moves is what actually trends: a
 * 25-move loss and an 80-move grind offer very different numbers of chances to
 * blunder, so a quiet week of long games can otherwise look like a collapse.
 */
const NORMALISE = {
  game: { key: 'per_game', label: 'Par partie', unit: 'par partie' },
  moves: { key: 'per_100', label: 'Pour 100 coups', unit: 'pour 100 de vos coups' },
}

const JUDGMENT_SERIES = [
  { field: 'blunders', label: 'Gaffes', color: 'var(--color-blunder)' },
  { field: 'mistakes', label: 'Erreurs', color: 'var(--color-mistake)' },
  { field: 'inaccuracies', label: 'Imprécisions', color: 'var(--color-inaccuracy)' },
]

function Panel({ title, hint, children, className = '' }) {
  return (
    <section className={`rounded-lg border border-ink-800 bg-ink-900 ${className}`}>
      <div className="border-b border-ink-700 px-4 py-2">
        <h2 className="text-sm font-medium text-ink-300">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function BreakdownTable({ rows }) {
  if (!rows?.length) return <p className="px-4 py-4 text-sm text-ink-500">Pas de données.</p>
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs uppercase tracking-wide text-ink-500">
          <th className="px-4 py-2 text-left font-normal">Nom</th>
          <th className="px-2 py-2 text-right font-normal">Parties</th>
          <th className="px-2 py-2 text-right font-normal" title={SCORE_NOTE}>
            Score
          </th>
          <th className="px-4 py-2 text-right font-normal" title={ACCURACY_NOTE}>
            Précision
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-ink-800">
        {rows.map((r) => (
          <tr key={r.name}>
            <td className="max-w-0 truncate px-4 py-2 text-ink-100">{r.name}</td>
            <td className="px-2 py-2 text-right tabular-nums text-ink-300">{r.games}</td>
            <td className="px-2 py-2 text-right tabular-nums text-ink-300">{r.win_rate}%</td>
            <td className="px-4 py-2 text-right tabular-nums text-ink-300">
              {r.avg_accuracy != null ? `${r.avg_accuracy}%` : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function Stats() {
  const [stats, setStats] = useState(null)
  const [trends, setTrends] = useState([])
  const [judgments, setJudgments] = useState([])
  const [mistakes, setMistakes] = useState(null)
  const [period, setPeriod] = useState('week')
  const [normalise, setNormalise] = useState('game')
  const [error, setError] = useState(null)

  // Split from the series below because neither of these depends on the
  // granularity: rebuilding them on every click of Jour/Semaine/Mois means two
  // more full passes over the archive for numbers that cannot have changed.
  useEffect(() => {
    Promise.all([api.stats(), api.mistakes()])
      .then(([s, m]) => {
        setStats(s)
        setMistakes(m)
      })
      .catch((err) => setError(err.message))
  }, [])

  useEffect(() => {
    const buckets = TREND_BUCKETS[period]
    Promise.all([api.trends(period, buckets), api.judgmentTrends(period, buckets)])
      .then(([t, j]) => {
        setTrends(t)
        setJudgments(j)
      })
      .catch((err) => setError(err.message))
  }, [period])

  if (error) return <p className="text-sm text-blunder">{error}</p>
  if (!stats) return <p className="text-sm text-ink-500">Chargement…</p>

  const phaseData = Object.entries(stats.phase_acpl).map(([phase, acpl]) => ({
    phase: PHASE_LABEL[phase],
    acpl,
  }))

  const sum = (field) => judgments.reduce((n, point) => n + (point[field] ?? 0), 0)
  const windowBlunders = sum('blunders')
  const windowGames = sum('analysed')
  const plural = (n) => (n > 1 ? 's' : '')
  const judgmentTotal = windowGames
    ? `${windowBlunders} gaffe${plural(windowBlunders)} sur ${windowGames} partie${plural(
        windowGames,
      )} analysée${plural(windowGames)}`
    : 'Aucune partie analysée sur la période'

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Statistiques</h1>

      <StatsSummary stats={stats} />

      {/* One control for both time series below: two panels reading the same
          granularity from a button row buried in the first one reads as a
          coincidence rather than a setting. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-300">Granularité</span>
        {['day', 'week', 'month'].map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            className={`rounded-md px-2.5 py-1 text-xs ${
              p === period ? 'bg-ink-700 text-ink-100' : 'text-ink-500 hover:bg-ink-800'
            }`}
          >
            {PERIOD_LABEL[p]}
          </button>
        ))}
        <span className="ml-auto text-xs text-ink-500">{bucketCount(trends.length, period)}</span>
      </div>

      <Panel
        title="Précision et score dans le temps"
        hint="Deux mesures indépendantes, toutes deux sur 100 : la qualité de vos coups, et vos résultats."
      >
        <div className="h-64 p-3">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trends} margin={{ top: 8, right: 12, bottom: 0, left: -20 }}>
              <CartesianGrid stroke="var(--color-ink-700)" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="period"
                tick={axis}
                stroke="var(--color-ink-700)"
                minTickGap={20}
                tickFormatter={(key) => formatBucket(key, period)}
              />
              <YAxis
                domain={[0, 100]}
                tick={axis}
                stroke="var(--color-ink-700)"
                unit="%"
                width={44}
              />
              <Tooltip
                formatter={(value, name) => [value == null ? '—' : `${value} %`, name]}
                labelFormatter={(key) => `${PERIOD_LABEL[period]} ${key}`}
                contentStyle={{
                  background: 'var(--color-ink-900)',
                  border: '1px solid var(--color-ink-700)',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              {/* Two anonymous lines is what made this chart unreadable: nothing
                  on screen said which was which, or what either measured. */}
              <Legend
                verticalAlign="bottom"
                height={28}
                iconType="plainline"
                wrapperStyle={{ fontSize: 12, color: 'var(--color-ink-300)' }}
              />
              <Line
                type="monotone"
                dataKey="avg_accuracy"
                name="Précision moyenne (qualité des coups)"
                stroke="var(--color-accent)"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="win_rate"
                name="Score (résultats)"
                stroke="var(--color-good)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <Panel
        title="Gaffes, erreurs et imprécisions dans le temps"
        hint="La surface à faire baisser. Les gaffes sont en bas : c’est celle-là qui coûte des parties."
      >
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          {Object.entries(NORMALISE).map(([key, { label }]) => (
            <button
              key={key}
              type="button"
              onClick={() => setNormalise(key)}
              className={`rounded-md px-2.5 py-1 text-xs ${
                key === normalise ? 'bg-ink-700 text-ink-100' : 'text-ink-500 hover:bg-ink-800'
              }`}
            >
              {label}
            </button>
          ))}
          <span className="ml-auto text-xs text-ink-500">{judgmentTotal}</span>
        </div>
        <div className="h-64 p-3">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={judgments} margin={{ top: 8, right: 12, bottom: 0, left: -20 }}>
              <CartesianGrid stroke="var(--color-ink-700)" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="period"
                tick={axis}
                stroke="var(--color-ink-700)"
                minTickGap={20}
                tickFormatter={(key) => formatBucket(key, period)}
              />
              <YAxis tick={axis} stroke="var(--color-ink-700)" width={44} allowDecimals={false} />
              <Tooltip
                formatter={(value, name) => [
                  value == null ? '—' : `${value} ${NORMALISE[normalise].unit}`,
                  name,
                ]}
                labelFormatter={(key) => `${PERIOD_LABEL[period]} ${key}`}
                contentStyle={{
                  background: 'var(--color-ink-900)',
                  border: '1px solid var(--color-ink-700)',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <Legend
                verticalAlign="bottom"
                height={28}
                wrapperStyle={{ fontSize: 12, color: 'var(--color-ink-300)' }}
              />
              {/* Declared worst-first so blunders sit on the axis: the band
                  that matters is the one you can read without adding up the
                  ones underneath it. */}
              {JUDGMENT_SERIES.map(({ field, label, color }) => (
                <Area
                  key={field}
                  type="monotone"
                  dataKey={`${field}_${NORMALISE[normalise].key}`}
                  name={label}
                  stackId="judgments"
                  stroke={color}
                  fill={color}
                  fillOpacity={0.45}
                  strokeWidth={1.5}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Ce que vos coups coûtent, par phase de la partie"
          hint="En centipions : 100 cp = 1 pion. Barre haute = c’est là que vous perdez le plus de matériel et de position."
        >
          <div className="h-48 p-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={phaseData} margin={{ top: 8, right: 12, bottom: 0, left: -20 }}>
                <CartesianGrid
                  stroke="var(--color-ink-700)"
                  strokeDasharray="2 4"
                  vertical={false}
                />
                <XAxis dataKey="phase" tick={axis} stroke="var(--color-ink-700)" />
                <YAxis tick={axis} stroke="var(--color-ink-700)" />
                <Tooltip
                  cursor={{ fill: 'var(--color-ink-800)' }}
                  formatter={(value) => [`${value} cp (${(value / 100).toFixed(2)} pion)`, 'Perte moyenne']}
                  contentStyle={{
                    background: 'var(--color-ink-900)',
                    border: '1px solid var(--color-ink-700)',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Bar
                  dataKey="acpl"
                  name="Perte moyenne par coup"
                  fill="var(--color-mistake)"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Par cadence">
          <BreakdownTable rows={stats.by_time_class} />
        </Panel>

        <Panel title="Par couleur">
          <BreakdownTable
            rows={stats.by_color.map((r) => ({
              ...r,
              name: r.name === 'white' ? 'Blancs' : 'Noirs',
            }))}
          />
        </Panel>

        <Panel title="Adversaires fréquents">
          <BreakdownTable rows={stats.top_opponents} />
        </Panel>

        <Panel title="Ouvertures" className="lg:col-span-2">
          <BreakdownTable rows={stats.top_openings} />
        </Panel>
      </div>

      {/* The tables put score and accuracy side by side in the same percent
          format, which reads as two spellings of one number. They are not. */}
      <dl className="grid gap-3 rounded-lg border border-ink-800 bg-ink-900 px-4 py-3 text-xs sm:grid-cols-3">
        <div>
          <dt className="font-medium text-ink-300">Score</dt>
          <dd className="mt-0.5 text-ink-500">{SCORE_NOTE}</dd>
        </div>
        <div>
          <dt className="font-medium text-ink-300">Précision</dt>
          <dd className="mt-0.5 text-ink-500">{ACCURACY_NOTE}</dd>
        </div>
        <div>
          <dt className="font-medium text-ink-300">Centipion (cp)</dt>
          <dd className="mt-0.5 text-ink-500">
            {CP_NOTE} {JUDGMENT_NOTE}
          </dd>
        </div>
      </dl>

      {/* Computed since the first version and never drawn: which move number
          the damage lands on. It is the one chart here that points at a habit
          rather than at a game. */}
      {mistakes?.by_move_number?.length ? (
        <Panel
          title="À quel coup vous craquez"
          hint="Nombre d’erreurs et de gaffes par numéro de coup, toutes parties confondues."
        >
          <div className="h-48 p-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={mistakes.by_move_number}
                margin={{ top: 8, right: 12, bottom: 0, left: -20 }}
              >
                <CartesianGrid
                  stroke="var(--color-ink-700)"
                  strokeDasharray="2 4"
                  vertical={false}
                />
                {/* A numeric axis, not a categorical one: move 7 and move 23
                    are far apart, and a category axis would draw them side by
                    side and flatten the shape being looked for. */}
                <XAxis
                  type="number"
                  dataKey="move_number"
                  domain={['dataMin', 'dataMax']}
                  tick={axis}
                  stroke="var(--color-ink-700)"
                  allowDecimals={false}
                />
                <YAxis tick={axis} stroke="var(--color-ink-700)" allowDecimals={false} width={44} />
                <Tooltip
                  cursor={{ fill: 'var(--color-ink-800)' }}
                  formatter={(value) => [value, 'Fautes']}
                  labelFormatter={(n) => `Coup ${n}`}
                  contentStyle={{
                    background: 'var(--color-ink-900)',
                    border: '1px solid var(--color-ink-700)',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="count" name="Fautes" fill="var(--color-blunder)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      ) : null}

      <Panel
        title="Vos pires coups"
        hint="Triés par nombre de centipions perdus, toutes parties confondues."
      >
        {mistakes?.worst_moves?.length ? (
          <ul className="divide-y divide-ink-800">
            {mistakes.worst_moves.slice(0, 12).map((m, i) => (
              <li key={`${m.game_id}-${m.ply}-${i}`}>
                <Link
                  to={`/games/${m.game_id}`}
                  className="flex items-baseline justify-between gap-3 px-4 py-2 text-sm hover:bg-ink-800"
                >
                  <span>
                    <span className="font-mono text-ink-500">{m.move_number}.</span>{' '}
                    <span className="font-mono text-ink-100">{m.san}</span>{' '}
                    <span className={JUDGMENT_CLASS[m.judgment]}>
                      {JUDGMENT_LABEL[m.judgment]}
                    </span>{' '}
                    <span className="text-ink-500">vs {m.opponent}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs text-ink-500">
                    −{(m.cp_loss / 100).toFixed(2)} · mieux : {m.best_move_san}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-4 text-sm text-ink-500">Rien à signaler pour l’instant.</p>
        )}
      </Panel>
    </div>
  )
}
