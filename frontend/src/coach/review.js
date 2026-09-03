/**
 * The archive, as facts a coach is allowed to talk about.
 *
 * `digest.js` does this for one game and this does it for all of them, for the
 * same reason and with the same rule: the model never sees a game. It sees
 * numbers that were computed here, each one carrying a key, and it may not say
 * anything it cannot attach a key to.
 *
 * That rule is what makes the difference between a coach and a horoscope. A
 * language model handed "tu joues aux échecs, dis-moi mes défauts" will write
 * three confident paragraphs about your king safety and your time trouble,
 * because those paragraphs have a shape it knows — and it will be right often
 * enough to be believed and wrong often enough to be useless. Every claim here
 * has to point at a row of `stats.js` or `insights.js`, and `validateReview`
 * drops the ones that point nowhere.
 *
 * Two other things it must not do, both enforced here rather than asked for in
 * the prompt:
 *
 *   - **speak from a sample that cannot carry it.** Twelve games of an opening
 *     is not a repertoire problem, it is twelve games. Facts below their
 *     minimum are never sent, so there is nothing to over-read. This is the
 *     same reasoning as `MIN_RATE_MOVES` in `stats.js`, applied to a different
 *     denominator.
 *   - **need a commentary to exist.** The review reads the *engine's*
 *     analysis, not the coach's prose: a player who has never spent a token on
 *     per-move commentary gets exactly the same review as one who has.
 *
 * Nothing in this module talks to a network.
 */

import { motifsFor } from "../engine/motifs.js";
import { mergeMoves, positionsFromPgn } from "../utils/chess.js";
import { PIECE_LABEL, openingExit } from "../data/insights.js";
import { computeStats } from "../data/stats.js";

/** Below this many analysed games there is nothing worth asking about. */
export const MIN_GAMES = 10;

/*
 * Denominators. Each one is the point below which the number stops being a
 * statement about the player and starts being a statement about the sample.
 */
export const MIN_PIECE_MOVES = 40;
export const MIN_CLOCK_MOVES = 40;
export const MIN_BAND_GAMES = 5;
export const MIN_OPENING_GAMES = 3;
export const MIN_TILT_GAMES = 5;
export const MIN_THEME_MOVES = 20;

/**
 * Games walked for the tactical themes.
 *
 * The other facts are read straight out of stored rows; this one replays the
 * PGN and runs the position detectors, which costs milliseconds per judged
 * move. Forty recent games is a couple of seconds and several hundred
 * mistakes — enough to tell a habit from an accident, and recent enough to be
 * about the player as they are now rather than as they were a year ago.
 */
export const THEME_GAMES = 40;

/**
 * Games each half of the archive needs before the two can be compared.
 *
 * Every other fact in this file is an average over the whole window, which
 * cannot tell a weakness from a weakness that was fixed six months ago: an
 * opening that bled centipawns for the first thirty games stays in the mean
 * for ever, and the coach goes on telling you about it. So the archive is cut
 * in half by date and the same numbers are computed on each side.
 *
 * Cut by count rather than by a number of days, because a player who played
 * two hundred games in a fortnight and then stopped has empty calendar windows
 * and a perfectly good archive.
 */
export const MIN_HALF_GAMES = 8;

/** Below this relative change, a difference between two halves is noise. */
const STABLE_SHARE = 0.1;

/** How many findings the model may return, and how long each part may be. */
export const MAX_FINDINGS = 5;
export const MAX_TITLE_CHARS = 80;
export const MAX_DETAIL_CHARS = 500;
export const MAX_DRILL_CHARS = 240;

/** Squares past which a threat counts as coming from a distance. */
const FAR = 3;

const PIECE_FR = { p: "pion", n: "cavalier", b: "fou", r: "tour", q: "dame", k: "roi" };

const PHASE_FR = { opening: "ouverture", middlegame: "milieu de partie", endgame: "finale" };

/** A long-range piece: the ones whose threats are missed for being far away. */
const SLIDERS = "brq";

const fact = (key, text) => ({ key, text });

const pct = (value) => (value === null || value === undefined ? null : `${value} %`);

/* ------------------------------------------------------------------ *
 * What punishes this player                                           *
 * ------------------------------------------------------------------ */

/**
 * The shape of the mistakes, counted over the games themselves.
 *
 * Everything else in the review is an average. This is the part that says what
 * the mistakes *are*: a piece left where something could take it, a fork
 * allowed, a mate in one walked past — and, for the pieces that do it, from how
 * far away. "Tu as du mal avec les menaces lointaines du fou" is a sentence no
 * model can be allowed to write from an ACPL, and one it can be trusted with
 * once somebody has counted them.
 *
 * Only the player's own judged moves are replayed. Running the detectors over
 * every move of forty games would be twenty seconds of a phone's time to say
 * the same thing: a quiet developing move is not what is being asked about.
 */
export function tacticalThemes(games, { limit = THEME_GAMES } = {}) {
  const recent = [...games]
    .filter((game) => game.analysis?.moves?.length)
    .sort((a, b) => (b.end_time ?? 0) - (a.end_time ?? 0))
    .slice(0, limit);

  const allowed = { hangs: 0, allowsFork: 0, missedMate: 0 };
  const attackers = new Map();
  let judged = 0;
  let far = 0;

  for (const game of recent) {
    let moves = [];
    try {
      moves = mergeMoves(positionsFromPgn(game.pgn), game.analysis.moves);
    } catch {
      // A PGN that will not replay is one game's worth of facts, not a reason
      // to lose the review.
      continue;
    }

    for (const move of moves) {
      if (move.color !== game.user_color || !move.judgment || !move.move) continue;
      judged += 1;

      let motifs = [];
      try {
        motifs = motifsFor({
          before: move.fen_before,
          after: move.fen_after,
          move: move.move,
        });
      } catch {
        continue;
      }

      for (const motif of motifs) {
        // A missed mate is credited to the player - it is what they did not
        // see - and the other two are what the move handed over. Counting them
        // by the same rule would count one of them twice.
        if (motif.key === "missedMate") allowed.missedMate += 1;
        else if (motif.side === "opponent" && motif.key in allowed) allowed[motif.key] += 1;
        if (motif.key !== "hangs" || !motif.attacker) continue;

        const distant = motif.distance >= FAR && SLIDERS.includes(motif.attacker);
        if (distant) far += 1;
        const current = attackers.get(motif.attacker) ?? { count: 0, far: 0 };
        attackers.set(motif.attacker, {
          count: current.count + 1,
          far: current.far + (distant ? 1 : 0),
        });
      }
    }
  }

  return {
    games: recent.length,
    judged,
    allowed,
    far,
    by_attacker: [...attackers.entries()]
      .map(([piece, counts]) => ({ piece, name: PIECE_FR[piece], ...counts }))
      .sort((a, b) => b.count - a.count),
  };
}

/* ------------------------------------------------------------------ *
 * Then against now                                                    *
 * ------------------------------------------------------------------ */

/** The archive in two halves by date, oldest first, or null if it is too small. */
export function splitByRecency(games) {
  const ordered = [...games]
    .filter((game) => game.analysis?.moves?.length && game.end_time)
    .sort((a, b) => a.end_time - b.end_time);
  if (ordered.length < 2 * MIN_HALF_GAMES) return null;

  const cut = Math.floor(ordered.length / 2);
  return {
    older: ordered.slice(0, cut),
    recent: ordered.slice(cut),
    cutAt: new Date(ordered[cut].end_time * 1000),
  };
}

/**
 * Which way a number moved, said here rather than left to the model.
 *
 * "34 puis 19" is two numbers a reader of centipawns understands and a model
 * has to reason about - and for half of these fields lower is better while for
 * the other half it is worse. Getting that backwards produces a coach
 * congratulating you on a collapse, in fluent French. So the direction is
 * computed, and the sentence carries it.
 */
export function trendText(label, before, after, { unit = "", higherIsBetter = false } = {}) {
  if (before === null || before === undefined || after === null || after === undefined) return null;
  const delta = after - before;
  const stable = Math.abs(delta) <= Math.abs(before) * STABLE_SHARE;
  const better = higherIsBetter ? delta > 0 : delta < 0;
  const direction = stable ? "stable" : better ? "en progrès" : "en recul";
  return `${label} : ${before}${unit} sur la première moitié, ${after}${unit} sur la seconde (${direction})`;
}

/**
 * The same numbers, twice, so a fixed problem can be seen to be fixed.
 *
 * This is the half of the review that makes it a coach rather than a report: a
 * defect that is being corrected is not a defect to work on, and telling
 * somebody about the opening they already repaired is how advice loses its
 * authority.
 */
export function evolutionFacts(split) {
  if (!split) return [];

  const before = computeStats(split.older);
  const after = computeStats(split.recent);
  const facts = [];
  const add = (key, text) => text && facts.push(fact(key, text));

  add(
    "evolution.fenetre",
    `les faits « evolution » comparent tes ${before.analysed} parties analysées les plus ` +
      `anciennes aux ${after.analysed} plus récentes, coupées au ${split.cutAt.toLocaleDateString("fr-FR")}`,
  );
  add(
    "evolution.precision",
    trendText("précision moyenne", before.avg_accuracy, after.avg_accuracy, {
      unit: " %",
      higherIsBetter: true,
    }),
  );
  add("evolution.acpl", trendText("centipions perdus par coup", before.avg_acpl, after.avg_acpl));
  add(
    "evolution.gaffes",
    trendText("gaffes par partie", before.blunders_per_game, after.blunders_per_game),
  );
  add(
    "evolution.victoires",
    trendText("victoires", before.win_rate, after.win_rate, { unit: " %", higherIsBetter: true }),
  );

  for (const phase of Object.keys(after.phase_acpl ?? {})) {
    add(
      `evolution.phase.${phase}`,
      trendText(
        `${PHASE_FR[phase] ?? phase}, centipions perdus par coup`,
        before.phase_acpl?.[phase],
        after.phase_acpl?.[phase],
      ),
    );
  }

  // Openings are where "it used to be a problem" happens most, because a
  // repertoire is learnt. Only the ones played enough on both sides of the cut:
  // an opening picked up last month has no before to compare against.
  const oldOpenings = new Map(openingExit(split.older).map((row) => [row.name, row]));
  openingExit(split.recent).forEach((row, index) => {
    const was = oldOpenings.get(row.name);
    if (!was || was.games < MIN_OPENING_GAMES || row.games < MIN_OPENING_GAMES) return;
    const text = trendText(
      `${row.name}, centipions perdus par coup sur les douze premiers coups`,
      was.acpl,
      row.acpl,
    );
    add(`evolution.ouverture.${index + 1}`, text && `${text} — ${was.games} parties puis ${row.games}`);
  });

  return facts;
}

/* ------------------------------------------------------------------ *
 * The facts, keyed                                                    *
 * ------------------------------------------------------------------ */

/**
 * Every number the model may cite, as `clé | phrase`.
 *
 * The key is the contract: a finding cites keys, and `validateReview` throws
 * away a finding whose keys are not in this list. So a claim about an opening
 * that was never sent cannot survive, however plausibly it is worded.
 */
export function archiveFacts({ stats, insights, themes, split = null }) {
  const facts = [];
  const add = (key, text) => text && facts.push(fact(key, text));

  add(
    "resume.parties",
    `${stats.analysed} parties analysées sur ${stats.games}, ${pct(stats.win_rate)} de victoires ` +
      `(${stats.wins} V / ${stats.draws} N / ${stats.losses} D)`,
  );
  add(
    "resume.precision",
    `précision moyenne ${stats.avg_accuracy ?? "?"} %, ${stats.avg_acpl ?? "?"} centipions perdus par coup`,
  );
  add(
    "resume.fautes",
    `par partie : ${stats.blunders_per_game ?? "?"} gaffes, ${stats.mistakes_per_game ?? "?"} erreurs, ` +
      `${stats.inaccuracies_per_game ?? "?"} imprécisions`,
  );

  // Straight after the headline, because they change how everything under them
  // should be read: the rest of this list is an average over the whole window,
  // and an average cannot tell a weakness from a weakness that has been fixed.
  facts.push(...evolutionFacts(split));

  for (const [phase, acpl] of Object.entries(stats.phase_acpl ?? {})) {
    add(`phase.${phase}`, `${PHASE_FR[phase] ?? phase} : ${acpl} centipions perdus par coup`);
  }

  for (const row of stats.by_color ?? []) {
    add(
      `couleur.${row.name}`,
      `avec les ${row.name === "white" ? "blancs" : "noirs"} : ${row.games} parties, ` +
        `${pct(row.win_rate)} de victoires, précision ${row.avg_accuracy ?? "?"} %`,
    );
  }

  for (const row of stats.by_time_class ?? []) {
    add(
      `cadence.${row.name}`,
      `${row.name} : ${row.games} parties, ${pct(row.win_rate)} de victoires, ` +
        `précision ${row.avg_accuracy ?? "?"} %`,
    );
  }

  for (const row of insights.by_piece ?? []) {
    if (row.moves < MIN_PIECE_MOVES) continue;
    add(
      `piece.${row.piece}`,
      `coups de ${PIECE_LABEL[row.piece].toLowerCase()} : ${row.moves} coups, ` +
        `${row.avg_cp_loss} centipions perdus en moyenne, ${row.blunders} gaffes`,
    );
  }

  (insights.opening_exit ?? []).forEach((row, index) => {
    if (row.games < MIN_OPENING_GAMES) return;
    add(
      `ouverture.${index + 1}`,
      `${row.name} : ${row.games} parties, ${row.acpl} centipions perdus par coup sur les douze ` +
        `premiers coups, ${pct(row.win_rate)} de victoires`,
    );
  });

  for (const band of insights.by_rating_gap ?? []) {
    if (band.games < MIN_BAND_GAMES) continue;
    add(
      `ecart.${band.key}`,
      `${band.name} : ${band.games} parties, ${pct(band.win_rate)} de victoires, ` +
        `précision ${band.avg_accuracy ?? "?"} %`,
    );
  }

  const conversion = insights.conversion;
  if (conversion?.winning_positions >= MIN_BAND_GAMES) {
    add(
      "conversion",
      `${conversion.winning_positions} parties où tu as eu deux pions d’avance, ` +
        `${conversion.converted} gagnées (${pct(conversion.conversion_rate)})`,
    );
  }
  if (conversion?.losing_positions >= MIN_BAND_GAMES) {
    add(
      "resilience",
      `${conversion.losing_positions} parties où tu as été à deux pions derrière, ` +
        `${conversion.saved} sauvées (${pct(conversion.save_rate)})`,
    );
  }

  for (const rank of insights.session_tilt ?? []) {
    if (rank.games < MIN_TILT_GAMES) continue;
    add(
      `serie.${rank.rank}`,
      `${rank.name} partie d’une même session : ${rank.games} parties, ` +
        `${pct(rank.win_rate)} de victoires, ${rank.blunders_per_game ?? "?"} gaffes par partie`,
    );
  }

  const clock = insights.clock;
  if (clock?.buckets) {
    for (const bucket of clock.buckets) {
      if (bucket.moves < MIN_CLOCK_MOVES) continue;
      add(
        `horloge.${bucket.key}`,
        `coups joués en ${bucket.name} : ${bucket.moves} coups, ${bucket.blunders} gaffes, ` +
          `${bucket.avg_cp_loss ?? "?"} centipions perdus en moyenne`,
      );
    }
    if (clock.median_seconds != null) {
      add("horloge.median", `temps médian par coup : ${clock.median_seconds} s`);
    }
  }

  const strength = insights.opponent_strength;
  if (strength?.win_loss_gap != null) {
    add(
      "adversaires.ecart",
      `les adversaires qui te battent sont en moyenne ${strength.win_loss_gap} points au-dessus ` +
        `de ceux que tu bats`,
    );
  }

  if (themes?.judged >= MIN_THEME_MOVES) {
    add(
      "motif.echantillon",
      `sur les ${themes.games} dernières parties, ${themes.judged} de tes coups sont jugés ` +
        `(imprécision, erreur ou gaffe)`,
    );
    add(
      "motif.piece_en_prise",
      `${themes.allowed.hangs} de ces coups laissent une pièce là où l’adversaire peut la prendre`,
    );
    if (themes.allowed.allowsFork) {
      add("motif.fourchette", `${themes.allowed.allowsFork} de ces coups permettent une fourchette`);
    }
    if (themes.allowed.missedMate) {
      add("motif.mat_manque", `${themes.allowed.missedMate} fois, un mat en un était disponible`);
    }
    for (const attacker of themes.by_attacker) {
      if (attacker.count < 3) continue;
      add(
        `motif.attaquant.${attacker.piece}`,
        `${attacker.count} de ces pièces sont prises par ${PIECE_FR[attacker.piece] ?? "?"}` +
          (attacker.far ? `, dont ${attacker.far} à trois cases ou plus de distance` : ""),
      );
    }
  }

  return facts;
}

/** Is there enough here to be worth asking about? */
export function reviewReadiness(stats) {
  if (!stats || stats.analysed < MIN_GAMES) {
    return {
      ready: false,
      reason:
        `Il faut au moins ${MIN_GAMES} parties analysées pour un bilan ` +
        `(${stats?.analysed ?? 0} pour l’instant).`,
    };
  }
  return { ready: true, reason: null };
}

/**
 * The whole request, built but not sent.
 *
 * One request, not one per game: the facts are already aggregates, and the
 * whole archive fits in a couple of thousand characters. The keys travel back
 * with it because they are what the answer is checked against.
 */
export function buildReview({ games = [], stats, insights, themes, kind = "rated", days = null }) {
  const split = splitByRecency(games);
  const facts = archiveFacts({ stats, insights, themes, split });
  const header = [
    "Bilan d’archive.",
    days ? `Fenêtre : ${days} derniers jours.` : "Fenêtre : tout l’historique.",
    kind === "training" ? "Parties non classées." : "Parties classées.",
  ].join(" ");

  return {
    facts,
    keys: facts.map((f) => f.key),
    sample: { games: stats.analysed, kind, days },
    text: [header, "", "FAITS (clé | valeur) :", ...facts.map((f) => `${f.key} | ${f.text}`)].join(
      "\n",
    ),
  };
}

/**
 * The instructions, which are mostly the same list of things not to do.
 *
 * The one rule that is not in `client.js`'s per-move prompt is the third: a
 * review is where a model is most tempted to turn a small sample into a
 * character trait, because that is what advice sounds like. The facts below
 * their minimum never arrive here, and this asks it to say so about the ones
 * that only just cleared it.
 */
export const REVIEW_PROMPT = [
  "Tu es un entraîneur d’échecs francophone. On te donne le bilan chiffré de toutes les parties",
  "d’un joueur, déjà analysées par Stockfish. Tu ne vois aucune partie, aucun coup, aucune position.",
  "",
  "Règles absolues :",
  "- N’utilise QUE les faits fournis. N’invente aucun chiffre, aucune ouverture, aucun coup, aucune variante.",
  "- Chaque constat cite dans « evidence » au moins une clé de fait, recopiée exactement.",
  "- Ne fais pas dire à un chiffre plus qu’il ne dit : si l’échantillon est petit, dis-le au lieu d’affirmer une tendance.",
  "- Les faits « evolution » comparent la première moitié de l’archive à la seconde. Les autres sont des",
  "  moyennes sur toute la fenêtre, où un défaut ancien reste visible même s’il est corrigé depuis :",
  "  quand un fait « evolution » dit « en progrès », ne fais pas un reproche de ce qui est en train d’être réglé.",
  "- Si quelque chose s’est nettement amélioré, l’un des constats doit le dire et dire quoi continuer.",
  "- Tutoie le joueur. Parle de son jeu, jamais de lui.",
  "- Aucun markdown, aucune liste, aucun emoji, aucun titre.",
  "",
  `Rends trois à ${MAX_FINDINGS} constats, du plus rentable au moins rentable. Pour chacun :`,
  `- « title » : ce que tu as vu, en une phrase de ${MAX_TITLE_CHARS} caractères au plus.`,
  "- « detail » : deux à trois phrases. Le chiffre, ce qu’il veut dire, et pourquoi il coûte des points.",
  "- « drill » : un exercice concret et vérifiable pour la semaine, pas un conseil général.",
  "",
  'Réponds uniquement par cet objet JSON : {"findings":[{"title":"…","detail":"…","drill":"…","evidence":["clé"]}]}',
].join("\n");

/**
 * Keep the findings that answer the question that was asked.
 *
 * A finding citing a key that was never sent is the review's version of a
 * comment on a ply that does not exist: the model filled a blank rather than
 * read a number, and the whole point of the digest is that it cannot. Unknown
 * keys are stripped; a finding left with none is dropped entirely.
 */
export function validateReview(payload, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const findings = [];

  for (const raw of payload?.findings ?? []) {
    const title = typeof raw?.title === "string" ? raw.title.trim() : "";
    const detail = typeof raw?.detail === "string" ? raw.detail.trim() : "";
    const drill = typeof raw?.drill === "string" ? raw.drill.trim() : "";
    const evidence = (Array.isArray(raw?.evidence) ? raw.evidence : []).filter((key) =>
      allowed.has(key),
    );

    if (!title || !detail || !evidence.length) continue;
    if (title.length > MAX_TITLE_CHARS || detail.length > MAX_DETAIL_CHARS) continue;
    if (drill.length > MAX_DRILL_CHARS) continue;

    findings.push({ title, detail, drill: drill || null, evidence });
    if (findings.length === MAX_FINDINGS) break;
  }

  return findings;
}
