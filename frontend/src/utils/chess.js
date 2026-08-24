import { Chess } from 'chess.js'

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

/**
 * Ply list straight from the PGN, so the board is navigable before Stockfish
 * has finished. Eval fields are merged in later by `mergeMoves`.
 */
export function positionsFromPgn(pgn) {
  const chess = new Chess()
  try {
    chess.loadPgn(pgn)
  } catch {
    return []
  }
  return chess.history({ verbose: true }).map((m, i) => ({
    ply: i + 1,
    move_number: Math.floor(i / 2) + 1,
    color: m.color === 'w' ? 'white' : 'black',
    san: m.san,
    uci: m.lan,
    fen_after: m.after,
  }))
}

/** Overlay analysis moves onto the PGN plies, matching on ply number. */
export function mergeMoves(pgnMoves, analysisMoves) {
  if (!analysisMoves?.length) return pgnMoves
  const byPly = new Map(analysisMoves.map((m) => [m.ply, m]))
  return pgnMoves.map((m) => ({ ...m, ...(byPly.get(m.ply) || {}) }))
}

export function hasMate(move) {
  return move?.eval_mate !== null && move?.eval_mate !== undefined
}

/**
 * Which side the mate belongs to, +1 White / -1 Black.
 *
 * A delivered checkmate comes back as `eval_mate === 0` (mate in zero moves),
 * so the sign has to be read off `eval_cp`, which carries +-10000 there.
 */
function mateSide(move) {
  if (move.eval_mate > 0) return 1
  if (move.eval_mate < 0) return -1
  return (move.eval_cp ?? 0) >= 0 ? 1 : -1
}

/** Centipawns (White POV) clamped to the +-10 pawn band the graph draws. */
export function evalToPawns(move) {
  if (!move) return 0
  if (hasMate(move)) return mateSide(move) * 10
  if (move.eval_cp === null || move.eval_cp === undefined) return 0
  return Math.max(-10, Math.min(10, move.eval_cp / 100))
}

export function formatEval(move) {
  if (!move) return '0.00'
  if (hasMate(move)) {
    const sign = mateSide(move) > 0 ? '+' : '−'
    return move.eval_mate === 0 ? `${sign}#` : `${sign}M${Math.abs(move.eval_mate)}`
  }
  if (move.eval_cp === null || move.eval_cp === undefined) return '0.00'
  const pawns = move.eval_cp / 100
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`
}

export const JUDGMENT_LABEL = {
  inaccuracy: 'Imprécision',
  mistake: 'Erreur',
  blunder: 'Gaffe',
}

export const JUDGMENT_COLOR = {
  inaccuracy: 'var(--color-inaccuracy)',
  mistake: 'var(--color-mistake)',
  blunder: 'var(--color-blunder)',
}

export const JUDGMENT_CLASS = {
  inaccuracy: 'text-inaccuracy',
  mistake: 'text-mistake',
  blunder: 'text-blunder',
}

/**
 * Lichess win-probability model, White point of view, 0-100.
 * Mirrors `win_percent_white` in the backend engine so the bar and the
 * accuracy numbers speak the same language.
 */
export function winPercentWhite(move) {
  if (!move) return 50
  if (hasMate(move)) return mateSide(move) > 0 ? 100 : 0
  if (move.eval_cp === null || move.eval_cp === undefined) return 50
  const cp = Math.max(-1000, Math.min(1000, move.eval_cp))
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)
}
