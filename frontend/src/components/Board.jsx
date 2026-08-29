import { useEffect, useRef } from 'react'
import { Chessground } from 'chessground'

/**
 * Chessground driven by a FEN.
 *
 * Read-only by default, which is what the analysis screen wants. Passing
 * `dests` makes it playable: the map comes from chess.js, so the squares the
 * board offers are exactly the ones the rules allow, and an illegal drag is
 * never accepted in the first place.
 */
export default function Board({
  fen,
  orientation = 'white',
  lastMove,
  shapes = [],
  dests,
  movableColor,
  onMove,
}) {
  const containerRef = useRef(null)
  const apiRef = useRef(null)
  // Held in a ref so a new handler on every render does not mean rebuilding
  // the board's configuration on every render with it.
  const moveRef = useRef(onMove)
  moveRef.current = onMove

  useEffect(() => {
    apiRef.current = Chessground(containerRef.current, {
      fen,
      orientation,
      viewOnly: !dests,
      coordinates: true,
      animation: { enabled: true, duration: 180 },
      highlight: { lastMove: true, check: true },
      drawable: { enabled: false, visible: true, autoShapes: shapes },
      movable: {
        free: false,
        showDests: true,
        events: { after: (from, to) => moveRef.current?.(from, to) },
      },
    })
    return () => {
      apiRef.current?.destroy()
      apiRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    apiRef.current?.set({
      fen,
      orientation,
      viewOnly: !dests,
      lastMove: lastMove ? [lastMove.slice(0, 2), lastMove.slice(2, 4)] : undefined,
      drawable: { autoShapes: shapes },
      movable: { free: false, color: movableColor, dests },
    })
  }, [fen, orientation, lastMove, shapes, dests, movableColor])

  return (
    <div className="aspect-square w-full overflow-hidden rounded-lg ring-1 ring-line-strong">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}
