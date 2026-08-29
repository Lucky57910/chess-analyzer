/**
 * The app's icon set, inline.
 *
 * It used to be emoji: ♞ in the title bar, ⏮ ◀ ▶ ⏭ ⇅ ♟ under the board. Emoji
 * are drawn by whichever font the device happens to have, at whichever weight
 * and colour that font decided, so the same row of controls is a different row
 * on every Android version — and the chess ones in particular render as a
 * black king on a black background on a good number of them.
 *
 * These are 24×24 stroke paths on a single grid, they take their colour from
 * `currentColor`, and they scale with the text around them. Inline rather than
 * a package: an icon library is a dependency and a bundle for the fifteen
 * glyphs this app draws.
 *
 * Geometry follows Lucide (ISC), redrawn on the same 24-unit grid.
 */

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5M9.5 21v-6h5v6',
  games: 'M4 5h16M4 12h16M4 19h16',
  stats: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a1.9 1.9 0 1 1-2.7 2.7l-.05-.06a1.6 1.6 0 0 0-1.78-.32 1.6 1.6 0 0 0-.97 1.46V21a1.9 1.9 0 1 1-3.8 0v-.1a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a1.9 1.9 0 1 1-2.7-2.7l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.46-.98H3a1.9 1.9 0 1 1 0-3.8h.1a1.6 1.6 0 0 0 1.46-1.04 1.6 1.6 0 0 0-.32-1.78l-.06-.06a1.9 1.9 0 1 1 2.7-2.7l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 .97-1.46V3a1.9 1.9 0 1 1 3.8 0v.1a1.6 1.6 0 0 0 .98 1.46 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.9 1.9 0 1 1 2.7 2.7l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.46.97H21a1.9 1.9 0 1 1 0 3.8h-.1a1.6 1.6 0 0 0-1.46.98Z',

  first: 'M18.5 19 8 12l10.5-7v14ZM5.5 5v14',
  previous: 'M15 19 8 12l7-7',
  next: 'M9 5l7 7-7 7',
  last: 'M5.5 5 16 12 5.5 19V5ZM18.5 5v14',
  play: 'M6 4.5 19 12 6 19.5v-15Z',
  pause: 'M9 5v14M15 5v14',
  flip: 'M7 3 4 6l3 3M4 6h11a4 4 0 0 1 4 4v1M17 21l3-3-3-3M20 18H9a4 4 0 0 1-4-4v-1',
  spar: 'M14.5 17.5 21 11l-3-3-6.5 6.5M9.5 6.5 3 13l3 3 6.5-6.5M14 3h7v7M3 21h7',
  hint: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5.9 1.2.9 1.9v.2h5.2v-.2c0-.7.3-1.4.9-1.9A6 6 0 0 0 12 3Z',

  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16v-4.5M12 8h.01',
  close: 'M18 6 6 18M6 6l12 12',
  back: 'M19 12H5M12 19l-7-7 7-7',
  external: 'M15 3h6v6M10 14 21 3M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  chevronDown: 'M6 9.5l6 6 6-6',
  chevronUp: 'M6 14.5l6-6 6 6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35',
  coach: 'M12 3l1.8 4.1L18 8.9l-4.2 1.8L12 15l-1.8-4.3L6 8.9l4.2-1.8L12 3ZM18.5 15l.8 1.8 1.7.7-1.7.7-.8 1.8-.8-1.8-1.7-.7 1.7-.7.8-1.8ZM5 14l.7 1.6 1.6.7-1.6.7L5 18.6l-.7-1.6-1.6-.7 1.6-.7L5 14Z',
  warning: 'M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01',
  check: 'M20 6 9 17l-5-5',
  knight:
    'M8 21h9M9 21c0-3 1-4.5 3.5-6 2-1.2 2.5-2.5 2.5-4 0-1-.5-1.8-1.5-2l-1 1.6-2-1L11 5l1.2-2H10L7.5 6.2 6 8.2c-.4.6-.2 1.3.4 1.6l1.6.7-1 2.5c-.6 1.5-.5 3 .5 4.3.7.9 1 2 1 3.7Z',
}

/** Paths with an area that should be filled rather than stroked. */
const FILLED = new Set(['play', 'first', 'last', 'knight'])

export default function Icon({ name, size = 20, className = '', title, ...rest }) {
  const d = PATHS[name]
  if (!d) return null
  const filled = FILLED.has(name)
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 1 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      // Decorative unless it is the only thing naming its control, in which
      // case the caller passes a title and it becomes an image with a name.
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  )
}
