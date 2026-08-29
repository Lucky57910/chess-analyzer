import { BLUNDER_CP, INACCURACY_CP, MISTAKE_CP } from '../engine/scoring.js'
import InfoNote from './ui/Info'

/**
 * One number with its label, its trend and — when it needs one — its
 * definition.
 *
 * The definitions used to be `title` attributes. On the phone this app ships
 * to, a `title` is never shown by anything, so every one of these tiles was
 * carrying a paragraph nobody could read. `note` puts it behind an ⓘ instead.
 */
export function StatTile({ label, value, hint, tone = 'default', note }) {
  const toneClass = {
    default: 'text-text',
    good: 'text-good',
    warn: 'text-inaccuracy',
    bad: 'text-blunder',
  }[tone]

  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="flex items-center gap-0.5">
        <span className="text-label tracking-wide text-faint uppercase">{label}</span>
        {note && <InfoNote label={label.toLowerCase()}>{note}</InfoNote>}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value ?? '—'}</div>
      {/* Wraps rather than truncates: these hints carry the counts the big
          number is an average of, which is the half that makes it mean
          anything. */}
      {hint && <div className="mt-0.5 text-label leading-snug text-faint">{hint}</div>}
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

/**
 * The change against the previous window of the same length.
 *
 * A headline number with nothing beside it cannot answer the only question the
 * tiles are asked, which is whether things are getting better. Direction
 * matters per field: more accuracy is progress, more blunders is not.
 *
 * The arrow is doubled by a word for screen readers, and the colour is never
 * the only thing carrying the meaning.
 */
function Delta({ value, unit = '', goodWhen = 'up' }) {
  if (value === null || value === undefined || value === 0) return null
  const better = goodWhen === 'up' ? value > 0 : value < 0
  const direction = value > 0 ? 'en hausse de' : 'en baisse de'
  return (
    <span
      className={better ? 'text-good' : 'text-blunder'}
      // The arrow is the whole meaning and a screen reader reads it as
      // "black down-pointing triangle". `role="img"` lets one label stand for
      // the glyph and the number together, without splitting the text node
      // the glyph sits in.
      role="img"
      aria-label={`${direction} ${Math.abs(value)}${unit}, ${better ? 'en progrès' : 'en recul'}`}
    >
      {value > 0 ? '▲' : '▼'} {Math.abs(value)}
      {unit}
    </span>
  )
}

function withDelta(hint, delta) {
  if (!delta) return hint
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      {delta}
      {hint && <span>{hint}</span>}
    </span>
  )
}

export default function StatsSummary({ stats, comparison }) {
  if (!stats) return null
  const d = comparison?.deltas ?? {}
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label="Parties" value={stats.games} hint={`${stats.analysed} analysées`} />
      <StatTile
        label="Score"
        value={`${stats.win_rate}%`}
        hint={withDelta(
          `${stats.wins}V · ${stats.draws}N · ${stats.losses}D`,
          <Delta value={d.win_rate} unit=" pts" />,
        )}
        note={SCORE_NOTE}
        tone={stats.win_rate >= 50 ? 'good' : 'default'}
      />
      <StatTile
        label="Précision moy."
        value={stats.avg_accuracy != null ? `${stats.avg_accuracy}%` : null}
        hint={withDelta(
          stats.avg_acpl != null ? `${stats.avg_acpl} cp perdus / coup` : undefined,
          <Delta value={d.avg_accuracy} unit=" pts" />,
        )}
        note={`${ACCURACY_NOTE} ${CP_NOTE}`}
        tone={stats.avg_accuracy >= 85 ? 'good' : stats.avg_accuracy >= 70 ? 'warn' : 'bad'}
      />
      <StatTile
        label="Gaffes / partie"
        value={stats.blunders_per_game}
        note={`${JUDGMENT_NOTE} ${CP_NOTE}`}
        hint={withDelta(
          stats.weakest_phase ? `Phase faible : ${PHASE_LABEL[stats.weakest_phase]}` : undefined,
          <Delta value={d.blunders_per_game} goodWhen="down" />,
        )}
        tone={
          stats.blunders_per_game <= 0.5 ? 'good' : stats.blunders_per_game <= 1.5 ? 'warn' : 'bad'
        }
      />
    </div>
  )
}
