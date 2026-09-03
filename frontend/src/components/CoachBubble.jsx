/**
 * The coach, speaking.
 *
 * This was a `<ul>` of 12px lines under the board — the same grey as the move
 * count beside it, no heading, no edge. It carried the one thing on the screen
 * that is actually about *you* rather than about the position, and it read
 * like a caption.
 *
 * So it is a speech bubble now: an avatar, a tail, a coloured edge that says
 * at a glance whether this move was fine or expensive, and body text at
 * reading size. It is the loudest thing under the board, which matches what it
 * is for.
 *
 * Two things it now says that it did not:
 *
 *   - **who is talking.** Three sources speak here — a language model,
 *     Stockfish, and pure chess.js geometry — and they used to be one grey
 *     list, so "ton roi reste au centre" (written by a model) looked exactly
 *     like "ce coup cloue le cavalier" (a fact). They are not equally
 *     trustworthy; the reader is entitled to know which is which. The avatar
 *     and the header say who wrote the paragraph, and each supporting line
 *     carries a tag.
 *   - **that a variation can be walked.** A line printed as `Cf7+ Rg8 Cxd8`
 *     asks the reader to play three moves in their head against a board
 *     showing something else. The moves are buttons now.
 *
 * Everything it says still comes from `coach/narrate.js`; this file only draws.
 */

import { ORIGIN } from '../coach/narrate.js'
import Icon from './Icon'

/** Left edge, avatar, and verdict colour, per tone. */
const TONE = {
  blunder: { edge: 'border-l-blunder', chip: 'bg-blunder/15 text-blunder', ring: 'ring-blunder/40' },
  mistake: { edge: 'border-l-mistake', chip: 'bg-mistake/15 text-mistake', ring: 'ring-mistake/40' },
  inaccuracy: {
    edge: 'border-l-inaccuracy',
    chip: 'bg-inaccuracy/15 text-inaccuracy',
    ring: 'ring-inaccuracy/40',
  },
  good: { edge: 'border-l-good', chip: 'bg-good/15 text-good', ring: 'ring-good/40' },
  neutral: { edge: 'border-l-accent', chip: 'bg-accent/15 text-accent', ring: 'ring-accent/40' },
}

const DETAIL_TONE = {
  blunder: 'text-blunder',
  good: 'text-good',
  neutral: 'text-muted',
}

/**
 * How each source introduces itself.
 *
 * Short words, because they sit at the head of every supporting line: "IA"
 * rather than "commentaire généré", "Moteur" rather than "Stockfish 17.1". The
 * distinction that matters to the reader is only ever three-way.
 */
const SOURCE = {
  [ORIGIN.ai]: { label: 'Coach IA', icon: 'knight', className: 'bg-accent/15 text-accent' },
  [ORIGIN.engine]: { label: 'Moteur', icon: 'cpu', className: 'bg-raised text-muted' },
  [ORIGIN.position]: { label: 'Position', icon: 'grid', className: 'bg-raised text-muted' },
}

/** Who wrote a line, in three characters of screen. */
function SourceTag({ origin }) {
  const source = SOURCE[origin]
  if (!source) return null
  return (
    <span
      className={`mr-1.5 inline-flex items-center gap-1 rounded px-1.5 py-px align-[0.1em] text-label font-medium ${source.className}`}
    >
      <Icon name={source.icon} size={11} />
      {source.label}
    </span>
  )
}

/**
 * A variation, with its moves as buttons.
 *
 * The sentence is unchanged — "L’adversaire enchaîne Cc6 Cf3 : et la dame
 * tombe" — the moves inside it are simply tappable. Tapping one hands the
 * whole line and that index up, and the screen walks the board to it.
 *
 * With no handler the moves render as plain text, which is what keeps this
 * component drawable anywhere.
 */
function Variation({ variation, tone, onPlay }) {
  const moves = variation.steps.map((step, index) =>
    onPlay ? (
      <button
        key={index}
        type="button"
        onClick={() => onPlay(variation, index)}
        className="mx-0.5 rounded border border-line-strong bg-raised px-1.5 py-0.5 font-mono text-body text-text transition-colors hover:border-accent hover:text-accent active:bg-line-strong"
      >
        {step.san}
      </button>
    ) : (
      <span key={index} className="mx-0.5 font-mono">
        {step.san}
      </span>
    ),
  )

  return (
    <span className={DETAIL_TONE[tone] ?? 'text-muted'}>
      {variation.label} {moves}
      {variation.moment ? ` : ${variation.moment}.` : '.'}
    </span>
  )
}

export default function CoachBubble({
  message,
  san,
  moveNumber,
  color,
  pending,
  onPlayLine,
}) {
  const hasSomething = message?.headline || message?.details?.length || message?.verdict
  if (!hasSomething && !pending) return null

  const tone = TONE[message?.tone] ?? TONE.neutral
  // Who the avatar is. A generated paragraph makes this the coach; without one
  // the bubble is the engine reading its own analysis out loud, and drawing a
  // knight over that claims an author that does not exist.
  const author = SOURCE[message?.headlineOrigin] ?? SOURCE[ORIGIN.engine]

  return (
    <section aria-label="Commentaire du coach" className="flex items-start gap-2.5">
      {/* The avatar is what makes this read as somebody talking rather than as
          one more panel. */}
      <span
        className={`mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-raised ring-1 ${tone.ring}`}
      >
        <Icon name={author.icon} size={20} className="text-accent" />
      </span>

      <div
        className={`relative min-w-0 flex-1 rounded-xl rounded-tl-sm border border-line border-l-4 bg-surface px-3.5 py-2.5 ${tone.edge}`}
      >
        {/* The tail. A rotated square sitting on the border, so the bubble
            points at the avatar instead of floating beside it. */}
        <span
          aria-hidden="true"
          className="absolute top-3 -left-[7px] h-3 w-3 rotate-45 border-b border-l border-line bg-surface"
        />

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {san && (
            <span className="font-mono text-body text-text">
              <span className="text-faint">
                {moveNumber}
                {color === 'white' ? '.' : '…'}
              </span>{' '}
              {san}
            </span>
          )}
          {message?.verdict && (
            <span className={`rounded-md px-1.5 py-0.5 text-label font-medium ${tone.chip}`}>
              {message.verdict}
            </span>
          )}
          {message?.cost != null && (
            <span className="font-mono text-label text-faint tabular-nums">
              −{(message.cost / 100).toFixed(2)}
            </span>
          )}
          {message?.better && (
            <span className="text-label text-faint">
              mieux : <span className="font-mono text-muted">{message.better}</span>
            </span>
          )}
          {/* Who wrote the paragraph below, said once rather than tagged onto
              the paragraph itself. */}
          {message?.headline && (
            <span className="ml-auto flex items-center gap-1 text-label text-faint">
              <Icon name={author.icon} size={12} />
              {author.label}
            </span>
          )}
        </div>

        {pending ? (
          <p className="mt-1.5 flex items-center gap-2 text-body text-faint" role="status">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            Le coach rédige son commentaire…
          </p>
        ) : (
          message?.headline &&
          (message.headlineVariation ? (
            <p className="mt-1.5 text-body leading-relaxed">
              <Variation
                variation={message.headlineVariation}
                tone={message.tone}
                onPlay={onPlayLine}
              />
            </p>
          ) : (
            <p className="mt-1.5 text-body leading-relaxed text-text">{message.headline}</p>
          ))
        )}

        {message?.details?.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {message.details.map((detail, i) => (
              <li
                key={i}
                className={`text-body leading-snug ${DETAIL_TONE[detail.tone] ?? 'text-muted'}`}
              >
                <SourceTag origin={detail.origin} />
                {detail.variation ? (
                  <Variation
                    variation={detail.variation}
                    tone={detail.tone}
                    onPlay={onPlayLine}
                  />
                ) : (
                  detail.text
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
