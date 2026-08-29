/**
 * What to say about one move.
 *
 * The wording used to live inside GameAnalysis.jsx, next to the JSX that drew
 * it, which meant three things could not happen: the sentences could not be
 * tested without rendering a page, they could not be ranked (the screen
 * printed all of them in detector order, so "la tour prend la colonne e"
 * could sit above "et la dame tombe"), and nothing could hand them to a
 * language model as the facts it is allowed to talk about.
 *
 * This module turns a move plus what the detectors found into one structured
 * message: a verdict, a headline, and the supporting lines. It decides
 * *ranking and wording*; it never decides whether a motif is there.
 *
 * The French lives here rather than in `motifs.js` on purpose, so that module
 * stays testable on facts instead of on phrasing.
 */

import { lineText } from "../engine/refutation.js";
import { JUDGMENT_LABEL } from "../utils/chess.js";

const PIECE_NAME = {
  p: "le pion",
  n: "le cavalier",
  b: "le fou",
  r: "la tour",
  q: "la dame",
  k: "le roi",
};

const PIECE_LIST = (targets) => targets.map((t) => PIECE_NAME[t.type]).join(" et ");

/** The French for a motif found on the board itself. */
export const MOTIF_TEXT = {
  checkmate: () => "Échec et mat.",
  castled: (m) => (m.long ? "Roque du côté dame." : "Roque, le roi est à l’abri."),
  promoted: () => "Promotion.",
  rooksConnected: () => "Ce coup lie les tours : elles se défendent l’une l’autre.",
  rookOpenFile: (m) => `La tour prend la colonne ${m.file}, qui est ouverte.`,
  passedPawn: (m) =>
    `Le pion ${m.square} est passé : plus aucun pion adverse ne peut l’arrêter.`,
  fork: (m) =>
    `Ce coup fait une fourchette : ${PIECE_NAME[m.piece]} attaque ${PIECE_LIST(m.targets)}.`,
  pin: (m) => `Ce coup cloue ${PIECE_NAME[m.pinnedType]} contre ${PIECE_NAME[m.againstType]}.`,
  hangs: (m) =>
    m.moved
      ? `Ce coup pose ${PIECE_NAME[m.victim]} en ${m.square} là où il peut être pris.`
      : `Ce coup laisse ${PIECE_NAME[m.victim]} en prise en ${m.square}.`,
  allowsFork: (m) => `Ce coup permet ${m.san} : une fourchette sur ${PIECE_LIST(m.targets)}.`,
  missedMate: (m) => `Il y avait mat en un avec ${m.san}.`,
};

/** What a motif found inside a variation is, said about that variation. */
export const MOMENT_TEXT = {
  checkmate: () => "et c’est mat",
  fork: (m) => `une fourchette sur ${PIECE_LIST(m.targets)}`,
  pin: (m) => `ce qui cloue ${PIECE_NAME[m.pinnedType]}`,
  hangs: (m) => `et ${PIECE_NAME[m.victim]} tombe`,
  promoted: () => "et le pion passe dame",
  passedPawn: () => "et le pion est passé",
};

export const motifText = (motif) => MOTIF_TEXT[motif?.key]?.(motif) ?? null;
export const momentText = (moment) => (moment ? MOMENT_TEXT[moment.motif.key]?.(moment.motif) : null);

/**
 * How loudly a motif deserves to be read.
 *
 * A screen that prints its detectors in detection order buries the mate under
 * the open file. Higher wins; anything unlisted is 0.
 */
const WEIGHT = {
  checkmate: 100,
  missedMate: 90,
  hangs: 80,
  allowsFork: 75,
  fork: 70,
  pin: 55,
  promoted: 50,
  passedPawn: 35,
  rookOpenFile: 20,
  castled: 15,
  rooksConnected: 10,
};

/** What the move gave away outranks what it achieved, at equal weight. */
const rank = (motif) => (WEIGHT[motif.key] ?? 0) + (motif.side === "opponent" ? 1 : 0);

/** A sentence in the message, with the colour it should be read in. */
const line = (text, tone) => ({ text, tone });

export const TONE = {
  blunder: "blunder",
  mistake: "mistake",
  inaccuracy: "inaccuracy",
  good: "good",
  neutral: "neutral",
};

/**
 * The overall colour of the message.
 *
 * A judged move takes the judgment's colour. An unjudged one is green when it
 * was the engine's own move and neutral otherwise — "not a mistake" is not
 * praise, and colouring every quiet developing move green would make the
 * green mean nothing by move ten.
 */
export function toneFor(move) {
  if (move?.judgment) return move.judgment;
  if (move?.is_best) return TONE.good;
  return TONE.neutral;
}

/** "Gaffe", "Meilleur coup", or nothing. */
export function verdictFor(move) {
  if (move?.judgment) return JUDGMENT_LABEL[move.judgment];
  if (move?.is_best) return "Meilleur coup";
  return null;
}

/**
 * Build the whole message for one ply.
 *
 * @param {object} args
 * @param {object|null} args.move        The merged ply: san, judgment, cp_loss…
 * @param {Array}       args.motifs      What `motifsFor` saw on this position.
 * @param {object}      args.lines       `{ refutation, best }` from refutation.js.
 * @param {string|null} args.aiText      A coach paragraph, when one was generated.
 * @returns {{
 *   tone: string, verdict: string|null, headline: string|null,
 *   details: Array<{text: string, tone: string}>,
 *   cost: number|null, better: string|null, source: 'ai'|'engine'|'none'
 * }}
 */
export function narrate({ move, motifs = [], lines = {}, aiText = null } = {}) {
  const tone = toneFor(move);
  const verdict = verdictFor(move);
  const cost = move?.judgment && move.cp_loss != null ? move.cp_loss : null;
  const better = move?.is_best ? null : (move?.best_move_san ?? null);

  // Every fact the position and the engine give us, strongest first.
  const facts = [...motifs]
    .sort((a, b) => rank(b) - rank(a))
    .map((m) => line(motifText(m), m.side === "opponent" ? TONE.blunder : TONE.neutral))
    .filter((l) => l.text);

  if (lines.refutation) {
    const moment = momentText(lines.refutation.moment);
    facts.push(
      line(
        `L’adversaire enchaîne ${lineText(lines.refutation.steps)}${moment ? ` : ${moment}.` : "."}`,
        TONE.blunder,
      ),
    );
  }
  if (lines.best) {
    const moment = momentText(lines.best.moment);
    facts.push(
      line(
        `Il fallait jouer ${lineText(lines.best.steps)}${moment ? ` : ${moment}.` : "."}`,
        TONE.good,
      ),
    );
  }

  // The coach paragraph leads when there is one, and the engine's facts stay
  // underneath it rather than being replaced: the model writes the advice, the
  // engine keeps the last word on what actually happened.
  if (aiText) {
    return {
      tone,
      verdict,
      headline: aiText,
      details: facts,
      cost,
      better,
      source: "ai",
    };
  }

  if (!facts.length) {
    return { tone, verdict, headline: null, details: [], cost, better, source: "none" };
  }

  const [first, ...rest] = facts;
  return { tone, verdict, headline: first.text, details: rest, cost, better, source: "engine" };
}
