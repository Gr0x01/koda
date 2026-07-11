import { type ReactNode } from 'react'
import { cx } from './cx'

// The one inline notice — a tinted, hairline-bordered box for a warning/caution that lives in the flow
// (billing traps, plan limits, irreversible-action heads-ups). Tone sets the hue; the shape is fixed so
// every caution in the app reads the same. Not for toasts or modals — this is an in-place banner.

type AlertTone = 'warning' | 'danger' | 'info' | 'success'

const TONE: Record<AlertTone, string> = {
  warning: 'border-amber-500/30 bg-amber-500/5 text-text',
  danger: 'border-red-500/30 bg-red-500/5 text-text',
  info: 'border-accent/30 bg-accent/5 text-text',
  success: 'border-emerald-500/30 bg-emerald-500/5 text-text',
}

export function Alert({
  tone = 'warning',
  title,
  className,
  children,
}: {
  tone?: AlertTone
  title?: ReactNode
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      role="note"
      className={cx('rounded-lg border px-3 py-2 text-[12.5px] leading-snug', TONE[tone], className)}
    >
      {title && <div className="mb-0.5 font-medium">{title}</div>}
      {children}
    </div>
  )
}
