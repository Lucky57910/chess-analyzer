import { Link } from 'react-router-dom'

const RESULT_STYLE = {
  win: 'bg-good/20 text-good',
  loss: 'bg-blunder/20 text-blunder',
  draw: 'bg-ink-700 text-ink-300',
}

const RESULT_LABEL = { win: 'Victoire', loss: 'Défaite', draw: 'Nulle' }

const STATUS_LABEL = {
  pending: 'En attente',
  running: 'Analyse…',
  error: 'Échec',
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function GameRow({ game }) {
  return (
    <Link
      to={`/games/${game.id}`}
      className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 rounded-lg border border-ink-800 bg-ink-900 px-4 py-3 transition-colors hover:border-ink-700 hover:bg-ink-800 sm:grid-cols-[5.5rem_1fr_auto_auto]"
    >
      <span
        className={`rounded px-2 py-1 text-center text-xs font-medium ${RESULT_STYLE[game.result]}`}
      >
        {RESULT_LABEL[game.result]}
      </span>

      <div className="min-w-0">
        <div className="truncate text-sm text-ink-100">
          <span className="text-ink-500">
            {game.user_color === 'white' ? '□' : '■'} vs{' '}
          </span>
          {game.opponent_username}
          {game.opponent_rating ? (
            <span className="text-ink-500"> ({game.opponent_rating})</span>
          ) : null}
        </div>
        <div className="truncate text-xs text-ink-500">
          {formatDate(game.played_at)} · {game.time_class || '?'}
          {game.opening ? ` · ${game.opening}` : ''}
        </div>
      </div>

      <div className="text-right text-xs text-ink-300">
        {game.analysis_status === 'done' ? (
          <>
            <div className="font-mono text-sm text-ink-100">{game.accuracy?.toFixed(1)}%</div>
            <div className="text-ink-500">
              {game.blunders ?? 0} gaffe{(game.blunders ?? 0) > 1 ? 's' : ''} ·{' '}
              {game.mistakes ?? 0} err.
            </div>
          </>
        ) : (
          <span className="text-ink-500">{STATUS_LABEL[game.analysis_status]}</span>
        )}
      </div>
    </Link>
  )
}

export default function GameList({ games, emptyLabel = 'Aucune partie.' }) {
  if (!games.length) {
    return <p className="rounded-lg border border-dashed border-ink-700 p-6 text-center text-sm text-ink-500">{emptyLabel}</p>
  }
  return (
    <div className="flex flex-col gap-2">
      {games.map((game) => (
        <GameRow key={game.id} game={game} />
      ))}
    </div>
  )
}
