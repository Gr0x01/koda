import type { ReactNode } from 'react'

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
