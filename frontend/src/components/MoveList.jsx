import { useEffect, useRef } from 'react'
import { JUDGMENT_CLASS, formatEval } from '../utils/chess'

function MoveCell({ move, active, onSelect }) {
  if (!move) return <span className="flex-1" />
  return (
    <button
      type="button"
      onClick={() => onSelect(move.ply)}
      data-active={active || undefined}
      className={`flex-1 rounded px-2 py-1 text-left font-mono text-sm transition-colors
        hover:bg-ink-700 data-active:bg-accent/25 data-active:text-white
        ${JUDGMENT_CLASS[move.judgment] || 'text-ink-100'}`}
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

  const current = moves.find((m) => m.ply === currentPly)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-baseline justify-between border-b border-ink-700 px-3 py-2">
        <h3 className="text-sm font-medium text-ink-300">Coups</h3>
        <span className="font-mono text-sm text-ink-100">{formatEval(current)}</span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-1">
        {rows.map((row) => (
          <div key={row.number} className="flex items-center gap-1">
            <span className="w-8 shrink-0 text-right font-mono text-xs text-ink-500">
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
