import { type ReactNode } from 'react'
import { cx } from './cx'

// The one raised surface — a white card floating on the warm canvas (rounded-2xl, hairline border, soft
// shadow). Koda's core "floating" look; used for settings sections, message cards, panels. `divide`
// draws hairlines between direct children (rows), which needs `overflow-hidden` to clip them to the
// radius. `title` renders the small uppercase caption that sat above settings sections.

export function Card({
  title,
  divide = false,
  className,
  children,
}: {
  title?: ReactNode
  /** Hairline dividers between direct children — for row-stacked cards. */
  divide?: boolean
  className?: string
  children: ReactNode
}): React.JSX.Element {
  const card = (
    <div
      className={cx(
        'rounded-2xl border border-border bg-surface shadow-soft',
        divide && 'divide-y divide-border overflow-hidden',
        className,
      )}
    >
      {children}
    </div>
  )
  if (!title) return card
  return (
    <section>
      <h3 className="px-1 pb-2 font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        {title}
      </h3>
      {card}
    </section>
  )
}
