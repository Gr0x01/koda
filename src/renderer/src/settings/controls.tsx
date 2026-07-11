import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Menu, motion, spring } from '../motion'
import { Caret } from '../Caret'
import { previewPalette, type ThemeDef } from '../themes'
import { Card } from '../ui'

/**
 * Settings primitives — the small, reused vocabulary the whole Settings pane is built from (the Cursor
 * IA pattern: sectioned cards of label+description rows with a control on the right), rendered in
 * Koda's floating language (warm canvas, white raised cards, ink accent). Declarative on purpose: a
 * new category is just data plugged into these.
 */

// SettingsSection is now a thin wrapper around the shared Card primitive (title + divide hairlines).
// Kept here so existing import sites don't all need updating at once.
export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card title={title} divide>
      {children}
    </Card>
  )
}

/** One setting: label + optional description on the left, its control on the right. `control` is the
 *  interactive element; pass plain text via `control` too for read-only rows (About). */
export function SettingsRow({
  label,
  description,
  control,
}: {
  label: string
  description?: ReactNode
  control?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-text">{label}</div>
        {description && (
          <div className="mt-0.5 text-[12.5px] leading-snug text-text-muted">{description}</div>
        )}
      </div>
      {control && <div className="shrink-0">{control}</div>}
    </div>
  )
}

/** An on/off switch. */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-border'
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

/** A row of preview swatches (canvas + card + accent + 3 syntax dots) for a theme picker entry. */
function ThemeSwatches({ def }: { def: ThemeDef }) {
  const p = previewPalette(def)
  const dots = [p.hljs.keyword, p.hljs.string, p.hljs.function]
  return (
    <span
      className="flex h-5 shrink-0 items-center gap-0.5 rounded-md border px-1"
      style={{ backgroundColor: p.bg, borderColor: p.border }}
    >
      <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: p.surface }} />
      <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: p.accent }} />
      {dots.map((c, i) => (
        <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c }} />
      ))}
    </span>
  )
}

/** A live mini-sample of a theme — app chrome (canvas + raised card + accent) over a short code
 *  snippet exercising the syntax roles. Lets a non-engineer SEE a pack before picking it. */
function ThemeSample({ def }: { def: ThemeDef }) {
  const p = previewPalette(def)
  return (
    <div className="rounded-lg p-2" style={{ backgroundColor: p.bg }}>
      <div className="rounded-md border p-2" style={{ backgroundColor: p.surface, borderColor: p.border }}>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px]" style={{ color: p.textMuted }}>
            conversation
          </span>
          <span
            className="rounded px-1.5 py-0.5 text-[9px] font-semibold text-white"
            style={{ backgroundColor: p.accent }}
          >
            Send
          </span>
        </div>
        <pre
          className="overflow-hidden rounded border px-2 py-1.5 font-mono text-[10px] leading-[1.5]"
          style={{ backgroundColor: p.bg, borderColor: p.border, color: p.text }}
        >
          <span style={{ color: p.hljs.comment }}>{'// greet'}</span>
          {'\n'}
          <span style={{ color: p.hljs.keyword }}>const</span> <span style={{ color: p.hljs.function }}>greet</span> = (
          <span style={{ color: p.hljs.variable }}>name</span>: <span style={{ color: p.hljs.type }}>string</span>) =&gt;{' '}
          <span style={{ color: p.hljs.string }}>{'`hi`'}</span>
          {'\n'}
          <span style={{ color: p.hljs.keyword }}>return</span> <span style={{ color: p.hljs.number }}>42</span>
        </pre>
      </div>
    </div>
  )
}

/** A dropdown that picks one theme from a list. Each row shows preview swatches; a live sample at the
 *  top of the open menu updates as you hover, so you see a pack before committing. Used for the paired
 *  Light-theme / Dark-theme pickers in Appearance (a SegmentedControl can't hold 6+ options). */
export function ThemeSelect({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string
  options: ThemeDef[]
  onChange: (id: string) => void
  ariaLabel: string
}) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState<string | null>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.id === value) ?? options[0]
  const previewed = options.find((o) => o.id === hover) ?? current

  // The menu is portaled to <body> to escape the Settings card's `overflow-hidden`, so it's positioned
  // `fixed` from the trigger's viewport rect — recomputed as the scrollable pane moves under it.
  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (r) setPos({ top: r.bottom + 6, right: window.innerWidth - r.right })
    }
    place()
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
    }
    window.addEventListener('scroll', place, true) // capture → also catches the inner scroll container
    window.addEventListener('resize', place)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-52 items-center gap-2 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[12.5px] font-medium text-text transition-colors hover:bg-surface"
      >
        {current && <ThemeSwatches def={current} />}
        <span className="truncate">{current?.label}</span>
        <Caret className="ml-auto text-text-muted" />
      </button>

      {pos &&
        createPortal(
          <Menu
            open={open}
            onClose={() => setOpen(false)}
            origin="origin-top-right"
            className="fixed z-50 max-h-[70vh] w-56 overflow-y-auto rounded-lg border border-border bg-surface shadow-pop"
            style={{ top: pos.top, right: pos.right }}
          >
            <div ref={menuRef}>
              {previewed && (
                <div className="border-b border-border p-1.5">
                  <ThemeSample def={previewed} />
                </div>
              )}
              <div className="py-1" onMouseLeave={() => setHover(null)}>
                {options.map((o) => {
                  const active = o.id === value
                  return (
                    <button
                      key={o.id}
                      role="option"
                      aria-selected={active}
                      onMouseEnter={() => setHover(o.id)}
                      onClick={() => {
                        onChange(o.id)
                        setOpen(false)
                      }}
                      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                        active ? 'bg-accent/10 text-accent' : 'text-text hover:bg-bg'
                      }`}
                    >
                      <ThemeSwatches def={o} />
                      <span className="truncate font-medium">{o.label}</span>
                      <span className="ml-auto w-3 shrink-0 text-accent">{active ? '✓' : ''}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </Menu>,
          document.body,
        )}
    </>
  )
}

/** A segmented pick-one control (theme, scope, default approval tier). A white chip SLIDES between
 *  options (shared with the sidebar Docs/Files toggle) — not a blue fill. Each instance gets its own
 *  `layoutId` so chips never animate across separate controls on the same page. */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  fill = false,
}: {
  value: T
  options: { value: T; label: string; title?: string }[]
  onChange: (next: T) => void
  ariaLabel: string
  /** Stretch the segments to equal widths across the full container (vs. sizing to their labels). */
  fill?: boolean
}) {
  const layoutId = useId()
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`items-center gap-px rounded-lg bg-text/5 p-0.5 ${fill ? 'flex w-full' : 'inline-flex'}`}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`relative rounded-md px-3 py-1 text-[12.5px] font-medium transition-colors ${
              fill ? 'flex-1 text-center' : ''
            } ${active ? 'text-text' : 'text-text-muted hover:text-text'}`}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-md bg-surface shadow-soft"
                transition={spring.snappy}
              />
            )}
            <span className="relative z-10">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
