import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cx } from './cx'

// The one button in the app. Before this, the same three shapes were hand-written dozens of times with
// slightly drifting Tailwind strings: the ink-fill primary action (bg-accent/white), the hairline
// secondary (border + bg-bg), and the calm-until-hover danger. Callers pick a `variant` + `size`; every
// native <button> prop (onClick, disabled, type, aria-*) passes straight through.
//
// Colour lives in the variant, not the call site — restyle the whole app's actions by editing here.

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

const VARIANT: Record<ButtonVariant, string> = {
  // Ink-fill call-to-action. Dims on hover/disabled rather than shifting hue.
  primary: 'bg-accent text-white transition-opacity hover:opacity-90 disabled:opacity-40',
  // Hairline default — reads as a control, not a CTA. The old settings Button.
  secondary: 'border border-border bg-bg text-text transition-colors hover:bg-surface disabled:opacity-40',
  // Chromeless — text only at rest, for inline/tertiary actions. The tint arrives on approach: a
  // ghost with no resting fill keeps a list of them reading as a list rather than a wall of buttons,
  // while still answering the pointer like something you can press.
  ghost:
    'text-text-muted transition-colors hover:bg-text/[0.06] hover:text-text disabled:opacity-40 disabled:hover:bg-transparent',
  // A removal: neutral at rest, red only on approach, so intent shows without alarming.
  danger:
    'border border-border bg-bg text-text-muted transition-colors hover:border-red-500/40 hover:text-red-500',
}

// Rounding lives with the size (not the shared base) so `lg` can carry its larger `rounded-xl` without
// a concatenation conflict against a hardcoded `rounded-lg`.
const SIZE: Record<ButtonSize, string> = {
  sm: 'rounded-lg px-2.5 py-1 text-[12px]',
  md: 'rounded-lg px-3 py-1.5 text-[12.5px]',
  // The elevated hero CTA — onboarding "Get started", ProjectHome "New project". Bigger, softer-cornered,
  // and raised on a soft shadow; that lift is what marks it as the primary invitation on an empty screen.
  lg: 'rounded-xl px-5 py-2.5 text-sm shadow-soft',
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('font-medium disabled:cursor-not-allowed', SIZE[size], VARIANT[variant], className)}
      {...rest}
    />
  )
})
