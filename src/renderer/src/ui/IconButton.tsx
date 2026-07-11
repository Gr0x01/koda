import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx'

// An icon-only button — the small square, chromeless-until-hover control used in headers and toolbars
// (close, back, refresh, expand). `label` is required and becomes the aria-label, since there's no text.
// Pass the glyph (an svg or Caret) as children.

type IconButtonSize = 'sm' | 'md'

const SIZE: Record<IconButtonSize, string> = {
  sm: 'h-6 w-6',
  md: 'h-7 w-7',
}

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  label: string
  size?: IconButtonSize
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', className, type = 'button', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors',
        'hover:bg-text/5 hover:text-text disabled:opacity-40 disabled:hover:bg-transparent',
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})
