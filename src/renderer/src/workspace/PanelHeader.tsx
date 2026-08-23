import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

/**
 * The shared header bar atop every left panel/nav (Sessions, Files, Source Control, Settings) — one
 * height, padding, and caps-label treatment so the panels read as one family instead of three
 * one-off designs. The right slot holds that panel's actions (new-session, branch chip, etc.).
 *
 * `title` overrides the caps-label with a custom node — for a panel whose header is itself a control
 * (the Documents ⇄ Files segmented switch) rather than a static label.
 */
export function PanelHeader({ label, title, children }: { label?: string; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-3">
      {title ?? (
        <h2 className="font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {label}
        </h2>
      )}
      {children}
    </div>
  )
}

/** Icon-only action for a panel heading. Kept beside `PanelHeader` so headings can move their own
 * actions without re-declaring this shape. It deliberately has no native `title=`: callers wrap it in
 * `HoverCard`, which gives the action one consistent, keyboard-reachable disclosure. */
export const PanelHeaderIconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(function PanelHeaderIconButton({ children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted outline-none transition-colors hover:bg-surface hover:text-text focus-visible:bg-surface focus-visible:text-text"
      {...rest}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {children}
      </svg>
    </button>
  )
})
