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
 * Everything it says comes from `coach/narrate.js`; this file only draws.
 */

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

export default function CoachBubble({ message, san, moveNumber, color, pending }) {
  const hasSomething = message?.headline || message?.details?.length || message?.verdict
  if (!hasSomething && !pending) return null

  const tone = TONE[message?.tone] ?? TONE.neutral

  return (
    <section
      aria-label="Commentaire du coach"
      className="flex items-start gap-2.5"
    >
      {/* The avatar is what makes this read as somebody talking rather than as
          one more panel. It is the same knight as the title bar. */}
      <span
        className={`mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-raised ring-1 ${tone.ring}`}
      >
        <Icon name="knight" size={20} className="text-accent" />
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
        </div>

        {pending ? (
          <p className="mt-1.5 flex items-center gap-2 text-body text-faint" role="status">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            Le coach rédige son commentaire…
          </p>
        ) : (
          message?.headline && (
            <p className="mt-1.5 text-body leading-relaxed text-text">{message.headline}</p>
          )
        )}

        {message?.details?.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-1">
            {message.details.map((detail, i) => (
              <li
                key={i}
                className={`text-body leading-snug ${DETAIL_TONE[detail.tone] ?? 'text-muted'}`}
              >
                {detail.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
