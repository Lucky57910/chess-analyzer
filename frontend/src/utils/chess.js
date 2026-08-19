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

/** Centipawns (White POV) clamped to the +-10 pawn band the graph draws. */
export function evalToPawns(move) {
  if (!move) return 0
  if (move.eval_mate !== null && move.eval_mate !== undefined) {
    return move.eval_mate > 0 ? 10 : -10
  }
  if (move.eval_cp === null || move.eval_cp === undefined) return 0
  return Math.max(-10, Math.min(10, move.eval_cp / 100))
}

export function formatEval(move) {
  if (!move) return '0.00'
  if (move.eval_mate !== null && move.eval_mate !== undefined) {
    return `M${Math.abs(move.eval_mate)}${move.eval_mate < 0 ? ' −' : ''}`.trim()
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
