import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { JUDGMENT_COLOR, JUDGMENT_LABEL, evalToPawns, formatEval } from '../utils/chess'

const PAD = { top: 6, right: 6, bottom: 18, left: 30 }
const DOMAIN = 10 // pawns, symmetric
const Y_TICKS = [10, 5, 0, -5, -10]
const MIN_TICK_GAP = 44 // px between two move numbers on the X axis

/** Width of the element, kept live so the SVG can use real pixel coordinates. */
function useWidth(ref) {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return undefined
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return width
}

function Tooltip({ move, x }) {
  // Flip to the left of the cursor near the right edge so it stays on screen.
  const flip = x > 0.6
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 w-max max-w-[14rem] rounded-md border border-line-strong bg-surface px-3 py-2 text-label shadow-lg"
      style={{ left: `${x * 100}%`, transform: `translateX(${flip ? '-100%' : '0'})`, height: 0 }}
    >
      <div className="font-medium text-text">
        {move.move_number}
        {move.color === 'white' ? '.' : '...'} {move.san}
      </div>
      <div className="text-muted">Éval {formatEval(move)}</div>
      {move.judgment && (
        <div style={{ color: JUDGMENT_COLOR[move.judgment] }}>
          {JUDGMENT_LABEL[move.judgment]} · −{(move.cp_loss / 100).toFixed(2)}
        </div>
      )}
    </div>
  )
}

/**
 * Evaluation curve, White POV. Clicking anywhere jumps the board to that ply.
 *
 * Hand-rolled SVG rather than a charting library: this is one series on a fixed
 * domain, and pulling Recharts in for it cost ~380 kB on the page people open
 * the most, on phones.
 */
export default function EvalGraph({ moves, currentPly, onSelectPly, height = 180 }) {
  const boxRef = useRef(null)
  const width = useWidth(boxRef)
  const [hoverPly, setHoverPly] = useState(null)

  const plot = {
    w: Math.max(0, width - PAD.left - PAD.right),
    h: Math.max(0, height - PAD.top - PAD.bottom),
  }

  const points = useMemo(
    () =>
      moves.map((move, index) => ({
        move,
        // One slot per ply, first and last sitting on the plot edges.
        fx: moves.length > 1 ? index / (moves.length - 1) : 0.5,
        fy: (DOMAIN - evalToPawns(move)) / (2 * DOMAIN),
      })),
    [moves],
  )

  if (!moves.length) return null

  const px = (fx) => PAD.left + fx * plot.w
  const py = (fy) => PAD.top + fy * plot.h
  const baseline = PAD.top + plot.h

  const coords = points.map((p) => [px(p.fx), py(p.fy)])
  const line = coords.map(([x, y]) => `${x},${y}`).join(' ')
  const area = [
    `M ${coords[0][0]},${baseline}`,
    ...coords.map(([x, y]) => `L ${x},${y}`),
    `L ${coords[coords.length - 1][0]},${baseline} Z`,
  ].join(' ')

  const step = Math.max(1, Math.ceil(moves.length / Math.max(1, Math.floor(plot.w / MIN_TICK_GAP))))
  const xTicks = points.filter((_, index) => index % step === 0)

  const plyFromEvent = (event) => {
    const box = boxRef.current.getBoundingClientRect()
    const fx = (event.clientX - box.left - PAD.left) / (plot.w || 1)
    const index = Math.round(fx * (moves.length - 1))
    return moves[Math.max(0, Math.min(moves.length - 1, index))].ply
  }

  const hovered = hoverPly && points.find((p) => p.move.ply === hoverPly)
  const active = currentPly > 0 && points.find((p) => p.move.ply === currentPly)

  return (
    <div ref={boxRef} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          className="cursor-pointer touch-pan-y"
          onPointerMove={(e) => setHoverPly(plyFromEvent(e))}
          onPointerLeave={() => setHoverPly(null)}
          onClick={(e) => onSelectPly(plyFromEvent(e))}
        >
          <defs>
            <linearGradient id="evalFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.55" />
              <stop offset="50%" stopColor="var(--color-accent)" stopOpacity="0.05" />
              <stop offset="100%" stopColor="var(--color-blunder)" stopOpacity="0.25" />
            </linearGradient>
          </defs>

          {Y_TICKS.map((pawns) => {
            const y = py((DOMAIN - pawns) / (2 * DOMAIN))
            return (
              <g key={pawns}>
                <line
                  x1={PAD.left}
                  x2={PAD.left + plot.w}
                  y1={y}
                  y2={y}
                  stroke="var(--color-line-strong)"
                  strokeDasharray={pawns === 0 ? undefined : '2 4'}
                />
                <text
                  x={PAD.left - 6}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="11"
                  fill="var(--color-faint)"
                >
                  {pawns}
                </text>
              </g>
            )
          })}

          {xTicks.map((p) => (
            <text
              key={p.move.ply}
              x={px(p.fx)}
              y={height - 4}
              textAnchor="middle"
              fontSize="11"
              fill="var(--color-faint)"
            >
              {p.move.move_number}
            </text>
          ))}

          <path d={area} fill="url(#evalFill)" />
          <polyline
            points={line}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="2"
            strokeLinejoin="round"
          />

          {points
            .filter((p) => p.move.judgment)
            .map((p) => (
              <circle
                key={p.move.ply}
                cx={px(p.fx)}
                cy={py(p.fy)}
                r="4"
                fill={JUDGMENT_COLOR[p.move.judgment]}
              />
            ))}

          {active && (
            <line
              x1={px(active.fx)}
              x2={px(active.fx)}
              y1={PAD.top}
              y2={baseline}
              stroke="var(--color-text)"
            />
          )}

          {hovered && (
            <>
              <line
                x1={px(hovered.fx)}
                x2={px(hovered.fx)}
                y1={PAD.top}
                y2={baseline}
                stroke="var(--color-faint)"
              />
              <circle cx={px(hovered.fx)} cy={py(hovered.fy)} r="5" fill="var(--color-text)" />
            </>
          )}
        </svg>
      )}

      {hovered && <Tooltip move={hovered.move} x={hovered.fx} />}
    </div>
  )
}
