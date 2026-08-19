import { useEffect, useRef } from 'react'
import { Chessground } from 'chessground'

/** Read-only Chessground board driven by a FEN. */
export default function Board({ fen, orientation = 'white', lastMove, shapes = [] }) {
  const containerRef = useRef(null)
  const apiRef = useRef(null)

  useEffect(() => {
    apiRef.current = Chessground(containerRef.current, {
      fen,
      orientation,
      viewOnly: true,
      coordinates: true,
      animation: { enabled: true, duration: 180 },
      highlight: { lastMove: true, check: true },
      drawable: { enabled: false, visible: true, autoShapes: shapes },
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
      lastMove: lastMove ? [lastMove.slice(0, 2), lastMove.slice(2, 4)] : undefined,
      drawable: { autoShapes: shapes },
    })
  }, [fen, orientation, lastMove, shapes])

  return (
    <div className="aspect-square w-full overflow-hidden rounded-lg ring-1 ring-ink-700">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}
