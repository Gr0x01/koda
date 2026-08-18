import { memo, useEffect, useRef, type ReactNode } from 'react'
import { Caret } from '../Caret'
import { PixelGlyph } from '../ui'
import { ToolCard } from './ToolCard'
import { ThinkingIndicator } from './ThinkingIndicator'
import { runSummary } from './step-summary'
import { formatDuration } from './folding'
import type { Entry } from './types'

/**
 * The agent's work, as ONE object.
 *
 * A conversation is speech; the tools are how the speech got made. Rendered as a stack of rows they
 * read as broken prose — same left edge, same weight, no shape — and a ten-step turn buries the answer
 * in plumbing. So a run of steps is a single strip you can open, never a list you have to scroll past:
 * one work object between two paragraphs, whatever it took.
 *
 * Three faces, one shape, so the eye learns it once:
 *   · live      — a pulsing glyph, what it's doing now, and a ticking clock
 *   · shut      — how many steps, and the newest one
 *   · open      — a panel of the real rows, each with its own detail behind it
 */

/** One material for work, shut or open — opening a strip should not change what it's made of. */
const SUNK = 'bg-black/[0.03] dark:bg-white/[0.04]'

/**
 * The shape itself: a full-width strip that reads as a control, not a line of text. Also worn by the
 * settled turn's "Worked for 2m 14s" door, which is the same promise at turn scale.
 */
export function WorkStrip({
  glyph,
  lead,
  detail,
  meta,
  expanded,
  trailing,
  label,
  onToggle,
}: {
  glyph: ReactNode
  lead: string
  /** The mono half — a command, a path. Truncates; the strip is a label, not the output. */
  detail?: string
  meta?: ReactNode
  /** Omitted when the strip does not open in place — a strip that navigates is not a disclosure, and
   *  claiming aria-expanded on it tells a screen reader to wait for something that never appears. */
  expanded?: boolean
  /** Replaces the caret for a strip that goes somewhere instead of opening ("Open Agents ▸"). */
  trailing?: ReactNode
  /** Spoken name, when the visible lead is not the whole story. */
  label?: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={label}
      className={`group flex w-full items-center gap-2.5 rounded-lg border border-transparent ${SUNK} px-2.5 py-1.5 text-left text-[11px] text-text-muted transition-colors hover:border-border hover:bg-black/[0.05] hover:text-text dark:hover:bg-white/[0.06]`}
    >
      <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">{glyph}</span>
      <span className="shrink-0">{lead}</span>
      {detail && <span className="truncate font-mono text-[11.5px] opacity-70">{detail}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {meta}
        {trailing ?? <Caret dir={expanded ? 'up' : 'down'} size={12} className="opacity-50" />}
      </span>
    </button>
  )
}

/** The quiet marker on work that is over — shared by a shut run and a settled fan-out. */
export function RestDot() {
  return <span className="h-1.5 w-1.5 rounded-full bg-current opacity-45" />
}

/**
 * "· 1m 12s", ticking. It writes its own text node on an interval instead of setting state: a second is
 * a long time to a streaming turn, and a re-render here would re-render the transcript under it once a
 * second for the life of every turn.
 */
export function ElapsedLabel({ startedAt }: { startedAt: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const tick = (): void => {
      if (ref.current) ref.current.textContent = formatDuration(Date.now() - startedAt)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [startedAt])
  return <span ref={ref} className="tabular-nums opacity-70">{formatDuration(Date.now() - startedAt)}</span>
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** One row inside an open work object. Tools keep their own drawer; thinking is a line. */
const StepRow = memo(function StepRow({ item }: { item: Entry }) {
  if (item.kind === 'thinking') return <ThinkingIndicator estimatedTokens={item.estimatedTokens} active={item.active} />
  if (item.kind === 'tool')
    return (
      <ToolCard
        name={item.name}
        input={item.input}
        liveOutput={item.liveOutput}
        result={item.result}
        isError={item.isError}
      />
    )
  return null
})

export const StepRun = memo(function StepRun({
  runKey,
  entries,
  collapsed,
  expanded,
  live,
  working,
  startedAt,
  onToggle,
}: {
  /** This run's transcript-local identity, handed back on toggle so the caller's handler stays stable. */
  runKey: string
  entries: Entry[]
  collapsed: boolean
  expanded: boolean
  live: boolean
  /** What the session says it is doing ("Running a command") — the live strip's own words. */
  working?: string | null
  /** When the running turn started, for the ticking readout. */
  startedAt?: number
  onToggle: (key: string) => void
}) {
  const toggle = (): void => onToggle(runKey)
  const summary = runSummary(entries)
  const rows = (
    <div className="space-y-px py-1">
      {entries.map((entry) => (
        <StepRow key={entry.id} item={entry} />
      ))}
    </div>
  )

  // Already inside the settled turn's fold: the reader opened the work, so opening it again to see it
  // is a door onto a door. Rows sit in the panel with nothing to click.
  if (!collapsed) return <div className={`rounded-lg border border-border/70 px-2 ${SUNK}`}>{rows}</div>

  if (!expanded)
    return (
      <WorkStrip
        glyph={live ? <PixelGlyph loader variant="diamond" size={12} className="text-accent" /> : <RestDot />}
        lead={live ? (working ?? 'Working') : plural(entries.length, 'step')}
        detail={summary.name ? `${summary.name.toLowerCase()}${summary.detail ? ` · ${summary.detail}` : ''}` : undefined}
        meta={live && startedAt !== undefined ? <ElapsedLabel startedAt={startedAt} /> : undefined}
        expanded={false}
        onToggle={toggle}
      />
    )

  return (
    <div className={`overflow-hidden rounded-lg border border-border/70 ${SUNK}`}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded
        className="flex w-full items-center gap-2.5 border-b border-border/50 px-2.5 py-1.5 text-left text-[11px] text-text-muted transition-colors hover:text-text"
      >
        <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
          {live ? <PixelGlyph loader variant="diamond" size={12} className="text-accent" /> : <RestDot />}
        </span>
        <span>{plural(entries.length, 'step')}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {live && startedAt !== undefined && <ElapsedLabel startedAt={startedAt} />}
          <Caret dir="up" size={12} className="opacity-50" />
        </span>
      </button>
      <div className="px-2">{rows}</div>
    </div>
  )
})
