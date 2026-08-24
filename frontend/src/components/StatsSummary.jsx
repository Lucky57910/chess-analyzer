export function StatTile({ label, value, hint, tone = 'default', title }) {
  const toneClass = {
    default: 'text-ink-100',
    good: 'text-good',
    warn: 'text-inaccuracy',
    bad: 'text-blunder',
  }[tone]

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900 px-4 py-3" title={title}>
      <div className="text-xs uppercase tracking-wide text-ink-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>
        {value ?? '—'}
      </div>
      {hint && <div className="mt-0.5 text-xs text-ink-500">{hint}</div>}
    </div>
  )
}

const PHASE_LABEL = { opening: 'Ouverture', middlegame: 'Milieu de partie', endgame: 'Finale' }

export default function StatsSummary({ stats }) {
  if (!stats) return null
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        label="Parties"
        value={stats.games}
        hint={`${stats.analysed} analysées`}
      />
      <StatTile
        label="Score"
        value={`${stats.win_rate}%`}
        hint={`${stats.wins}V · ${stats.draws}N · ${stats.losses}D`}
        tone={stats.win_rate >= 50 ? 'good' : 'default'}
      />
      <StatTile
        label="Précision moy."
        value={stats.avg_accuracy != null ? `${stats.avg_accuracy}%` : null}
        hint={stats.avg_acpl != null ? `${stats.avg_acpl} cp perdus / coup` : undefined}
        tone={stats.avg_accuracy >= 85 ? 'good' : stats.avg_accuracy >= 70 ? 'warn' : 'bad'}
      />
      <StatTile
        label="Gaffes / partie"
        value={stats.blunders_per_game}
        hint={
          stats.weakest_phase
            ? `Phase faible : ${PHASE_LABEL[stats.weakest_phase]}`
            : undefined
        }
        tone={stats.blunders_per_game <= 0.5 ? 'good' : stats.blunders_per_game <= 1.5 ? 'warn' : 'bad'}
      />
    </div>
  )
}
