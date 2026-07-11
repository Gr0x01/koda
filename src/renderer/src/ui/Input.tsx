import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx'

// The one text input. The repeated shape was a hairline field on the canvas that borders-accent on
// focus; code/keys render mono while the placeholder stays sans so it reads as a prompt, not a value.
// `mono` toggles that (default on — most inputs here take codes/paths/keys). Native <input> props pass
// through; `Field` wraps it with a label + description + error for form rows.

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  /** Render the typed value in the mono face (codes, paths, keys). Default true. */
  mono?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { mono = true, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx(
        'w-full rounded-lg border border-border bg-bg px-3 py-2 text-[12.5px] text-text',
        'placeholder:text-text-muted/60 focus:border-accent focus:outline-none',
        mono ? 'font-mono placeholder:font-sans' : '',
        className,
      )}
      {...rest}
    />
  )
})

// A labelled form row: caption + optional description above the control, optional error below. `children`
// is the control (an Input, a select, whatever), so the label/error chrome is shared without the field
// dictating what sits inside it.
export function Field({
  label,
  description,
  error,
  htmlFor,
  className,
  children,
}: {
  label?: ReactNode
  description?: ReactNode
  error?: ReactNode
  htmlFor?: string
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-text">
          {label}
        </label>
      )}
      {description && <div className="text-[12px] leading-snug text-text-muted">{description}</div>}
      {children}
      {error && <div className="text-[12px] text-red-500">{error}</div>}
    </div>
  )
}
