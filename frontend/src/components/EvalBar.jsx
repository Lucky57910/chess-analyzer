import { formatEval, winPercentWhite } from '../utils/chess'

/**
 * Vertical domination bar drawn alongside the board, Chess.com style.
 *
 * The side sitting at the bottom of the board owns the bottom of the bar, so
 * the reading stays intuitive once the board is flipped.
 */
export default function EvalBar({ move, orientation = 'white' }) {
  const whiteShare = winPercentWhite(move)
  const bottomIsWhite = orientation === 'white'
  const bottomShare = bottomIsWhite ? whiteShare : 100 - whiteShare
  const label = formatEval(move)

  const light = '#e8edf4'
  const dark = '#22272f'

  return (
    <div
      className="relative w-3 shrink-0 self-stretch overflow-hidden rounded-sm ring-1 ring-line-strong sm:w-4"
      style={{ background: bottomIsWhite ? dark : light }}
      role="img"
      aria-label={`Évaluation ${label}`}
      title={label}
    >
      <div
        className="absolute inset-x-0 bottom-0 transition-[height] duration-200 ease-out"
        style={{ height: `${bottomShare}%`, background: bottomIsWhite ? light : dark }}
      />
      {/* the 50/50 mark, so a small edge is still readable */}
      <div className="absolute inset-x-0 top-1/2 h-px bg-faint/50" />
    </div>
  )
}
