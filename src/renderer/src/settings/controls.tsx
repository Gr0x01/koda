import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Menu, motion, spring } from '../motion'
import { Caret } from '../Caret'
import { previewPalette, type ThemeDef } from '../themes'

/**
 * Settings primitives — the small, reused vocabulary the whole Settings pane is built from. One row
 * anatomy everywhere: a label, one sentence a non-engineer can act on, and the control that changes
 * it. Settings are a list of small decisions rather than a set of bounded objects, so nothing is
 * wrapped in a card: whitespace and type hierarchy do the grouping, and a border is spent only where
 * a genuinely bounded object needs an edge (a warning callout, a pairing panel, an inline editor).
 */

/** A group of settings: a caption, an optional sentence of context, and the rows themselves. */
export function SettingsSection({
  title,
  note,
  action,
  children,
}: {
  title: string
  /** Context the rows share, and the place for a caveat too long to sit in a row's one sentence. */
  note?: ReactNode
  /** One control that acts on the whole group rather than on any single row, placed beside the
   *  caption. Exists because an action that belongs to a LIST (reset every device, clear a log) has
   *  no honest row to hang on: parking it on an arbitrary member makes it read as scoped to that
   *  member, which is exactly how "Reset access" on one phone came to mean "reset all of them". */
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {title}
        </h3>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {note && <p className="mt-1.5 text-[12.5px] leading-snug text-text-muted">{note}</p>}
      <div className="mt-1.5">{children}</div>
    </section>
  )
}

/** One setting: label + one-sentence description on the left, its control on the right. `control` is
 *  the interactive element; pass plain text via `control` too for read-only rows (About). `children`
 *  is the row's own attached detail (progress, an error line, an inline form) and stays tied to the
 *  row it belongs to. */
export function SettingsRow({
  label,
  description,
  control,
  children,
}: {
  label: ReactNode
  description?: ReactNode
  control?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium text-text">{label}</div>
          {description && (
            <div className="mt-1 max-w-[58ch] text-[12.5px] leading-snug text-text-muted">
              {description}
            </div>
          )}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children && <div className="mt-2.5">{children}</div>}
    </div>
  )
}

/** A line of section-level prose: an empty state, a measured-facts footnote, a "sign in first" note.
 *  Same tone as a row description, without a control to hang it on. */
export function SettingsNote({ children }: { children: ReactNode }) {
  return <p className="py-3 text-[12.5px] leading-snug text-text-muted">{children}</p>
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

/** Shared lifecycle for Settings dropdowns portaled out of the scroll pane: one position rule, one
 *  outside-click rule, and one set of listeners. Option rendering and keyboard semantics stay with
 *  each picker because a theme preview and a compact text list have different contents. */
export function useAnchoredMenu() {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect) setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right })
    }
    place()
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return { open, setOpen, pos, triggerRef, menuRef }
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
  const [hover, setHover] = useState<string | null>(null)
  const { open, setOpen, pos, triggerRef, menuRef } = useAnchoredMenu()
  const current = options.find((o) => o.id === value) ?? options[0]
  const previewed = options.find((o) => o.id === hover) ?? current

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

/** Compact Settings dropdown for a labeled list whose options need one short line of context. It uses
 *  the shared animated Menu and the same body portal as ThemeSelect so the Settings scroll pane never
 *  clips it. */
export function SettingsSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: { value: T; label: string; hint?: string }[]
  onChange: (value: T) => void
  ariaLabel: string
}) {
  const [activeIndex, setActiveIndex] = useState(0)
  const { open, setOpen, pos, triggerRef, menuRef } = useAnchoredMenu()
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const current = options.find((option) => option.value === value) ?? options[0]
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )

  const showMenu = (index = selectedIndex): void => {
    setActiveIndex(index)
    setOpen(true)
  }

  const closeAndRestoreFocus = (): void => {
    setOpen(false)
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const choose = (index: number): void => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    setOpen(false)
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const moveFocus = (index: number): void => {
    const count = options.length
    if (count === 0) return
    setActiveIndex((index + count) % count)
  }

  // The list is portaled to <body>, so opening must move focus into it explicitly; otherwise Tab
  // follows document order into unrelated Settings controls. Roving tabindex then makes arrow-key
  // navigation visible to both the browser and assistive technology.
  useEffect(() => {
    if (!open || !pos) return
    const frame = window.requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [activeIndex, open, pos])

  return (
    <>
      <button
        ref={triggerRef}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) setOpen(false)
          else showMenu()
        }}
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          if (event.key === 'Home') showMenu(0)
          else if (event.key === 'End') showMenu(options.length - 1)
          else showMenu()
        }}
        className="flex w-52 items-center gap-2 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[12.5px] font-medium text-text transition-colors hover:bg-surface"
      >
        <span className="truncate">{current?.label}</span>
        <Caret className="ml-auto text-text-muted" />
      </button>

      {pos &&
        createPortal(
          <Menu
            open={open}
            onClose={closeAndRestoreFocus}
            origin="origin-top-right"
            className="fixed z-50 w-64 overflow-hidden rounded-lg border border-border bg-surface shadow-pop"
            style={{ top: pos.top, right: pos.right }}
          >
            <div ref={menuRef} role="listbox" aria-label={ariaLabel} className="py-1">
              {options.map((option, index) => {
                const active = option.value === value
                return (
                  <button
                    key={option.value}
                    ref={(node) => {
                      optionRefs.current[index] = node
                    }}
                    role="option"
                    aria-selected={active}
                    tabIndex={index === activeIndex ? 0 : -1}
                    onFocus={() => setActiveIndex(index)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        moveFocus(index + 1)
                      } else if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        moveFocus(index - 1)
                      } else if (event.key === 'Home') {
                        event.preventDefault()
                        moveFocus(0)
                      } else if (event.key === 'End') {
                        event.preventDefault()
                        moveFocus(options.length - 1)
                      } else if (event.key === 'Escape') {
                        // This menu lives inside Settings, whose window-level Escape shortcut closes
                        // the whole pane. Consume the key here so it dismisses only the open picker.
                        event.preventDefault()
                        event.stopPropagation()
                        event.nativeEvent.stopImmediatePropagation()
                        closeAndRestoreFocus()
                      } else if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        choose(index)
                      }
                    }}
                    onClick={() => choose(index)}
                    className={`flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors ${
                      active ? 'bg-accent/10 text-accent' : 'text-text hover:bg-bg'
                    }`}
                  >
                    <span className="w-3 shrink-0 text-[11px] text-accent">{active ? '✓' : ''}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-medium">{option.label}</span>
                      {option.hint && (
                        <span className="block truncate text-[10.5px] text-text-muted">{option.hint}</span>
                      )}
                    </span>
                  </button>
                )
              })}
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
