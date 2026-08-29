/**
 * A row of mutually exclusive choices: Classées / Entraînement / Toutes,
 * Jour / Semaine / Mois, and so on.
 *
 * These were loose buttons where the selected one was a slightly lighter grey.
 * Grouped and given a real selected state they read as one setting with one
 * current value, which is what they are — and `aria-pressed` means a screen
 * reader says which value that is instead of reading four button labels.
 */

export default function Segmented({
  value,
  options,
  onChange,
  label,
  // Fills its container and shares the width between the options, for a tab
  // strip. A caller cannot get this by passing `flex w-full`: `inline-flex`
  // and `flex` are the same Tailwind layer, so which one wins depends on
  // stylesheet order rather than on the class list.
  block = false,
  className = '',
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`${
        block ? 'flex w-full' : 'inline-flex'
      } rounded-lg border border-line-strong bg-surface p-0.5 ${className}`}
    >
      {options.map((option) => {
        const key = option.key ?? option
        const text = option.label ?? option
        const active = key === value
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(key)}
            className={`min-h-9 rounded-md px-3 text-label transition-colors ${
              block ? 'flex-1' : ''
            } ${
              active
                ? 'bg-line-strong font-medium text-text'
                : 'text-faint hover:bg-raised hover:text-muted'
            }`}
          >
            {text}
          </button>
        )
      })}
    </div>
  )
}
