import { BLUNDER_CP, INACCURACY_CP, MISTAKE_CP } from '../engine/scoring.js'

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

/**
 * Score and accuracy are unrelated numbers shown side by side in the same
 * percent format, which reliably reads as "two versions of the same thing".
 * These say which is which, in one sentence each.
 */
export const SCORE_NOTE =
  'Score = (victoires + ½ nulles) ÷ parties. C’est votre résultat contre vos ' +
  'adversaires : il dépend d’eux autant que de vous, et ne dit rien de la qualité ' +
  'de vos coups.'

export const ACCURACY_NOTE =
  'Précision = qualité de vos coups, de 0 à 100, indépendamment du résultat. ' +
  'Modèle Lichess, calculé sur ce que chaque coup a coûté par rapport au meilleur. ' +
  'On peut gagner à 60 % de précision et perdre à 90 %.'

export const CP_NOTE =
  'Le centipion (cp) est l’unité d’évaluation du moteur : 100 cp = 1 pion. ' +
  'Un coup qui perd 100 cp offre l’équivalent d’un pion à l’adversaire.'

/** Read off the thresholds themselves, so the wording cannot drift from them. */
export const JUDGMENT_NOTE =
  `À partir de ${INACCURACY_CP} cp perdus le coup est une imprécision, ` +
  `à partir de ${MISTAKE_CP} cp une erreur, ` +
  `à partir de ${BLUNDER_CP} cp — trois pions — une gaffe.`

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
        title={SCORE_NOTE}
        tone={stats.win_rate >= 50 ? 'good' : 'default'}
      />
      <StatTile
        label="Précision moy."
        value={stats.avg_accuracy != null ? `${stats.avg_accuracy}%` : null}
        hint={stats.avg_acpl != null ? `${stats.avg_acpl} cp perdus / coup` : undefined}
        title={`${ACCURACY_NOTE} ${CP_NOTE}`}
        tone={stats.avg_accuracy >= 85 ? 'good' : stats.avg_accuracy >= 70 ? 'warn' : 'bad'}
      />
      <StatTile
        label="Gaffes / partie"
        value={stats.blunders_per_game}
        title={`${JUDGMENT_NOTE} ${CP_NOTE}`}
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
