import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import StatsSummary from '../components/StatsSummary'
import { JUDGMENT_CLASS, JUDGMENT_LABEL } from '../utils/chess'
import { api } from '../utils/api'

const PHASE_LABEL = { opening: 'Ouverture', middlegame: 'Milieu', endgame: 'Finale' }
const axis = { fill: 'var(--color-ink-500)', fontSize: 11 }

function Panel({ title, children, className = '' }) {
  return (
    <section className={`rounded-lg border border-ink-800 bg-ink-900 ${className}`}>
      <h2 className="border-b border-ink-700 px-4 py-2 text-sm font-medium text-ink-300">
        {title}
      </h2>
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
          <th className="px-2 py-2 text-right font-normal">Score</th>
          <th className="px-4 py-2 text-right font-normal">Précision</th>
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
  const [mistakes, setMistakes] = useState(null)
  const [period, setPeriod] = useState('week')
  const [error, setError] = useState(null)

  useEffect(() => {
    Promise.all([api.stats(), api.trends(period, 16), api.mistakes()])
      .then(([s, t, m]) => {
        setStats(s)
        setTrends(t)
        setMistakes(m)
      })
      .catch((err) => setError(err.message))
  }, [period])

  if (error) return <p className="text-sm text-blunder">{error}</p>
  if (!stats) return <p className="text-sm text-ink-500">Chargement…</p>

  const phaseData = Object.entries(stats.phase_acpl).map(([phase, acpl]) => ({
    phase: PHASE_LABEL[phase],
    acpl,
  }))

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Statistiques</h1>

      <StatsSummary stats={stats} />

      <Panel
        title={
          <span className="flex items-center gap-2">
            Évolution <span className="text-ink-500">({period})</span>
          </span>
        }
      >
        <div className="flex gap-2 px-4 pt-3">
          {['day', 'week', 'month'].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`rounded-md px-2.5 py-1 text-xs ${
                p === period ? 'bg-ink-700 text-ink-100' : 'text-ink-500 hover:bg-ink-800'
              }`}
            >
              {{ day: 'Jour', week: 'Semaine', month: 'Mois' }[p]}
            </button>
          ))}
        </div>
        <div className="h-56 p-3">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trends} margin={{ top: 8, right: 12, bottom: 0, left: -20 }}>
              <CartesianGrid stroke="var(--color-ink-700)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="period" tick={axis} stroke="var(--color-ink-700)" minTickGap={20} />
              <YAxis domain={[0, 100]} tick={axis} stroke="var(--color-ink-700)" />
              <Tooltip
                contentStyle={{
                  background: 'var(--color-ink-900)',
                  border: '1px solid var(--color-ink-700)',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <Line
                type="monotone"
                dataKey="avg_accuracy"
                name="Précision"
                stroke="var(--color-accent)"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="win_rate"
                name="Score"
                stroke="var(--color-good)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Pertes moyennes par phase (centipions)">
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
                  contentStyle={{
                    background: 'var(--color-ink-900)',
                    border: '1px solid var(--color-ink-700)',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="acpl" name="cp perdus" fill="var(--color-mistake)" radius={[4, 4, 0, 0]} />
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

      <Panel title="Vos pires coups">
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
