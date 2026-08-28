import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Board from '../components/Board'
import EvalBar from '../components/EvalBar'
import EvalGraph from '../components/EvalGraph'
import MoveList from '../components/MoveList'
import Sparring from '../components/Sparring'
import { StatTile } from '../components/StatsSummary'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useQueue } from '../hooks/useQueue'
import { motifsFor } from '../engine/motifs.js'
import { bestLine, lineText, refutation } from '../engine/refutation.js'
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
const SWIPE_MIN_PX = 30

const ACCURACY_NOTE =
  'Modèle Lichess : moyenne des coups pondérée par la volatilité de la position, ' +
  'mélangée à leur moyenne harmonique. Chess.com utilise CAPS2, qui est propriétaire ' +
  'et analyse plus profondément — quelques points d’écart sont normaux. ' +
  'Le « cp » est le centipion : 100 cp = 1 pion. À 30 cp perdus par coup, vous ' +
  'cédez l’équivalent d’un pion tous les trois coups.'
const RESULT_LABEL = { win: 'Victoire', loss: 'Défaite', draw: 'Nulle' }

const PIECE_NAME = {
  p: 'le pion',
  n: 'le cavalier',
  b: 'le fou',
  r: 'la tour',
  q: 'la dame',
  k: 'le roi',
}

const PIECE_LIST = (targets) =>
  targets
    .map((t) => PIECE_NAME[t.type])
    .join(' et ')
    .replace('le roi', 'le roi')

/**
 * The French for a motif.
 *
 * Kept here rather than in the detector so that module can be tested on facts
 * instead of on wording, and so the wording can change without touching a
 * single thing that decides whether a motif is there at all.
 */
const MOTIF_TEXT = {
  checkmate: () => 'Échec et mat.',
  castled: (m) => (m.long ? 'Roque du côté dame.' : 'Roque, le roi est à l’abri.'),
  promoted: () => 'Promotion.',
  rooksConnected: () => 'Ce coup lie les tours : elles se défendent l’une l’autre.',
  rookOpenFile: (m) => `La tour prend la colonne ${m.file}, qui est ouverte.`,
  passedPawn: (m) => `Le pion ${m.square} est passé : plus aucun pion adverse ne peut l’arrêter.`,
  fork: (m) => `Ce coup fait une fourchette : ${PIECE_NAME[m.piece]} attaque ${PIECE_LIST(m.targets)}.`,
  pin: (m) => `Ce coup cloue ${PIECE_NAME[m.pinnedType]} contre ${PIECE_NAME[m.againstType]}.`,
  hangs: (m) =>
    m.moved
      ? `Ce coup pose ${PIECE_NAME[m.victim]} en ${m.square} là où il peut être pris.`
      : `Ce coup laisse ${PIECE_NAME[m.victim]} en prise en ${m.square}.`,
  allowsFork: (m) =>
    `Ce coup permet ${m.san} : une fourchette sur ${PIECE_LIST(m.targets)}.`,
  missedMate: (m) => `Il y avait mat en un avec ${m.san}.`,
}

/** What a motif found inside a variation is, said about that variation. */
const MOMENT_TEXT = {
  checkmate: () => 'et c’est mat',
  fork: (m) => `une fourchette sur ${PIECE_LIST(m.targets)}`,
  pin: (m) => `ce qui cloue ${PIECE_NAME[m.pinnedType]}`,
  hangs: (m) => `et ${PIECE_NAME[m.victim]} tombe`,
  promoted: () => 'et le pion passe dame',
  passedPawn: () => 'et le pion est passé',
}

const momentText = (moment) => (moment ? MOMENT_TEXT[moment.motif.key]?.(moment.motif) : null)

/** Red for what the move gave away, plain for what it achieved. */
const MOTIF_TONE = { opponent: 'text-blunder', you: 'text-ink-300' }

function NavButton({ children, ...props }) {
  return (
    <button
      type="button"
      className="rounded-md border border-ink-700 px-2.5 py-1 text-sm text-ink-300 hover:bg-ink-800 disabled:opacity-40 sm:px-3 sm:py-1.5"
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
  // The ply the engine move was asked for, not a boolean: a peek belongs to one
  // position. Storing the ply makes "stop showing it when the user moves on"
  // fall out of the comparison instead of needing an effect to undo it.
  const [bestPeekPly, setBestPeekPly] = useState(null)
  const [error, setError] = useState(null)
  const [showGraph, setShowGraph] = useState(false)
  const [sparringFrom, setSparringFrom] = useState(null)
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const { running: queueRunning, stop: stopQueue } = useQueue()
  const touchStart = useRef(null)

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

  // Worked out for the ply on screen and nothing else. It is pure geometry
  // over chess.js, so it costs a few positions rather than an engine call, and
  // it works on games analysed long before this existed - nothing about it is
  // stored.
  const motifs = useMemo(() => {
    const current = ply > 0 ? moves[ply - 1] : null
    if (!current?.move) return []
    try {
      return motifsFor({
        before: current.fen_before,
        after: current.fen_after,
        move: current.move,
      })
    } catch {
      // A motif is a nicety; it must never be the reason a game will not open.
      return []
    }
  }, [moves, ply])

  // The engine's own line, replayed. Present only on judged moves of games
  // analysed since the driver started keeping the variation - everything older
  // simply has none, and the motifs above still stand on their own.
  const lines = useMemo(() => {
    const current = ply > 0 ? moves[ply - 1] : null
    if (!current) return { refutation: null, best: null }
    try {
      return {
        refutation: refutation(current, current.fen_after),
        best: current.is_best ? null : bestLine(current, current.fen_before),
      }
    } catch {
      return { refutation: null, best: null }
    }
  }, [moves, ply])

  const goTo = useCallback(
    (next) => setPly(Math.max(0, Math.min(moves.length, next))),
    [moves.length],
  )

  // Swiping across the board walks the game, so a phone never has to reach for
  // the arrow buttons under it. The `touch-pan-y` on the wrapper is what makes
  // this work on a real device: without it the browser treats a horizontal drag
  // as its own gesture, takes the sequence over and fires touchcancel instead
  // of touchend, so the swipe silently never lands.
  const onTouchStart = useCallback((event) => {
    if (event.touches.length !== 1) return // a pinch, not a swipe
    const touch = event.touches[0]
    touchStart.current = { x: touch.clientX, y: touch.clientY, dx: 0, dy: 0 }
  }, [])

  const onTouchMove = useCallback((event) => {
    const start = touchStart.current
    if (!start || event.touches.length !== 1) return
    start.dx = event.touches[0].clientX - start.x
    start.dy = event.touches[0].clientY - start.y
  }, [])

  const onTouchEnd = useCallback(() => {
    const start = touchStart.current
    touchStart.current = null
    if (!start) return
    if (Math.abs(start.dx) < SWIPE_MIN_PX || Math.abs(start.dx) <= Math.abs(start.dy)) return
    goTo(start.dx < 0 ? ply + 1 : ply - 1)
  }, [goTo, ply])

  const onTouchCancel = useCallback(() => {
    touchStart.current = null
  }, [])

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

  // "Voir le meilleur coup" rewinds one ply and draws the engine move as an
  // arrow. It is a peek, not a mode: walking to another ply drops it, because
  // `bestPeekPly` no longer matches.
  const bestAvailable = Boolean(current?.best_move_uci) && !current?.is_best
  const showingBest = bestPeekPly === ply && bestAvailable
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

  // Our number and Chess.com's come from different models, so show both rather
  // than pretend they should match.
  const accuracyHint = [
    acpl != null ? `${acpl} cp perdus / coup` : null,
    game.chess_com_accuracy != null ? `Chess.com ${game.chess_com_accuracy.toFixed(1)}%` : null,
  ]
    .filter(Boolean)
    .join(' · ')

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
            to="/games"
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

      {/* One column on phones, two on desktop. Explicit grid placement lets the
          mobile order differ from the desktop one without duplicating a block. */}
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        {/* Board first and pinned: scrolling the move list or the mistake
            timeline must never push the position off screen. */}
        <section className="sticky top-0 z-20 order-1 -mx-4 flex flex-col gap-2 border-b border-ink-800 bg-ink-950 px-4 pb-2 lg:static lg:z-auto lg:order-none lg:col-start-1 lg:row-start-1 lg:mx-0 lg:border-0 lg:px-0 lg:pb-0">
          {sparringFrom ? (
            <Sparring
              startFen={sparringFrom}
              orientation={orientation}
              color={userColor}
              onExit={() => setSparringFrom(null)}
            />
          ) : (
          <>
          <div
            className="mx-auto flex w-full max-w-[min(46vh,30rem)] touch-pan-y gap-2 lg:max-w-[min(52vh,30rem)]"
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onTouchCancel={onTouchCancel}
          >
            <EvalBar move={current} orientation={orientation} />
            <div className="min-w-0 flex-1">
              <Board fen={fen} orientation={orientation} lastMove={lastMove} shapes={shapes} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
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
            <NavButton onClick={() => setFlipped(!flipped)}>
              ⇅<span className="hidden sm:inline"> Retourner</span>
            </NavButton>
            <NavButton
              onClick={() => {
                // The engine has one search state and the driver serialises
                // every call, so a rally queued behind a whole game's analysis
                // would wait minutes for its first reply.
                if (queueRunning) stopQueue()
                setSparringFrom(fen)
              }}
              title="Reprenez la position et jouez la suite contre Stockfish."
            >
              ♟<span className="hidden sm:inline"> Jouer d’ici</span>
            </NavButton>
            <NavButton
              onClick={() => setBestPeekPly(showingBest ? null : ply)}
              disabled={!bestAvailable}
              title={
                bestAvailable
                  ? 'Affiche le coup que Stockfish jouait ici. Revient au coup joué dès que vous avancez.'
                  : current?.is_best
                    ? 'Vous avez joué le meilleur coup ici.'
                    : 'Rien à comparer sur cette position.'
              }
            >
              {showingBest ? 'Revenir au coup joué' : 'Voir le meilleur coup'}
            </NavButton>
            <span className="ml-auto font-mono text-sm text-ink-300">
              {ply} / {moves.length} · {formatEval(current)}
            </span>
          </div>

          {/* What the move did, in words. The judgment above says a move was
              bad; this says what about it was. Belongs to the game being
              reviewed, so it goes with the rest of it when the board is handed
              over to a rally. */}
          {(motifs.length > 0 || lines.refutation || lines.best) && (
            <ul className="flex flex-col gap-0.5 text-xs">
              {motifs.map((motif) => (
                <li key={motif.key} className={MOTIF_TONE[motif.side]}>
                  {MOTIF_TEXT[motif.key]?.(motif)}
                </li>
              ))}

              {/* What the engine says happens next. This is the half a
                  position alone cannot give: a piece is not lost on the move
                  that hangs it, it is lost two plies later. */}
              {lines.refutation && (
                <li className="text-blunder">
                  L’adversaire enchaîne {lineText(lines.refutation.steps)}
                  {momentText(lines.refutation.moment)
                    ? ` : ${momentText(lines.refutation.moment)}.`
                    : '.'}
                </li>
              )}
              {lines.best && (
                <li className="text-good">
                  Il fallait jouer {lineText(lines.best.steps)}
                  {momentText(lines.best.moment)
                    ? ` : ${momentText(lines.best.moment)}.`
                    : '.'}
                </li>
              )}
            </ul>
          )}
          </>
          )}
        </section>

        <div className="order-2 h-56 rounded-lg border border-ink-800 bg-ink-900 lg:order-none lg:col-start-2 lg:row-start-1 lg:h-80">
          <MoveList moves={moves} currentPly={ply} onSelectPly={setPly} />
        </div>

        <div className="order-3 rounded-lg border border-ink-800 bg-ink-900 lg:order-none lg:col-start-2 lg:row-start-2 lg:row-span-2">
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

        {analysis && (
          <div className="order-4 grid grid-cols-2 gap-3 lg:order-none lg:col-start-1 lg:row-start-3 lg:grid-cols-4">
            <StatTile
              label="Précision"
              value={accuracy != null ? `${accuracy}%` : null}
              hint={accuracyHint || undefined}
              title={ACCURACY_NOTE}
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

        {/* The eval bar already tracks domination move by move, so on a phone the
            curve is opt-in and sits last instead of stealing the fold. */}
        {analysis && (
          <section className="order-5 flex flex-col gap-2 lg:order-none lg:col-start-1 lg:row-start-2">
            <button
              type="button"
              onClick={() => setShowGraph(!showGraph)}
              className="rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-300 hover:bg-ink-800 lg:hidden"
            >
              {showGraph ? 'Masquer la courbe' : 'Afficher la courbe d’évaluation'}
            </button>
            {(showGraph || isDesktop) && (
              <div className="rounded-lg border border-ink-800 bg-ink-900 p-2">
                <EvalGraph moves={moves} currentPly={ply} onSelectPly={setPly} />
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
