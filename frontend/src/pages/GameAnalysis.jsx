import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import Board from '../components/Board'
import CoachBubble from '../components/CoachBubble'
import EvalBar from '../components/EvalBar'
import EvalGraph from '../components/EvalGraph'
import Icon from '../components/Icon'
import MoveList from '../components/MoveList'
import Sparring from '../components/Sparring'
import { StatTile } from '../components/StatsSummary'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import Segmented from '../components/ui/Segmented'
import { narrate } from '../coach/narrate.js'
import { PROVIDERS } from '../coach/providers.js'
import { useSettings } from '../hooks/useSettings'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useQueue } from '../hooks/useQueue'
import { motifsFor } from '../engine/motifs.js'
import { bestLine, refutation } from '../engine/refutation.js'
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
const RESULT_TONE = { win: 'good', loss: 'bad', draw: 'neutral' }

/** "1 coup commenté", "7 coups commentés". */
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`

/**
 * What a run cost somewhere that charges, or nothing at all.
 *
 * The free tier is the default and the paid one only ever stands in for it, so
 * the ordinary run says nothing. When it did stand in, saying so with the
 * count is the difference between a bill and a surprise.
 */
function paidWork(providers) {
  const billed = Object.entries(providers ?? {}).filter(
    ([key, chunks]) => chunks > 0 && PROVIDERS[key] && !PROVIDERS[key].free,
  )
  if (!billed.length) return null
  return billed
    .map(([key, chunks]) => `${plural(chunks, 'lot rédigé', 'lots rédigés')} par ${PROVIDERS[key].label} (payant)`)
    .join(', ')
}

/** The two lists beside the board, as one panel with two tabs. */
const TABS = [
  { key: 'moves', label: 'Coups' },
  { key: 'mistakes', label: 'Vos coups manqués' },
]

function MistakeTimeline({ moves, userColor, currentPly, onSelectPly }) {
  const mine = moves.filter((m) => m.judgment && m.color === userColor)
  if (!mine.length) {
    return <p className="px-4 py-6 text-body text-faint">Aucune erreur majeure détectée.</p>
  }
  return (
    <ul className="divide-y divide-line">
      {mine.map((m) => (
        <li key={m.ply}>
          <button
            type="button"
            onClick={() => onSelectPly(m.ply)}
            className={`flex min-h-11 w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2 text-left text-body transition-colors hover:bg-raised ${
              m.ply === currentPly ? 'bg-raised' : ''
            }`}
          >
            <span>
              <span className="font-mono text-faint">
                {m.move_number}
                {m.color === 'white' ? '.' : '…'}
              </span>{' '}
              <span className="font-mono text-text">{m.san}</span>{' '}
              <span className={JUDGMENT_CLASS[m.judgment]}>{JUDGMENT_LABEL[m.judgment]}</span>
            </span>
            {/* Wraps onto its own line on a narrow screen rather than being
                cut: "mieux : Cf3" is the half that says what to do instead. */}
            <span className="font-mono text-label text-faint">
              −{(m.cp_loss / 100).toFixed(2)} · mieux : {m.best_move_san}
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
  const [tab, setTab] = useState('moves')
  const [showGraph, setShowGraph] = useState(false)
  const [sparringFrom, setSparringFrom] = useState(null)
  // The coach's own state. `coachNotes` shadows what the analysis carried so a
  // freshly generated commentary appears without reloading the game.
  const [coachNotes, setCoachNotes] = useState(null)
  const [coachBusy, setCoachBusy] = useState(false)
  const [coachStatus, setCoachStatus] = useState(null)
  // A job handed to the service. The screen is no longer doing the work, so
  // the only way it learns the work is done is by asking.
  const [coachWaiting, setCoachWaiting] = useState(false)
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const { settings: appSettings } = useSettings()
  const { running: queueRunning, stop: stopQueue } = useQueue()
  const touchStart = useRef(null)

  const load = useCallback(async () => {
    try {
      // Anything the background coach finished while this screen was closed is
      // merged before the analysis is read, or the notes would appear only on
      // the second visit.
      await api.collectCoachResults().catch(() => {})
      const g = await api.game(gameId)
      setGame(g)
      if (g.analysis_status === 'done') {
        const found = await api.analysis(gameId)
        setAnalysis(found)
        setCoachNotes(found.coach ?? {})
      }
    } catch (err) {
      setError(err.message)
    }
  }, [gameId])

  useEffect(() => {
    load()
  }, [load])

  /**
   * Wait for a commentary being written somewhere else.
   *
   * The notification covers the case where the app was closed. This covers the
   * other one: staying on the screen while the service works, where nothing
   * would otherwise arrive until the page was left and opened again.
   */
  useEffect(() => {
    if (!coachWaiting) return undefined
    const id = setInterval(async () => {
      const { games } = await api.collectCoachResults().catch(() => ({ games: [] }))
      if (!games.some((entry) => String(entry.gameId) === String(gameId))) return
      setCoachWaiting(false)
      setCoachStatus(null)
      load()
    }, 5000)
    return () => clearInterval(id)
  }, [coachWaiting, gameId, load])

  // Poll while Stockfish is still working on this game.
  useEffect(() => {
    if (!game || game.analysis_status === 'done' || game.analysis_status === 'error')
      return undefined
    const id = setInterval(load, 4000)
    return () => clearInterval(id)
  }, [game, load])

  const moves = useMemo(() => {
    if (!game) return []
    return mergeMoves(positionsFromPgn(game.pgn), analysis?.moves)
  }, [game, analysis])

  /**
   * What has already been worked out, per ply.
   *
   * The detectors are pure geometry over chess.js - no engine call - but they
   * are not cheap: one `motifsFor` walks every legal move for the mate check
   * and costs about 12 ms here, and a single ply needs one for the board plus
   * one per replayed step of both engine lines. Stepping back and forth over
   * the same three moves, which is exactly how this screen is used, paid that
   * again every time.
   *
   * Keyed on `moves`, so the analysis arriving mid-poll throws the cache away
   * rather than serving results computed from the unanalysed plies.
   */
  const cache = useMemo(() => new Map(), [moves])

  // Worked out for the ply on screen and nothing else. It works on games
  // analysed long before this existed - nothing about it is stored.
  const motifs = useMemo(() => {
    const current = ply > 0 ? moves[ply - 1] : null
    if (!current?.move) return []
    const key = `motifs:${ply}`
    if (cache.has(key)) return cache.get(key)
    let found = []
    try {
      found = motifsFor({
        before: current.fen_before,
        after: current.fen_after,
        move: current.move,
      })
    } catch {
      // A motif is a nicety; it must never be the reason a game will not open.
      found = []
    }
    cache.set(key, found)
    return found
  }, [cache, moves, ply])

  // The engine's own line, replayed. Present only on judged moves of games
  // analysed since the driver started keeping the variation - everything older
  // simply has none, and the motifs above still stand on their own.
  const lines = useMemo(() => {
    const current = ply > 0 ? moves[ply - 1] : null
    if (!current) return { refutation: null, best: null }
    const key = `lines:${ply}`
    if (cache.has(key)) return cache.get(key)
    let found = { refutation: null, best: null }
    try {
      found = {
        refutation: refutation(current, current.fen_after),
        best: current.is_best ? null : bestLine(current, current.fen_before),
      }
    } catch {
      found = { refutation: null, best: null }
    }
    cache.set(key, found)
    return found
  }, [cache, moves, ply])

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

  if (error) return <p className="text-body text-blunder">{error}</p>
  if (!game) return <p className="text-body text-faint">Chargement…</p>

  const current = ply > 0 ? moves[ply - 1] : null
  const previous = ply > 1 ? moves[ply - 2] : null
  const userColor = game.user_color
  const orientation = flipped ? (userColor === 'white' ? 'black' : 'white') : userColor

  // "Voir le meilleur coup" rewinds one ply and draws the engine move as an
  // arrow. It is a peek, not a mode: walking to another ply drops it, because
  // `bestPeekPly` no longer matches.
  const bestAvailable = Boolean(current?.best_move_uci) && !current?.is_best
  const showingBest = bestPeekPly === ply && bestAvailable
  const fen = showingBest ? (previous?.fen_after ?? START_FEN) : (current?.fen_after ?? START_FEN)
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

  // What the coach says about the ply on screen. Everything it needs was
  // already computed above; this only ranks and words it. A generated
  // paragraph leads when there is one for this ply, with the engine's own
  // sentences kept underneath it rather than replaced.
  const aiText = current ? (coachNotes?.[current.ply] ?? null) : null
  const message = current ? narrate({ move: current, motifs, lines, aiText }) : null

  const coachReady = Boolean(appSettings?.coach?.key_set)
  const commentedPlies = Object.keys(coachNotes ?? {}).length
  // Moves of the user's own that carry no comment yet. A run that half failed
  // leaves some, and finishing those is a different action from paying for the
  // whole game again - so the button says which one it is.
  const missing = moves.filter(
    (move) => move.color === userColor && move.move && !coachNotes?.[move.ply],
  ).length
  const resume = missing > 0

  /**
   * Hand the game to the coach — to the service when there is one.
   *
   * The background path is preferred wherever it exists, because it is the
   * only one that survives the phone going in a pocket: Android freezes a
   * backgrounded WebView, so the in-app loop below stops the moment the app
   * does. In a browser, and in the tests, there is no service and the loop is
   * still the whole feature.
   */
  async function askCoach() {
    setCoachBusy(true)
    setCoachStatus(null)
    try {
      const { available, needsPermission } = await api.coachRunner()
      if (available) {
        // Denied, the service still runs and finishes; it simply cannot say
        // so, which is the reason to run it there at all.
        if (needsPermission) await api.requestCoachNotifications().catch(() => {})
        const started = await api.coachGameBackground(gameId, { resume })
        setCoachWaiting(true)
        setCoachStatus(
          `Le coach écrit en arrière-plan (${started.chunks} lot(s)). ` +
            'Vous pouvez quitter l’application : une notification préviendra quand c’est prêt.',
        )
        return
      }
      const result = await api.coachGame(gameId, {
        resume,
        onProgress: (done, total) => setCoachStatus(`Rédaction… ${done}/${total}`),
        // A pause with no explanation reads as a frozen button, and this one
        // can last half a minute.
        onWait: (seconds) => setCoachStatus(`Limite du modèle atteinte, reprise dans ${seconds} s…`),
        // Switching provider mid-commentary is invisible in the result - the
        // facts and the validation are the same - so it is said here, once, or
        // a quota spent somewhere else is spent silently.
        onFallback: (label) => setCoachStatus(`Fournisseur indisponible, on passe à ${label}…`),
      })
      setCoachNotes(result.notes)
      // The total, not just what this run added: a second run over a partly
      // commented game adds two and the bubble then shows seven, and a status
      // line saying "2" reads as the coverage rather than as the delta.
      const total = Object.keys(result.notes).length
      setCoachStatus(
        [
          `${plural(total, 'coup commenté', 'coups commentés')} sur la partie`,
          result.failed ? `${result.failed} lot(s) en échec` : null,
          // A paid provider that stood in for the free one has to be named
          // with the count, because that is the part that costs money.
          paidWork(result.providers),
        ]
          .filter(Boolean)
          .join(', ') + '.',
      )
    } catch (err) {
      setCoachStatus(err.message)
    } finally {
      setCoachBusy(false)
    }
  }

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
      {/* The header is two lines and a row of icon actions. It used to be two
          lines and three labelled buttons, which on a 375px screen spent a
          third of the fold on navigation. */}
      <div className="flex items-start gap-2">
        <Button
          to="/games"
          size="icon"
          variant="ghost"
          icon="back"
          aria-label="Retour à la liste des parties"
          className="-ml-2 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2 text-lead font-semibold">
            <Badge tone={RESULT_TONE[game.result]}>{RESULT_LABEL[game.result]}</Badge>
            <span className="text-text">
              contre {game.opponent_username}
              {game.opponent_rating ? (
                <span className="text-faint"> ({game.opponent_rating})</span>
              ) : null}
            </span>
          </h1>
          {/* Wraps. This line carries the opening name, which is the piece of
              it worth reading and the first thing an ellipsis would eat. */}
          <p className="mt-0.5 text-label leading-snug text-faint">
            {new Date(game.played_at).toLocaleString('fr-FR')} · {game.time_class} ·{' '}
            {game.opening || 'ouverture inconnue'}
            {game.termination ? ` · ${game.termination}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {game.url && (
            <Button
              href={game.url}
              size="icon"
              variant="ghost"
              icon="external"
              aria-label="Voir la partie sur Chess.com"
            />
          )}
          <Button
            size="icon"
            variant="ghost"
            icon="refresh"
            aria-label="Ré-analyser la partie"
            onClick={async () => {
              await api.refresh(gameId)
              setAnalysis(null)
              // The commentary goes with it. `saveAnalysis` clears the stored
              // one because the judgments it describes are about to change,
              // and `load` will not overwrite this state until the new
              // analysis is done - so without this the old paragraphs stay on
              // screen, describing a verdict that no longer exists, for as
              // long as the queue takes.
              setCoachNotes(null)
              setCoachStatus(null)
              load()
            }}
          />
        </div>
      </div>

      {game.analysis_status !== 'done' && (
        <p
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-body ${
            game.analysis_status === 'error'
              ? 'border-blunder/40 bg-blunder/10 text-blunder'
              : 'border-line-strong bg-surface text-muted'
          }`}
        >
          <Icon
            name={game.analysis_status === 'error' ? 'warning' : 'coach'}
            size={16}
            className="mt-0.5"
          />
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
        <section className="sticky top-[calc(3.5rem+env(safe-area-inset-top,0px))] z-20 order-1 -mx-4 flex flex-col gap-2 border-b border-line bg-canvas px-4 pb-2 lg:static lg:z-auto lg:order-none lg:col-start-1 lg:row-start-1 lg:mx-0 lg:border-0 lg:px-0 lg:pb-0">
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
                className="mx-auto flex w-full max-w-[min(42vh,30rem)] touch-pan-y gap-2 lg:max-w-[min(52vh,30rem)]"
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

              {/* Walking the game is one fixed row of icons the thumb learns.
                  The two controls whose labels change sit on their own row, so
                  they cannot shuffle the arrows out from under it. */}
              <div className="flex items-center gap-0.5">
                <Button
                  size="icon"
                  variant="ghost"
                  icon="first"
                  aria-label="Début de la partie"
                  onClick={() => goTo(0)}
                  disabled={ply === 0}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  icon="previous"
                  aria-label="Coup précédent"
                  onClick={() => goTo(ply - 1)}
                  disabled={ply === 0}
                />
                <Button
                  size="icon"
                  variant="secondary"
                  icon={playing ? 'pause' : 'play'}
                  aria-label={playing ? 'Mettre la lecture en pause' : 'Dérouler la partie'}
                  onClick={() => setPlaying(!playing)}
                  disabled={ply >= moves.length}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  icon="next"
                  aria-label="Coup suivant"
                  onClick={() => goTo(ply + 1)}
                  disabled={ply >= moves.length}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  icon="last"
                  aria-label="Fin de la partie"
                  onClick={() => goTo(moves.length)}
                  disabled={ply >= moves.length}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  icon="flip"
                  aria-label="Retourner l’échiquier"
                  onClick={() => setFlipped(!flipped)}
                />
                <span className="ml-auto font-mono text-body text-muted tabular-nums">
                  {ply} / {moves.length} · {formatEval(current)}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  icon="hint"
                  onClick={() => setBestPeekPly(showingBest ? null : ply)}
                  disabled={!bestAvailable}
                >
                  {showingBest ? 'Revenir au coup joué' : 'Voir le meilleur coup'}
                </Button>
                <Button
                  size="sm"
                  icon="spar"
                  aria-label="Jouer d’ici contre Stockfish"
                  onClick={() => {
                    // The engine has one search state and the driver serialises
                    // every call, so a rally queued behind a whole game's
                    // analysis would wait minutes for its first reply.
                    if (queueRunning) stopQueue()
                    setSparringFrom(fen)
                  }}
                >
                  Jouer d’ici
                </Button>
                {/* This used to be a `title`, which on a phone is nothing at
                    all: the button was simply dead with no reason given. */}
                {!bestAvailable && current && (
                  <span className="text-label text-faint">
                    {current.is_best
                      ? 'Vous avez joué le meilleur coup ici.'
                      : 'Rien à comparer sur cette position.'}
                  </span>
                )}
              </div>
            </>
          )}
        </section>

        {/* What the move did, in words — and the reason this screen exists.
            Directly under the board, at reading size, with the verdict on it.
            The coach's controls sit under the bubble rather than inside it, so
            they are reachable from the starting position too. */}
        {!sparringFrom && (
          <div className="order-2 flex flex-col gap-2 lg:order-none lg:col-start-1 lg:row-start-2">
            {current && (
              <CoachBubble
                message={message}
                san={current.san}
                moveNumber={current.move_number}
                color={current.color}
                pending={coachBusy && !aiText}
              />
            )}

            {analysis && (
              <div className="flex flex-wrap items-center gap-2 sm:pl-12">
                {/* The generated commentary is bought with a daily quota and
                    stored once, so this is a button rather than something that
                    fires on opening a game. */}
                {coachReady ? (
                  <Button
                    size="sm"
                    variant={commentedPlies ? 'ghost' : 'primary'}
                    icon="coach"
                    onClick={askCoach}
                    disabled={coachBusy}
                  >
                    {coachBusy
                      ? 'Le coach écrit…'
                      : !commentedPlies
                        ? 'Faire commenter par le coach'
                        : resume
                          ? `Compléter (${missing} coup${missing > 1 ? 's' : ''} sans commentaire)`
                          : 'Refaire commenter la partie'}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" icon="coach" to="/settings">
                    Activer le coach IA
                  </Button>
                )}
                {commentedPlies > 0 && !coachBusy && !coachStatus && (
                  <span className="text-label text-faint">
                    {plural(commentedPlies, 'coup commenté', 'coups commentés')} par le coach.
                  </span>
                )}
                {coachStatus && (
                  <span className="text-label text-faint" role="status">
                    {coachStatus}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* The move list and the mistake list were two stacked panels, which on
            a phone is two scroll areas fighting the page for the same thumb.
            One panel with two tabs: nothing is gone, half the height. */}
        <Card className="order-3 overflow-hidden lg:order-none lg:col-start-2 lg:row-start-1 lg:row-span-4">
          <div className="border-b border-line-strong p-2">
            <Segmented
              label="Ce qui est listé à côté de l’échiquier"
              value={tab}
              options={TABS}
              onChange={setTab}
              block
            />
          </div>
          <div className="h-64 overflow-y-auto lg:h-[30rem]">
            {tab === 'moves' ? (
              <MoveList moves={moves} currentPly={ply} onSelectPly={setPly} />
            ) : (
              <MistakeTimeline
                moves={moves}
                userColor={userColor}
                currentPly={ply}
                onSelectPly={setPly}
              />
            )}
          </div>
        </Card>

        {analysis && (
          <div className="order-4 grid grid-cols-2 gap-3 lg:order-none lg:col-start-1 lg:row-start-3 lg:grid-cols-4">
            <StatTile
              label="Précision"
              value={accuracy != null ? `${accuracy}%` : null}
              hint={accuracyHint || undefined}
              note={ACCURACY_NOTE}
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
          <section className="order-5 flex flex-col gap-2 lg:order-none lg:col-start-1 lg:row-start-4">
            <Button
              size="sm"
              variant="ghost"
              icon={showGraph ? 'chevronUp' : 'chevronDown'}
              onClick={() => setShowGraph(!showGraph)}
              aria-expanded={showGraph}
              className="self-start lg:hidden"
            >
              {showGraph ? 'Masquer la courbe' : 'Afficher la courbe d’évaluation'}
            </Button>
            {(showGraph || isDesktop) && (
              <Card className="p-2">
                <EvalGraph moves={moves} currentPly={ply} onSelectPly={setPly} />
              </Card>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
