import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Board from '../components/Board'
import EvalGraph from '../components/EvalGraph'
import MoveList from '../components/MoveList'
import { StatTile } from '../components/StatsSummary'
import { api } from '../utils/api'
import {
  JUDGMENT_CLASS,
  JUDGMENT_LABEL,
  START_FEN,
  formatEval,
  mergeMoves,
  positionsFromPgn,
} from '../utils/chess'

const PHASE_LABEL = { opening: 'Ouverture', middlegame: 'Milieu', endgame: 'Finale' }
const RESULT_LABEL = { win: 'Victoire', loss: 'Défaite', draw: 'Nulle' }

function NavButton({ children, ...props }) {
  return (
    <button
      type="button"
      className="rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-300 hover:bg-ink-800 disabled:opacity-40"
      {...props}
    >
      {children}
    </button>
  )
}

function MistakeTimeline({ moves, userColor, currentPly, onSelectPly }) {
  const mine = moves.filter((m) => m.judgment && m.color === userColor)
  if (!mine.length) {
    return <p className="px-3 py-4 text-sm text-ink-500">Aucune erreur majeure détectée.</p>
  }
  return (
    <ul className="divide-y divide-ink-800">
      {mine.map((m) => (
        <li key={m.ply}>
          <button
            type="button"
            onClick={() => onSelectPly(m.ply)}
            className={`flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-ink-800 ${
              m.ply === currentPly ? 'bg-ink-800' : ''
            }`}
          >
            <span>
              <span className="font-mono text-ink-500">
                {m.move_number}
                {m.color === 'white' ? '.' : '...'}
              </span>{' '}
              <span className="font-mono text-ink-100">{m.san}</span>{' '}
              <span className={JUDGMENT_CLASS[m.judgment]}>{JUDGMENT_LABEL[m.judgment]}</span>
            </span>
            <span className="shrink-0 font-mono text-xs text-ink-500">
              −{(m.cp_loss / 100).toFixed(2)} · {m.best_move_san}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export default function GameAnalysis() {
  const { gameId } = useParams()
  const [game, setGame] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [ply, setPly] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [showBest, setShowBest] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const g = await api.game(gameId)
      setGame(g)
      if (g.analysis_status === 'done') setAnalysis(await api.analysis(gameId))
    } catch (err) {
      setError(err.message)
    }
  }, [gameId])

  useEffect(() => {
    load()
  }, [load])

  // Poll while Stockfish is still working on this game.
  useEffect(() => {
    if (!game || game.analysis_status === 'done' || game.analysis_status === 'error') return undefined
    const id = setInterval(load, 4000)
    return () => clearInterval(id)
  }, [game, load])

  const moves = useMemo(() => {
    if (!game) return []
    return mergeMoves(positionsFromPgn(game.pgn), analysis?.moves)
  }, [game, analysis])

  const goTo = useCallback(
    (next) => setPly(Math.max(0, Math.min(moves.length, next))),
    [moves.length],
  )

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'ArrowLeft') goTo(ply - 1)
      else if (e.key === 'ArrowRight') goTo(ply + 1)
      else if (e.key === 'ArrowUp') goTo(0)
      else if (e.key === 'ArrowDown') goTo(moves.length)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ply, goTo, moves.length])

  useEffect(() => {
    if (!playing) return undefined
    if (ply >= moves.length) {
      setPlaying(false)
      return undefined
    }
    const id = setTimeout(() => setPly((p) => p + 1), 900)
    return () => clearTimeout(id)
  }, [playing, ply, moves.length])

  if (error) return <p className="text-sm text-blunder">{error}</p>
  if (!game) return <p className="text-sm text-ink-500">Chargement…</p>

  const current = ply > 0 ? moves[ply - 1] : null
  const previous = ply > 1 ? moves[ply - 2] : null
  const userColor = game.user_color
  const orientation = flipped ? (userColor === 'white' ? 'black' : 'white') : userColor

  // "Meilleur coup" rewinds one ply and draws the engine move as an arrow.
  const bestAvailable = Boolean(current?.best_move_uci) && !current?.is_best
  const showingBest = showBest && bestAvailable
  const fen = showingBest
    ? (previous?.fen_after ?? START_FEN)
    : (current?.fen_after ?? START_FEN)
  const lastMove = showingBest ? previous?.uci : current?.uci
  const shapes = showingBest
    ? [
        {
          orig: current.best_move_uci.slice(0, 2),
          dest: current.best_move_uci.slice(2, 4),
          brush: 'green',
        },
      ]
    : []

  const counts = analysis?.judgment_counts?.[userColor] || {}
  const accuracy = userColor === 'white' ? analysis?.accuracy_white : analysis?.accuracy_black
  const acpl = userColor === 'white' ? analysis?.acpl_white : analysis?.acpl_black
  const phases = analysis?.phase_stats?.[userColor] || {}
  const weakest = Object.entries(phases).sort((a, b) => b[1].acpl - a[1].acpl)[0]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">
            {RESULT_LABEL[game.result]} contre {game.opponent_username}
            {game.opponent_rating ? (
              <span className="text-ink-500"> ({game.opponent_rating})</span>
            ) : null}
          </h1>
          <p className="text-sm text-ink-500">
            {new Date(game.played_at).toLocaleString('fr-FR')} · {game.time_class} ·{' '}
            {game.opening || 'ouverture inconnue'}
            {game.termination ? ` · ${game.termination}` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          {game.url && (
            <a
              href={game.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-300 hover:bg-ink-800"
            >
              Voir sur Chess.com
            </a>
          )}
          <button
            type="button"
            onClick={async () => {
              await api.refresh(gameId)
              setAnalysis(null)
              load()
            }}
            className="rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-300 hover:bg-ink-800"
          >
            Ré-analyser
          </button>
          <Link
            to="/"
            className="rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-300 hover:bg-ink-800"
          >
            Retour
          </Link>
        </div>
      </div>

      {game.analysis_status !== 'done' && (
        <p className="rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-300">
          {game.analysis_status === 'error'
            ? `Analyse en échec : ${game.analysis_error}`
            : 'Analyse Stockfish en cours… le graphique apparaîtra automatiquement.'}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-3">
          {/* cap the board so the eval graph and tiles stay above the fold */}
          <div className="mx-auto w-full max-w-[min(52vh,30rem)]">
            <Board fen={fen} orientation={orientation} lastMove={lastMove} shapes={shapes} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <NavButton onClick={() => goTo(0)} disabled={ply === 0}>
              ⏮
            </NavButton>
            <NavButton onClick={() => goTo(ply - 1)} disabled={ply === 0}>
              ◀
            </NavButton>
            <NavButton onClick={() => setPlaying(!playing)} disabled={ply >= moves.length}>
              {playing ? '⏸' : '▶'}
            </NavButton>
            <NavButton onClick={() => goTo(ply + 1)} disabled={ply >= moves.length}>
              ▶
            </NavButton>
            <NavButton onClick={() => goTo(moves.length)} disabled={ply >= moves.length}>
              ⏭
            </NavButton>
            <NavButton onClick={() => setFlipped(!flipped)}>⇅ Retourner</NavButton>
            <NavButton onClick={() => setShowBest(!showBest)} disabled={!bestAvailable}>
              {showingBest ? 'Coup joué' : 'Meilleur coup'}
            </NavButton>
            <span className="ml-auto font-mono text-sm text-ink-300">
              {ply} / {moves.length} · {formatEval(current)}
            </span>
          </div>

          {analysis && (
            <div className="rounded-lg border border-ink-800 bg-ink-900 p-2">
              <EvalGraph moves={moves} currentPly={ply} onSelectPly={setPly} />
            </div>
          )}

          {analysis && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile
                label="Précision"
                value={accuracy != null ? `${accuracy}%` : null}
                hint={acpl != null ? `${acpl} cp / coup` : undefined}
                tone={accuracy >= 85 ? 'good' : accuracy >= 70 ? 'warn' : 'bad'}
              />
              <StatTile label="Imprécisions" value={counts.inaccuracy ?? 0} />
              <StatTile
                label="Erreurs"
                value={counts.mistake ?? 0}
                tone={counts.mistake ? 'warn' : 'good'}
              />
              <StatTile
                label="Gaffes"
                value={counts.blunder ?? 0}
                hint={weakest ? `Phase faible : ${PHASE_LABEL[weakest[0]]}` : undefined}
                tone={counts.blunder ? 'bad' : 'good'}
              />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div className="h-80 rounded-lg border border-ink-800 bg-ink-900">
            <MoveList moves={moves} currentPly={ply} onSelectPly={setPly} />
          </div>
          <div className="rounded-lg border border-ink-800 bg-ink-900">
            <h3 className="border-b border-ink-700 px-3 py-2 text-sm font-medium text-ink-300">
              Vos coups manqués
            </h3>
            <MistakeTimeline
              moves={moves}
              userColor={userColor}
              currentPly={ply}
              onSelectPly={setPly}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
