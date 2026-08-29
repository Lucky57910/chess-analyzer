/**
 * The one button in the app.
 *
 * Before this there were four spellings of "bordered pill with hover" copied
 * across five screens, each with its own padding and its own idea of what
 * disabled looks like. Worse, several of them were 28px tall: under the 44px
 * every touch guideline asks for, which is why the arrows under the board were
 * easy to miss with a thumb.
 *
 * `variant` says how loud it is, `size` how big. Nothing else is negotiable.
 */

import { Link } from 'react-router-dom'
import Icon from '../Icon'

const VARIANT = {
  primary: 'bg-accent text-canvas font-medium hover:brightness-110 active:brightness-95',
  secondary:
    'border border-line-strong text-muted hover:bg-raised hover:text-text active:bg-line-strong',
  ghost: 'text-muted hover:bg-raised hover:text-text active:bg-line-strong',
  danger: 'border border-blunder/50 text-blunder hover:bg-blunder/10',
}

const SIZE = {
  // Both clear 44px of height including the border, which is what a thumb
  // needs. `sm` is for rows of controls, `md` for anything standing alone.
  sm: 'min-h-11 gap-1.5 px-3 text-body',
  md: 'min-h-11 gap-2 px-4 text-body',
  // Square, for a control whose icon is the whole label.
  icon: 'min-h-11 min-w-11 justify-center',
}

export default function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconEnd,
  to,
  href,
  className = '',
  children,
  ...rest
}) {
  const classes = [
    'inline-flex items-center rounded-lg transition-colors select-none',
    'disabled:pointer-events-none disabled:opacity-40',
    VARIANT[variant],
    SIZE[size],
    className,
  ].join(' ')

  const inner = (
    <>
      {icon && <Icon name={icon} size={size === 'icon' ? 20 : 16} />}
      {children}
      {iconEnd && <Icon name={iconEnd} size={16} />}
    </>
  )

  if (to) {
    return (
      <Link to={to} className={classes} {...rest}>
        {inner}
      </Link>
    )
  }
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={classes} {...rest}>
        {inner}
      </a>
    )
  }
  return (
    <button type="button" className={classes} {...rest}>
      {inner}
    </button>
  )
}
