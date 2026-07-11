// The one caret in the app. Every dropdown chevron, disclosure triangle, and tree twisty routes
// through here so they share a size, weight, and rotation — before this, carets were hand-rolled a
// dozen different ways (SVG at 10/11px, Unicode ▾/▸/▴ at text sizes) and drifted apart visibly.
//
// One glyph (a down chevron) rotated per `dir`, with transition-transform baked in so a disclosure
// caret that flips its `dir` animates for free. Stroke is currentColor — callers set colour/margin
// through `className`.
type CaretDir = 'down' | 'up' | 'left' | 'right'

const ROTATION: Record<CaretDir, string> = {
  down: '',
  up: 'rotate-180',
  right: '-rotate-90',
  left: 'rotate-90',
}

export function Caret({
  dir = 'down',
  size = 14,
  className = '',
}: {
  dir?: CaretDir
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 transition-transform ${ROTATION[dir]} ${className}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
