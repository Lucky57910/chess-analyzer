import { Link } from 'react-router-dom'
import Badge from './ui/Badge'

const RESULT_TONE = { win: 'good', loss: 'bad', draw: 'neutral' }
const RESULT_LABEL = { win: 'Victoire', loss: 'Défaite', draw: 'Nulle' }

const STATUS_LABEL = {
  pending: 'En attente',
  running: 'Analyse…',
  error: 'Échec',
}

const TIME_CLASS_LABEL = {
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapide',
  daily: 'Par jour',
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * One game.
 *
 * Both text lines used to be `truncate`, on a grid whose middle column was the
 * only flexible one. On a 375px screen that meant the opening name — the thing
 * you scan this list for — was reliably rendered as "Sicilian Defense: Naj…",
 * and a long opponent name ate its own rating. They wrap now: a row is
 * occasionally three lines tall, which costs a little scrolling and returns
 * every word.
 *
 * Chess.com's own accuracy was drawn as "/ 58.1" behind a `title` explaining
 * what the slash meant — a tooltip on a device with no pointer. It is labelled
 * on its own line instead.
 */
function GameRow({ game }) {
  const analysed = game.analysis_status === 'done'
  return (
    <Link
      to={`/games/${game.id}`}
      className="grid grid-cols-[auto_1fr_auto] items-start gap-x-3 gap-y-1 rounded-xl border border-line bg-surface px-3 py-3 transition-colors hover:border-line-strong hover:bg-raised sm:px-4"
    >
      <Badge tone={RESULT_TONE[game.result]} className="mt-0.5">
        {RESULT_LABEL[game.result]}
      </Badge>

      <div className="min-w-0">
        <div className="text-body leading-snug text-text">
          <span className="text-faint" aria-hidden="true">
            {game.user_color === 'white' ? '□' : '■'}{' '}
          </span>
          <span className="sr-only">
            {game.user_color === 'white' ? 'avec les blancs' : 'avec les noirs'},{' '}
          </span>
          <span className="text-faint">contre </span>
          {game.opponent_username}
          {game.opponent_rating ? <span className="text-faint"> ({game.opponent_rating})</span> : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-label leading-snug text-faint">
          {game.game_kind === 'training' && <Badge>Entraînement</Badge>}
          <span>{formatDate(game.played_at)}</span>
          <span aria-hidden="true">·</span>
          <span>{TIME_CLASS_LABEL[game.time_class] ?? game.time_class ?? 'cadence inconnue'}</span>
          {game.opening && (
            <>
              <span aria-hidden="true">·</span>
              <span>{game.opening}</span>
            </>
          )}
        </div>
      </div>

      <div className="text-right text-label text-faint">
        {analysed ? (
          <>
            <div className="font-mono text-lead text-text tabular-nums">
              {game.accuracy?.toFixed(1)}%
            </div>
            <div className="leading-snug">
              {game.blunders ?? 0} gaffe{(game.blunders ?? 0) > 1 ? 's' : ''}
              {' · '}
              {game.mistakes ?? 0} erreur{(game.mistakes ?? 0) > 1 ? 's' : ''}
            </div>
            {game.chess_com_accuracy != null && (
              <div className="leading-snug">Chess.com {game.chess_com_accuracy.toFixed(1)}%</div>
            )}
          </>
        ) : (
          <span>{STATUS_LABEL[game.analysis_status]}</span>
        )}
      </div>
    </Link>
  )
}

export default function GameList({ games, emptyLabel = 'Aucune partie.' }) {
  if (!games.length) {
    return (
      <p className="rounded-xl border border-dashed border-line-strong p-6 text-center text-body text-faint">
        {emptyLabel}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {games.map((game) => (
        <GameRow key={game.id} game={game} />
      ))}
    </div>
  )
}
