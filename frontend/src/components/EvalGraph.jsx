import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { JUDGMENT_COLOR, JUDGMENT_LABEL, evalToPawns, formatEval } from '../utils/chess'

function JudgmentDot({ cx, cy, payload }) {
  if (!payload.judgment) return null
  return <circle cx={cx} cy={cy} r={4} fill={JUDGMENT_COLOR[payload.judgment]} stroke="none" />
}

function EvalTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-ink-100">
        {p.move_number}
        {p.color === 'white' ? '.' : '...'} {p.san}
      </div>
      <div className="text-ink-300">Éval {p.evalLabel}</div>
      {p.judgment && (
        <div style={{ color: JUDGMENT_COLOR[p.judgment] }}>
          {JUDGMENT_LABEL[p.judgment]} · −{(p.cp_loss / 100).toFixed(2)}
        </div>
      )}
    </div>
  )
}

/** Evaluation curve, White POV. Clicking anywhere jumps the board to that ply. */
export default function EvalGraph({ moves, currentPly, onSelectPly, height = 180 }) {
  const data = useMemo(
    () =>
      moves.map((m) => ({
        ...m,
        value: evalToPawns(m),
        evalLabel: formatEval(m),
      })),
    [moves],
  )

  if (!data.length) return null

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 6, right: 8, bottom: 0, left: -24 }}
          onClick={(state) => {
            const idx = state?.activeTooltipIndex
            if (idx !== undefined && idx !== null) onSelectPly(data[idx].ply)
          }}
        >
          <defs>
            <linearGradient id="evalFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.55" />
              <stop offset="50%" stopColor="var(--color-accent)" stopOpacity="0.05" />
              <stop offset="100%" stopColor="var(--color-blunder)" stopOpacity="0.25" />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--color-ink-700)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="ply"
            tick={{ fill: 'var(--color-ink-500)', fontSize: 11 }}
            tickFormatter={(ply) => Math.ceil(ply / 2)}
            interval="preserveStartEnd"
            minTickGap={24}
            stroke="var(--color-ink-700)"
          />
          <YAxis
            domain={[-10, 10]}
            ticks={[-10, -5, 0, 5, 10]}
            tick={{ fill: 'var(--color-ink-500)', fontSize: 11 }}
            stroke="var(--color-ink-700)"
            width={44}
          />
          <ReferenceLine y={0} stroke="var(--color-ink-500)" strokeWidth={1} />
          {currentPly > 0 && (
            <ReferenceLine x={currentPly} stroke="var(--color-ink-100)" strokeWidth={1} />
          )}
          <Tooltip content={<EvalTooltip />} cursor={{ stroke: 'var(--color-ink-500)' }} />
          <Area
            type="monotone"
            dataKey="value"
            stroke="var(--color-accent)"
            strokeWidth={2}
            fill="url(#evalFill)"
            dot={<JudgmentDot />}
            activeDot={{ r: 5, fill: 'var(--color-ink-100)' }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
