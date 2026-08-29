/**
 * Explanations you can actually read.
 *
 * The app carried a lot of writing in `title` attributes: what accuracy means,
 * how it differs from the score, what a centipawn is, what "Voir le meilleur
 * coup" does. A `title` renders as a tooltip on hover — and this app ships as
 * an APK, where nothing hovers. On a phone every one of those sentences was
 * written, shipped, and never once displayed.
 *
 * So they become a control. A small ⓘ opens the note underneath the thing it
 * describes; tapping it again, or anywhere outside, closes it. The text is the
 * same text — nothing was shortened to fit a tooltip that was never shown.
 */

import { useEffect, useId, useRef, useState } from 'react'
import Icon from '../Icon'

export default function InfoNote({ label, children, className = '' }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const box = useRef(null)

  // Escape, and a tap anywhere else. Both only while it is open, so a screen
  // with a dozen of these adds no listeners until one is used.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    const onDown = (e) => {
      if (!box.current?.contains(e.target)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  return (
    <span ref={box} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        aria-label={open ? `Masquer : ${label}` : `Qu’est-ce que ${label} ?`}
        className={`touch-target inline-flex items-center justify-center rounded-full transition-colors ${
          open ? 'text-accent' : 'text-faint hover:text-muted'
        }`}
      >
        <Icon name="info" size={15} />
      </button>

      {open && (
        <span
          id={id}
          role="note"
          // Anchored to the right of the trigger and clamped to the viewport
          // width, because these sit inside 2-column tiles on a 375px screen
          // and a fixed-width popover would hang off the edge.
          className="absolute top-7 left-0 z-40 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-line-strong bg-raised px-3 py-2 text-label leading-relaxed text-muted shadow-xl shadow-black/50"
        >
          {children}
        </span>
      )}
    </span>
  )
}
