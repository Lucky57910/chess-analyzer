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
  StatTile,
} from '../components/StatsSummary'
import { formatBucket } from '../data/stats.js'
import { JUDGMENT_CLASS, JUDGMENT_LABEL } from '../utils/chess'
import { api } from '../utils/api'

const PHASE_LABEL = { opening: 'Ouverture', middlegame: 'Milieu', endgame: 'Finale' }
const axis = { fill: 'var(--color-ink-500)', fontSize: 11 }

const PERIODS = ['smooth', 'day', 'week', 'month']
const PERIOD_LABEL = {
  smooth: 'Jour lissé',
  day: 'Jour',
  week: 'Semaine',
  month: 'Mois',
}

/**
 * How many buckets to ask for, per granularity.
 *
 * A single number cannot serve all four: 16 buckets is four months by week and
 * barely two weeks by day, which is exactly the window a daily view exists to
 * widen. These are chosen so each period covers a comparable stretch of time.
 */
const TREND_BUCKETS = { smooth: 60, day: 60, week: 26, month: 24 }

/** Days either side of each point in the smoothed view: a centred week. */
const SMOOTH_RADIUS = 3

/** "3 semaines", "1 jour", "8 mois" - `mois` does not take the plural. */
function bucketCount(n, period) {
  const noun = { smooth: 'jour', day: 'jour', week: 'semaine', month: 'mois' }[period]
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

function Section({ title, subtitle }) {
  return (
    <div className="mt-2">
      <h2 className="text-lg font-semibold text-ink-100">{title}</h2>
      <p className="text-sm text-ink-500">{subtitle}</p>
    </div>
  )
}

/** A generic three-column table: label, count, and one number that matters. */
function SimpleTable({ rows, head, cells, empty = 'Pas assez de données.' }) {
  if (!rows?.length) return <p className="px-4 py-4 text-sm text-ink-500">{empty}</p>
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs uppercase tracking-wide text-ink-500">
          {head.map((label, i) => (
            <th
              key={label}
              className={`py-2 font-normal ${i === 0 ? 'px-4 text-left' : 'px-2 text-right'}`}
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-ink-800">
        {rows.map((row, i) => (
          <tr key={row.key ?? row.name ?? i}>
            {cells(row).map((value, j) => (
              <td
                key={j}
                className={`py-2 ${
                  j === 0
                    ? 'max-w-0 truncate px-4 text-ink-100'
                    : 'px-2 text-right tabular-nums text-ink-300'
                }`}
              >
                {value}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
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
  const [insights, setInsights] = useState(null)
  // The smoothed daily view is the default: by week there are not enough weeks
  // to see anything yet, and by day one afternoon swings the line end to end.
  const [period, setPeriod] = useState('smooth')
  const [normalise, setNormalise] = useState('game')
  const [error, setError] = useState(null)

  // Split from the series below because neither of these depends on the
  // granularity: rebuilding them on every click of Jour/Semaine/Mois means two
  // more full passes over the archive for numbers that cannot have changed.
  useEffect(() => {
    Promise.all([api.stats(), api.mistakes(), api.insights()])
      .then(([s, m, i]) => {
        setStats(s)
        setMistakes(m)
        setInsights(i)
      })
      .catch((err) => setError(err.message))
  }, [])

  useEffect(() => {
    const buckets = TREND_BUCKETS[period]
    // The smoothed series carries both halves under the same field names, and
    // one pass over the archive builds them together.
    const load =
      period === 'smooth'
        ? api.smoothedTrends(SMOOTH_RADIUS, buckets).then((series) => [series, series])
        : Promise.all([api.trends(period, buckets), api.judgmentTrends(period, buckets)])

    load
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

      <StatsSummary stats={stats} comparison={insights?.comparison} />

      {insights?.comparison && (
        <p className="text-xs text-ink-500">
          Les flèches comparent les {insights.comparison.days} derniers jours aux{' '}
          {insights.comparison.days} précédents
          {insights.comparison.previous
            ? ` (${insights.comparison.current.games} parties contre ${insights.comparison.previous.games}).`
            : ' — pas encore de période précédente à comparer.'}
        </p>
      )}

      {/* Accuracy says how well the moves were played; these two say whether it
          mattered. Reaching winning positions and not converting them is a
          different problem from never reaching them. */}
      {insights?.conversion?.winning_positions > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <StatTile
            label="Conversion"
            value={
              insights.conversion.conversion_rate != null
                ? `${insights.conversion.conversion_rate}%`
                : null
            }
            hint={`${insights.conversion.converted} gagnées sur ${insights.conversion.winning_positions} positions gagnantes`}
            title="Part des parties où vous avez atteint +2 pions d’avantage et qui se sont terminées par une victoire."
            tone={insights.conversion.conversion_rate >= 80 ? 'good' : 'warn'}
          />
          <StatTile
            label="Résilience"
            value={
              insights.conversion.save_rate != null ? `${insights.conversion.save_rate}%` : null
            }
            hint={`${insights.conversion.saved} sauvées sur ${insights.conversion.losing_positions} positions perdues`}
            title="Part des parties où vous êtes tombé à −2 pions et que vous n’avez pas perdues."
            tone={insights.conversion.save_rate >= 20 ? 'good' : 'default'}
          />
        </div>
      )}

      {/* One control for both time series below: two panels reading the same
          granularity from a button row buried in the first one reads as a
          coincidence rather than a setting. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-300">Granularité</span>
        {PERIODS.map((p) => (
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
        hint={
          period === 'smooth'
            ? `Un point par jour, chacun décrivant sa propre journée et la semaine autour d’elle. Les points pâles sont les journées brutes.`
            : 'Deux mesures indépendantes, toutes deux sur 100 : la qualité de vos coups, et vos résultats.'
        }
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
              {/* The days themselves, under the trend. Kept out of the legend
                  so it stays two entries, and drawn without a stroke so they
                  read as the data the line was drawn through rather than as
                  two more series. */}
              {period === 'smooth' &&
                [
                  { key: 'raw_avg_accuracy', color: 'var(--color-accent)' },
                  { key: 'raw_win_rate', color: 'var(--color-good)' },
                ].map(({ key, color }) => (
                  <Line
                    key={key}
                    dataKey={key}
                    name="Journée brute"
                    legendType="none"
                    stroke="none"
                    strokeWidth={0}
                    dot={{ r: 1.8, fill: color, fillOpacity: 0.45, stroke: 'none' }}
                    activeDot={false}
                    isAnimationActive={false}
                  />
                ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <Panel
        title="Gaffes, erreurs et imprécisions dans le temps"
        hint={
          period === 'smooth'
            ? 'La surface à faire baisser, lissée sur la semaine autour de chaque jour. Les gaffes sont en bas.'
            : 'La surface à faire baisser. Les gaffes sont en bas : c’est celle-là qui coûte des parties.'
        }
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

      <Section
        title="Où vous perdez des points"
        subtitle="Ce que coûtent vos coups, et dans quelles conditions ils partent de travers."
      />
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

        {/* Chess.com ships a clock reading per move inside the PGN, which the
            importer already stores whole. The panel is absent rather than
            empty when no game carries one — a table of zeroes would claim
            every move was instant. */}
        {insights?.clock && (
          <Panel
            title="Le temps et les gaffes"
            hint={`Temps médian par coup : ${insights.clock.median_seconds} s, sur ${insights.clock.games} parties chronométrées.`}
          >
            {insights.clock.fast_blunder_share != null && (
              <p className="px-4 pt-3 text-sm text-ink-300">
                <span
                  className={
                    insights.clock.fast_blunder_share >= 50 ? 'text-blunder' : 'text-ink-100'
                  }
                >
                  {insights.clock.fast_blunder_share}%
                </span>{' '}
                de vos gaffes sont jouées en moins de 10 secondes
                {' '}({insights.clock.fast_blunders} sur {insights.clock.blunders}).
              </p>
            )}
            <SimpleTable
              rows={insights.clock.buckets}
              head={['Temps sur le coup', 'Coups', 'Gaffes', '% gaffes']}
              cells={(row) => [
                row.name,
                row.moves,
                row.blunders,
                row.blunder_rate != null ? `${row.blunder_rate}%` : '—',
              ]}
            />
          </Panel>
        )}

        <Panel
          title="Par pièce déplacée"
          hint="Perte moyenne selon la pièce que vous bougez. Désigne souvent une habitude plutôt qu’une partie."
        >
          <SimpleTable
            rows={insights?.by_piece}
            head={['Pièce', 'Coups', 'Perte moy.', 'Gaffes']}
            cells={(row) => [row.name, row.moves, `${row.avg_cp_loss} cp`, row.blunders]}
          />
        </Panel>

        <Panel
          title="Sortie d’ouverture"
          hint="Ce que coûtent vos 12 premiers coups. Sortez-vous vivant de votre répertoire ?"
        >
          <SimpleTable
            rows={insights?.opening_exit}
            head={['Ouverture', 'Parties', 'Perte moy.', 'Score']}
            cells={(row) => [row.name, row.games, `${row.acpl} cp`, `${row.win_rate}%`]}
            empty="Il faut au moins deux parties dans une même ouverture."
          />
        </Panel>
      </div>

      <Section
        title="Contre qui, et avec quoi"
        subtitle="Les mêmes résultats découpés par adversaire, cadence, couleur et répertoire."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {/* This replaces the frequent-opponents table. Pairing is close to
            random, so that one counted one or two games per name and then
            printed a win rate over them — noise with the formatting of a
            statistic. A rating gap asks the same question of a sample big
            enough to answer it. */}
        <Panel
          title="Par écart de classement"
          hint="Perdez-vous contre des joueurs que vous devriez battre ?"
        >
          <BreakdownTable rows={insights?.by_rating_gap} />
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

        <Panel
          title="Rang dans la session"
          hint="Parties espacées de moins de 30 min. Si la 4ᵉ est pire que la 1ʳᵉ, le remède est une habitude, pas une idée d’échecs."
        >
          <SimpleTable
            rows={insights?.session_tilt}
            head={['Partie', 'Nombre', 'Score', 'Gaffes / partie']}
            cells={(row) => [
              row.name,
              row.games,
              `${row.win_rate}%`,
              row.blunders_per_game ?? '—',
            ]}
          />
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

      {/* The old list ranked on centipawns lost alone, so it filled with moves
          played from already-lost positions: a −900 from −1200 teaches nothing
          and outranked the −250 that threw a level game. */}
      <Panel
        title="Les coups qui vous ont coûté la partie"
        hint="Votre pire coup par partie, et seulement ceux joués dans une position encore jouable."
      >
        {insights?.costly_mistakes?.length ? (
          <ul className="divide-y divide-ink-800">
            {insights.costly_mistakes.map((m, i) => (
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
