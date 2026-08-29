/** A short status word: a result, an analysis state, a judgment. */

const TONE = {
  neutral: 'bg-line-strong text-muted',
  good: 'bg-good/20 text-good',
  warn: 'bg-inaccuracy/20 text-inaccuracy',
  bad: 'bg-blunder/20 text-blunder',
  accent: 'bg-accent/15 text-accent',
}

export default function Badge({ tone = 'neutral', className = '', children }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-label font-medium whitespace-nowrap ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  )
}
