import { useEffect, useState } from 'react'
import { onWakingUp } from '../utils/api'

/**
 * Tells the truth while the free-tier API boots.
 *
 * A cold start takes well over a minute, and a silent spinner followed by
 * "server unreachable" reads as a broken site rather than a sleeping one.
 */
export default function WakeUpBanner() {
  const [waking, setWaking] = useState(false)

  useEffect(() => onWakingUp(setWaking), [])

  if (!waking) return null
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-50 bg-accent/15 px-4 py-2 text-center text-sm text-ink-100 backdrop-blur"
    >
      <span className="mr-2 inline-block size-3 animate-spin rounded-full border-2 border-ink-500 border-t-ink-100 align-middle" />
      Le serveur se réveille, cela prend environ une minute…
    </div>
  )
}
