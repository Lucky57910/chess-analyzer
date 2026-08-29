/**
 * The two containers every screen is built from.
 *
 * `Card` is a plain raised surface. `Panel` is a card with a heading and an
 * optional line of explanation under it — the shape the statistics screen had
 * invented for itself, hoisted out so the analysis screen stops inventing a
 * fourth one.
 */

export function Card({ className = '', children, ...rest }) {
  return (
    <div className={`rounded-xl border border-line bg-surface ${className}`} {...rest}>
      {children}
    </div>
  )
}

export function Panel({ title, hint, action, children, className = '', bodyClass = '' }) {
  return (
    <section className={`flex flex-col rounded-xl border border-line bg-surface ${className}`}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-line-strong px-4 py-2.5">
          <div className="min-w-0">
            <h2 className="text-body font-medium text-muted">{title}</h2>
            {/* Wraps. The hint is the sentence that says what the panel is
                for, so a hint that is cut off is a panel with no title at
                all. */}
            {hint && <p className="mt-0.5 text-label text-faint">{hint}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  )
}

/** A break between groups of panels, so a long screen reads as chapters. */
export function SectionTitle({ title, subtitle }) {
  return (
    <div className="mt-2">
      <h2 className="text-lead font-semibold text-text">{title}</h2>
      {subtitle && <p className="text-body text-faint">{subtitle}</p>}
    </div>
  )
}
