import { useLayoutEffect, useRef, useState } from 'react'
import { motion, spring } from '../motion'
import { cx } from './cx'

export interface SegmentedOption<V extends string> {
  value: V
  label: string
  /** Optional hover tooltip per cell (e.g. the ⌘\ hint on App⇄Workshop). */
  title?: string
}

/**
 * The one segmented mode-switch (Docs⇄Files, App⇄Workshop): a `bg-text/5` trough with a ring-edged
 * surface chip that SLIDES to the active cell, active label in full-strength ink. A mode-switch
 * *looks* like a mode-switch — distinct from action buttons beside it, which open/create.
 *
 * The chip slides via a single indicator measured from each button's offset WITHIN the trough
 * (x/width), NOT a shared `layoutId`. A layout-animated chip re-measures against the whole tree and
 * springs vertically every frame an ancestor resizes (the Sessions⇆Files drag jitter bug). Button
 * offsets inside the trough don't change on that resize, so the indicator stays put; it only animates
 * when the active cell actually changes.
 */
export function Segmented<V extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
  className,
}: {
  options: readonly SegmentedOption<V>[]
  value: V
  onChange: (value: V) => void
  'aria-label'?: string
  className?: string
}) {
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const troughRef = useRef<HTMLDivElement>(null)
  const [chip, setChip] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  // Re-measure only when the active cell changes or the trough's own box does (font swap — the trough
  // is content-sized, so ancestor resizes don't move the cells).
  useLayoutEffect(() => {
    const measure = () => {
      const btn = btnRefs.current[value]
      if (btn) setChip({ x: btn.offsetLeft, y: btn.offsetTop, w: btn.offsetWidth, h: btn.offsetHeight })
    }
    measure()
    const el = troughRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [value])

  return (
    <div
      ref={troughRef}
      aria-label={ariaLabel}
      className={cx('relative flex items-center gap-px rounded-lg bg-text/5 p-0.5', className)}
    >
      {/* Ring edge (lighter than both trough and fill) so the active cell reads as a filled segment on
          dark too — plain bg-surface sits darker than the light-overlay trough there and recedes (the
          old "button mashup" look). The ring alone does it; no drop shadow needed. */}
      {chip && (
        <motion.span
          aria-hidden
          initial={false}
          animate={{ x: chip.x, y: chip.y, width: chip.w, height: chip.h }}
          transition={spring.snappy}
          className="pointer-events-none absolute left-0 top-0 rounded-md bg-surface ring-1 ring-border"
        />
      )}
      {options.map(({ value: v, label, title }) => (
        <button
          key={v}
          ref={(el) => {
            btnRefs.current[v] = el
          }}
          onClick={() => onChange(v)}
          aria-pressed={v === value}
          title={title}
          className={`relative z-10 rounded-md px-2.5 py-0.5 font-display text-[11px] font-medium transition-colors ${
            v === value ? 'text-text' : 'text-text-muted hover:text-text'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
