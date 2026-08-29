import { useEffect, useRef } from 'react'
import { JUDGMENT_CLASS } from '../utils/chess'

function MoveCell({ move, active, onSelect }) {
  if (!move) return <span className="flex-1" />
  return (
    <button
      type="button"
      onClick={() => onSelect(move.ply)}
      data-active={active || undefined}
      // 36px rather than the usual 44px floor: this is a dense scannable grid
      // where a mis-tap costs one arrow press, and 44px rows would fit six
      // moves in the panel.
      className={`min-h-9 flex-1 rounded px-2 text-left font-mono text-body transition-colors
        hover:bg-line-strong data-active:bg-accent/25 data-active:font-medium data-active:text-white
        ${JUDGMENT_CLASS[move.judgment] || 'text-text'}`}
    >
      {move.san}
      {move.judgment === 'blunder' && ' ??'}
      {move.judgment === 'mistake' && ' ?'}
      {move.judgment === 'inaccuracy' && ' ?!'}
    </button>
  )
}

/** Paired move list; the active ply scrolls itself into view. */
export default function MoveList({ moves, currentPly, onSelectPly }) {
  const scrollRef = useRef(null)

  // Deliberately not `scrollIntoView`: it walks every scrollable ancestor, so
  // on the single-column mobile layout it dragged the whole page down to the
  // move list and pushed the board off screen. Scroll our own box instead.
  useEffect(() => {
    const box = scrollRef.current
    const active = box?.querySelector('[data-active]')
    if (!box || !active) return
    const target = active.offsetTop - box.clientHeight / 2 + active.clientHeight / 2
    box.scrollTop = Math.max(0, target)
  }, [currentPly])

  const rows = []
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({
      number: moves[i].move_number,
      white: moves[i].color === 'white' ? moves[i] : null,
      black: moves[i].color === 'white' ? moves[i + 1] : moves[i],
    })
  }

  // No heading and no evaluation of its own any more: the tab above this says
  // "Coups", and the evaluation sits beside the board where the position it
  // describes is. Both were on screen twice.
  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-1">
        {rows.map((row) => (
          <div key={row.number} className="flex items-center gap-1">
            <span className="w-8 shrink-0 text-right font-mono text-label text-faint">
              {row.number}.
            </span>
            <MoveCell
              move={row.white}
              active={row.white?.ply === currentPly}
              onSelect={onSelectPly}
            />
            <MoveCell
              move={row.black}
              active={row.black?.ply === currentPly}
              onSelect={onSelectPly}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
