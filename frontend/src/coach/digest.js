/**
 * The facts a language model is allowed to talk about.
 *
 * This is the guard rail of the whole coach feature. A model asked to comment
 * a chess game from a PGN will invent variations, misread whose move it is,
 * and state evaluations it cannot compute — confidently, in good French, which
 * is worse than saying nothing. So it never sees the PGN.
 *
 * It sees this instead, for each of the player's moves:
 *
 *   - what Stockfish evaluated, what the move cost, what it wanted instead;
 *   - what the position detectors saw, and how the opponent punishes it;
 *   - **how long the move took**, off the clock tags Chess.com ships in the
 *     PGN — the one fact here no engine and no model could ever derive, and
 *     the one a coach uses most: a two-second move in a critical position is a
 *     habit, not a chess mistake;
 *   - **what the structure looks like**, from `position.js`: king still on e1
 *     at move fourteen, doubled c-pawns, two minor pieces never developed.
 *
 * The last two exist because of where the residual risk actually is. The model
 * cannot miscalculate — it never calculates. What it can still do is
 * extrapolate: fill a sentence about "your weak king" out of nothing, because
 * a coach's paragraph has a shape and it knows the shape. Every fact added
 * here is one fewer blank for it to fill.
 *
 * Nothing in this module talks to a network. It is a pure transform from a
 * stored game and its analysis to a block of text, which is what makes it
 * testable without a key.
 */

import { moveTimes } from "../data/insights.js";
import { motifsFor } from "../engine/motifs.js";
import { bestLine, lineText, refutation } from "../engine/refutation.js";
import { mergeMoves, positionsFromPgn } from "../utils/chess.js";
import { motifText } from "./narrate.js";
import { positionFacts, repeatedPieceMoves } from "./position.js";

/**
 * Moves per request.
 *
 * The binding limit is output tokens, not input: the digest for a whole game
 * is a few thousand characters, while the answer is a paragraph per move. 24
 * quiet-to-judged comments land near 2,600 tokens against a 4,000 cap, which
 * puts a typical 35-move game in two requests instead of three and a short one
 * in a single request.
 *
 * Raising it further is not free. A chunk is the unit of failure — a truncated
 * or unparseable answer costs every move in it — so the last third of the
 * output budget is deliberately left unused.
 */
export const CHUNK_SIZE = 24;

/** Past this move number, a king still in the centre is worth saying. */
const CASTLE_DEADLINE = 10;

/** Past this one, undeveloped minor pieces are worth saying. */
const DEVELOP_DEADLINE = 8;

const JUDGMENT_FR = {
  inaccuracy: "imprécision",
  mistake: "erreur",
  blunder: "gaffe",
};

const PHASE_FR = { opening: "ouverture", middlegame: "milieu", endgame: "finale" };
const COLOUR_FR = { white: "blancs", black: "noirs" };
const RESULT_FR = { win: "victoire", loss: "défaite", draw: "nulle" };
const PIECE_FR = { n: "cavalier", b: "fou", r: "tour", q: "dame", k: "roi" };
const SIDE_FR = { short: "petit roque", long: "grand roque" };

/** Centipawns as the pawn figure the rest of the app shows. */
function pawns(cp) {
  if (cp === null || cp === undefined) return null;
  const value = cp / 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

/** "2,4 s", "1 min 05 s" — a duration a coach would say out loud. */
export function formatSeconds(seconds) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(Math.round(seconds % 60)).padStart(2, "0")} s`;
}

/** Material as a signed pawn count, or null when it is level. */
const materialText = (balance) =>
  balance === 0 ? null : `matériel ${balance > 0 ? "+" : ""}${balance}`;

/**
 * One line per move, in the player's own colour.
 *
 * The opponent's moves are left out on purpose. They double the size of the
 * request and the player cannot do anything about them; where one matters —
 * because it punishes something — it is already inside the `punition` field of
 * the move it punishes.
 */
export function entriesFor({ game, analysis }) {
  const moves = mergeMoves(positionsFromPgn(game.pgn), analysis?.moves);

  // Seconds per move, off the `[%clk]` tags. Returns [] for a daily game or an
  // untagged PGN, which is why every use of it below is optional.
  let seconds = new Map();
  try {
    seconds = new Map(moveTimes({ ...game, analysis }).map((t) => [t.ply, t.seconds]));
  } catch {
    // A missing or malformed TimeControl is not a reason to lose the digest.
  }

  return moves
    .filter((move) => move.color === game.user_color && move.move)
    .map((move) => {
      let motifs = [];
      let punish = null;
      let better = null;
      let facts = null;
      try {
        motifs = motifsFor({
          before: move.fen_before,
          after: move.fen_after,
          move: move.move,
        })
          .map(motifText)
          .filter(Boolean);
        const reply = refutation(move, move.fen_after);
        if (reply) punish = lineText(reply.steps);
        const best = move.is_best ? null : bestLine(move, move.fen_before);
        if (best) better = lineText(best.steps);
        facts = positionFacts(move.fen_after, game.user_color);
      } catch {
        // A digest is worth having without its motifs. It is never worth
        // failing a whole game's commentary over one unreadable position.
      }

      return {
        ply: move.ply,
        move_number: move.move_number,
        san: move.san,
        phase: move.phase ?? null,
        eval_before: move.eval_cp_before ?? null,
        eval_after: move.eval_cp ?? null,
        cp_loss: move.cp_loss ?? null,
        judgment: move.judgment ?? null,
        is_best: Boolean(move.is_best),
        best_move_san: move.best_move_san ?? null,
        seconds: seconds.get(move.ply) ?? null,
        motifs,
        punish,
        better,
        facts,
      };
    });
}

/**
 * What changed structurally since the player's previous move.
 *
 * Deltas rather than a full state on every line, for two reasons. The obvious
 * one is size — repeating "doubled c-pawns" on twenty consecutive moves is
 * twenty lines of the same fact. The other matters more: a model shown the
 * same sentence twenty times will write about it twenty times. Saying it once,
 * when it happens, is what makes it read as an observation.
 *
 * The absolute state is not lost — `stateOf` puts it at the head of each
 * chunk, so a chunk starting at move 25 still knows where the king is.
 */
export function structuralChanges(entry, previous) {
  const facts = entry.facts;
  if (!facts) return [];
  const before = previous?.facts ?? null;
  const out = [];

  if (before && facts.material !== before.material) {
    out.push(materialText(facts.material) ?? "matériel rétabli");
  }

  const king = facts.king;
  const wasKing = before?.king;
  if (king) {
    if (king.castled && !wasKing?.castled) {
      out.push(`roi mis à l’abri (${SIDE_FR[king.side]})`);
    } else if (
      !king.castled &&
      king.central &&
      entry.move_number >= CASTLE_DEADLINE &&
      // Once, at the move it becomes late, not on every move afterwards.
      (!wasKing || wasKing.central !== king.central || previous?.move_number < CASTLE_DEADLINE)
    ) {
      out.push(`roi toujours au centre en ${king.square}, non roqué, au coup ${entry.move_number}`);
    }
    if (king.castled && wasKing?.castled && king.shield < wasKing.shield) {
      out.push(`bouclier de pions du roi réduit à ${king.shield}`);
    }
  }

  const newDoubled = facts.pawns.doubled.filter((f) => !before?.pawns.doubled.includes(f));
  if (newDoubled.length) out.push(`pions doublés colonne ${newDoubled.join(" et ")}`);

  const newIsolated = facts.pawns.isolated.filter((s) => !before?.pawns.isolated.includes(s));
  if (newIsolated.length) out.push(`pion isolé en ${newIsolated.join(" et ")}`);

  const newPassed = facts.pawns.passed.filter((s) => !before?.pawns.passed.includes(s));
  if (newPassed.length) out.push(`pion passé en ${newPassed.join(" et ")}`);

  if (
    entry.move_number >= DEVELOP_DEADLINE &&
    facts.undeveloped.length >= 2 &&
    (!before || before.undeveloped.length !== facts.undeveloped.length)
  ) {
    out.push(`pièces mineures encore à leur case de départ : ${facts.undeveloped.join(", ")}`);
  }

  return out;
}

/** One entry, as the line the model reads. */
export function formatEntry(entry, previous) {
  const parts = [`ply ${entry.ply} — ${entry.move_number}. ${entry.san}`];

  if (entry.phase) parts.push(PHASE_FR[entry.phase] ?? entry.phase);
  if (entry.eval_before !== null && entry.eval_after !== null) {
    parts.push(`éval ${pawns(entry.eval_before)} → ${pawns(entry.eval_after)}`);
  }
  if (entry.is_best) {
    parts.push("meilleur coup du moteur");
  } else if (entry.judgment) {
    parts.push(`${JUDGMENT_FR[entry.judgment]}, coûte ${entry.cp_loss} cp`);
  } else if (entry.cp_loss) {
    parts.push(`coûte ${entry.cp_loss} cp`);
  }
  if (entry.best_move_san && !entry.is_best) parts.push(`le moteur jouait ${entry.best_move_san}`);
  // Before the tactics: how long it took is often the whole explanation.
  if (entry.seconds !== null) parts.push(`réfléchi ${formatSeconds(entry.seconds)}`);
  if (entry.motifs.length) parts.push(`sur l’échiquier : ${entry.motifs.join(" ")}`);

  const changes = structuralChanges(entry, previous);
  if (changes.length) parts.push(`structure : ${changes.join(" ; ")}`);

  if (entry.better) parts.push(`ligne du moteur : ${entry.better}`);
  if (entry.punish) parts.push(`punition adverse : ${entry.punish}`);

  return parts.join(" | ");
}

/**
 * The structure as it stands at the start of a chunk.
 *
 * Without this, the second request of a game opens on move 25 with no idea
 * that the king never castled — the move that would have said so was in the
 * first request.
 */
export function stateOf(entry) {
  if (!entry?.facts) return null;
  const { material, king, pawns: structure, undeveloped: home } = entry.facts;
  const bits = [
    materialText(material) ?? "matériel égal",
    king
      ? king.castled
        ? `roi en ${king.square} (${SIDE_FR[king.side]}), ${king.shield} pion(s) devant lui`
        : `roi en ${king.square}, non roqué`
      : null,
    structure.doubled.length ? `pions doublés colonne ${structure.doubled.join(", ")}` : null,
    structure.isolated.length ? `pions isolés en ${structure.isolated.join(", ")}` : null,
    structure.passed.length ? `pions passés en ${structure.passed.join(", ")}` : null,
    home.length ? `non développé : ${home.join(", ")}` : null,
  ].filter(Boolean);

  return `État avant le coup ${entry.move_number} : ${bits.join(", ")}.`;
}

/** The two sentences of context every chunk repeats. */
export function headerFor(game) {
  const bits = [
    `Joueur : ${COLOUR_FR[game.user_color]}${game.user_rating ? ` (${game.user_rating})` : ""}`,
    `adversaire ${game.opponent_username}${
      game.opponent_rating ? ` (${game.opponent_rating})` : ""
    }`,
    `cadence ${game.time_class ?? "inconnue"}`,
    game.opening ? `ouverture ${game.opening}` : null,
    `résultat ${RESULT_FR[game.result] ?? game.result}`,
  ].filter(Boolean);
  return bits.join(", ") + ".";
}

/**
 * A fact about the sequence rather than about any position in it.
 *
 * No per-move detector can see this: nothing about the board at move ten says
 * the knight took four moves to get there. It goes in the first chunk, where
 * the opening is.
 */
export function openingHabits(game, analysis) {
  const moves = mergeMoves(positionsFromPgn(game.pgn), analysis?.moves).filter(
    (move) => move.color === game.user_color && move.move,
  );
  const repeated = repeatedPieceMoves(moves);
  if (!repeated.length) return null;
  const said = repeated
    .map((entry) => `${PIECE_FR[entry.type] ?? entry.type} en ${entry.square} (${entry.times} fois)`)
    .join(", ");
  return `Dans l’ouverture, pièces déplacées plus d’une fois : ${said}.`;
}

/** Split into request-sized runs, each carrying the header again. */
export function chunk(entries, size = CHUNK_SIZE) {
  const out = [];
  for (let i = 0; i < entries.length; i += size) out.push(entries.slice(i, i + size));
  return out;
}

/**
 * Everything one request needs: the prompt text and the plies it covers.
 *
 * The ply list comes back with it so the caller can check the answer against
 * what was asked rather than trusting the model to echo the right numbers.
 */
export function buildDigest({ game, analysis, size = CHUNK_SIZE }) {
  const entries = entriesFor({ game, analysis });
  const header = headerFor(game);
  const habits = openingHabits(game, analysis);

  return chunk(entries, size).map((run, index) => {
    const preamble = [
      header,
      // The opening habit belongs with the opening, and repeating it on every
      // chunk would have the model bring it up in the endgame.
      index === 0 ? habits : null,
      stateOf(run[0]),
    ].filter(Boolean);

    const lines = run.map((entry, i) =>
      // The first line of a chunk has no predecessor inside it, so its deltas
      // are measured against the move before — which the state line above
      // already describes, and which is therefore passed in.
      formatEntry(entry, i === 0 ? null : run[i - 1]),
    );

    return {
      plies: run.map((entry) => entry.ply),
      text: `${preamble.join("\n")}\n\nCoups à commenter :\n${lines.join("\n")}`,
    };
  });
}
