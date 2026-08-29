import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Board from './Board'
import CoachBubble from './CoachBubble'
import EvalBar from './EvalBar'
import Button from './ui/Button'
import {
  applyMove,
  legalDests,
  outcomeOf,
  respondTo,
  turnOf,
} from '../engine/sparring.js'
import { JUDGMENT_CLASS, JUDGMENT_LABEL, formatEval } from '../utils/chess'
import { api } from '../utils/api'

const OUTCOME_TEXT = {
  checkmate: (o, color) => (o.winner === color ? 'Échec et mat, vous gagnez.' : 'Échec et mat, vous perdez.'),
  stalemate: () => 'Pat : partie nulle.',
  material: () => 'Matériel insuffisant : partie nulle.',
  repetition: () => 'Triple répétition : partie nulle.',
  fiftyMoves: () => 'Règle des 50 coups : partie nulle.',
  draw: () => 'Partie nulle.',
}

/**
 * Play the position out against the engine.
 *
 * The analysis says what should have been played. This is the question that
 * follows and that no move list can answer: what happens if you do. You take
 * over at any point of the game and play on, with the same verdict on each of
 * your moves as the analysis gives - it is the same model, so a blunder here
 * would have been a blunder there.
 *
 * Nothing is stored. These are not games you played, and letting them into the
 * archive would put them straight back into the averages the training split
 * exists to keep them out of.
 */
export default function Sparring({ startFen, orientation, color, onExit }) {
  const [fen, setFen] = useState(startFen)
  const [line, setLine] = useState([])
  const [thinking, setThinking] = useState(false)
  const [evaluation, setEvaluation] = useState(null)
  const [hint, setHint] = useState(null)
  const [outcome, setOutcome] = useState(() => outcomeOf(startFen))
  const [error, setError] = useState(null)

  // The evaluation of the position on the board, kept so a full exchange costs
  // two engine calls rather than three.
  const beforeRef = useRef(null)
  const busy = useRef(false)

  useEffect(() => {
    setFen(startFen)
    setLine([])
    setEvaluation(null)
    setHint(null)
    setOutcome(outcomeOf(startFen))
    beforeRef.current = null
  }, [startFen])

  const myTurn = turnOf(fen) === color && !outcome.over && !thinking
  const dests = useMemo(() => (myTurn ? legalDests(fen) : undefined), [fen, myTurn])

  const onMove = useCallback(
    async (from, to) => {
      if (busy.current) return
      const applied = applyMove(fen, from, to)
      if (!applied) return

      busy.current = true
      setThinking(true)
      setHint(null)
      setError(null)
      // Shown immediately: the board must never wait on the engine to display
      // the move that was just made on it.
      setFen(applied.fen)

      try {
        const result = await respondTo({
          evaluate: (position, limit) => api.evaluate(position, limit),
          before: fen,
          after: applied.fen,
          color,
          bestBefore: beforeRef.current,
        })

        setLine((previous) => [
          ...previous,
          { san: applied.move.san, verdict: result.verdict, best: result.best_move_uci },
          ...(result.reply ? [{ san: result.reply.san, reply: true }] : []),
        ])
        setEvaluation(result.evaluation)
        setOutcome(result.outcome)
        beforeRef.current = null
        if (result.reply) setFen(result.reply.fen)
      } catch (err) {
        setError(String(err.message ?? err))
      } finally {
        busy.current = false
        setThinking(false)
      }
    },
    [fen, color],
  )

  const onHint = useCallback(async () => {
    if (busy.current || !myTurn) return
    busy.current = true
    setThinking(true)
    try {
      const result = await api.evaluate(fen)
      beforeRef.current = result
      setHint(result?.best_uci ?? null)
    } catch (err) {
      setError(String(err.message ?? err))
    } finally {
      busy.current = false
      setThinking(false)
    }
  }, [fen, myTurn])

  const shapes = hint
    ? [{ orig: hint.slice(0, 2), dest: hint.slice(2, 4), brush: 'green' }]
    : []

  const last = [...line].reverse().find((entry) => !entry.reply)

  return (
    <div className="flex flex-col gap-3">
      <div className="mx-auto flex w-full max-w-[min(46vh,30rem)] gap-2 lg:max-w-[min(52vh,30rem)]">
        <EvalBar move={{ eval_cp: evaluation?.cp ?? null, eval_mate: evaluation?.mate ?? null }} orientation={orientation} />
        <div className="min-w-0 flex-1">
          <Board
            fen={fen}
            orientation={orientation}
            shapes={shapes}
            dests={dests}
            movableColor={color}
            onMove={onMove}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon="hint" onClick={onHint} disabled={!myTurn}>
          Indice
        </Button>
        <Button size="sm" icon="back" onClick={onExit}>
          Revenir à l’analyse
        </Button>
        <span className="ml-auto font-mono text-body text-muted">
          {formatEval({ eval_cp: evaluation?.cp ?? null, eval_mate: evaluation?.mate ?? null })}
        </span>
      </div>

      <p className="text-body">
        {error ? (
          <span className="text-blunder">{error}</span>
        ) : outcome.over ? (
          <span className="text-text">{OUTCOME_TEXT[outcome.reason]?.(outcome, color)}</span>
        ) : thinking ? (
          <span className="text-faint">L’ordinateur réfléchit…</span>
        ) : myTurn ? (
          <span className="text-faint">À vous de jouer.</span>
        ) : (
          <span className="text-faint">Position à l’adversaire.</span>
        )}
      </p>

      {/* The same coach, in the same bubble, so a verdict during a rally reads
          as the voice that commented the game it came out of. */}
      {last?.verdict && (
        <CoachBubble
          san={last.san}
          message={{
            tone: last.verdict.is_best ? 'good' : (last.verdict.judgment ?? 'neutral'),
            verdict: last.verdict.is_best
              ? 'Meilleur coup'
              : (JUDGMENT_LABEL[last.verdict.judgment] ?? null),
            headline: last.verdict.is_best
              ? 'C’est le coup que le moteur jouait ici.'
              : last.verdict.judgment
                ? `Ce coup coûte ${(last.verdict.cp_loss / 100).toFixed(2)} pion(s).${
                    last.best ? ` Le moteur jouait ${last.best}.` : ''
                  }`
                : 'Coup correct : la position ne bouge pas de façon notable.',
            details: [],
            cost: last.verdict.judgment ? last.verdict.cp_loss : null,
            better: last.verdict.is_best ? null : (last.best ?? null),
          }}
        />
      )}

      {line.length > 0 && (
        <div className="rounded-lg border border-line bg-surface p-3">
          <h3 className="mb-1 text-label uppercase tracking-wide text-faint">Votre partie</h3>
          <p className="font-mono text-body text-muted">
            {line.map((entry, i) => (
              <span key={i} className={entry.reply ? 'text-faint' : JUDGMENT_CLASS[entry.verdict?.judgment] || 'text-text'}>
                {entry.san}{' '}
              </span>
            ))}
          </p>
        </div>
      )}
    </div>
  )
}
