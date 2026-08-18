import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion, duration, ease } from '../motion'
import { Markdown } from '../output/Markdown'
import { AssistantMarkdown } from './AssistantMarkdown'
import { ToolCard } from './ToolCard'
import { ElapsedLabel, StepRun, WorkStrip } from './StepRun'
import { QuestionCard } from './QuestionCard'
import { FleetRow } from './FleetRow'
import { UserMessage } from './UserMessage'
import { SystemNotice } from './SystemNotice'
import { CanvasEditChip } from './CanvasEditChip'
import { ThinkingIndicator } from './ThinkingIndicator'
import { TaskList } from './TaskList'
import { PixelGlyph } from '../ui'
import { buildTurns, formatDuration } from './folding'
import type { Entry } from './types'
import type { UserEntry } from './folding'

// The turn-item types live in ./types (pure, no runtime imports) so non-renderer consumers can reuse
// them. Re-exported here for the existing `from './Transcript'` import sites (store, useEngineBridge, …).
export type { Entry, TurnItem, SubagentChild, SubagentChildData, SubagentItem } from './types'

/**
 * The ordered transcript. Each turn-item knows how to render itself; the
 * AssistantMarkdown item also knows how to serialize-for-copy. The live streaming
 * buffer renders through the SAME Markdown path, so partial output is already
 * structured (not raw `**`), then the finalized AssistantBlock supersedes it.
 *
 * Delegated work (`subagent` and `workflow` items) never renders here. Folding collects a turn's
 * delegates into one FleetRow, and the roster it fronts lives on the Agents surface — so a fan-out
 * costs the conversation one line no matter how many agents run or how much they say.
 */
/**
 * What's shown vs folded lives in ./folding (pure + tested). This file renders the plan: the settled
 * turn's "Worked for 2m 14s" door, each run of plumbing as one work object (./StepRun), and a turn's
 * delegates as one row (./FleetRow).
 */
// Memoized: the composer draft lives in the store, so every keystroke re-renders the parent surface.
// `setDraft` never touches `items`, so the shallow prop compare short-circuits a keystroke here instead
// of re-parsing the whole conversation's markdown + syntax highlighting each character.
export const Transcript = memo(function Transcript({
  items,
  streaming,
  working,
  live,
  turnStartedAt,
  onOpenAgents,
}: {
  items: Entry[]
  streaming: string
  /** A human one-liner of what a busy session is doing now ("Running a command", "Thinking…"), or
   *  null when nothing should show. Drives the trailing working indicator — the in-session answer to
   *  "is it working or stuck?" that the engine's reasoning stream can't be relied on to give (Codex
   *  barely streams reasoning deltas, so without this the surface goes blank between actions). */
  working?: string | null
  /** The session's working posture. `working` can't stand in for it: it goes null while text streams
   *  and while an active thinking line is the tail, and a turn folding mid-stream would be a flicker. */
  live?: boolean
  /** When the running turn started, for the ticking elapsed readout beside the working line. */
  turnStartedAt?: number
  /** Opens the roster the fleet row fronts. The transcript never renders the roster itself: on the
   *  Mac this stages the Agents tab, on the phone it raises the Agents sheet. */
  onOpenAgents: () => void
}) {
  // Which folds the reader has opened. Ids are transcript-local, so a turn opened here says nothing
  // about any other session's turns.
  const [openTurns, setOpenTurns] = useState<ReadonlySet<number>>(() => new Set())
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = <T,>(set: (fn: (prev: ReadonlySet<T>) => ReadonlySet<T>) => void, key: T) =>
    set((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })
  // Stable across renders, so a work object's memo actually holds. An inline arrow per node would be
  // a fresh prop on every streamed event, re-rendering every run in the conversation to redraw one.
  const toggleRun = useCallback((key: string) => toggle(setOpenRuns, key), [])
  // Grouping walks every item, and `items` changes on every streamed event — during a fan-out that is
  // dozens a second against a growing conversation. Only re-walk when the inputs actually change.
  const turns = useMemo(
    () => buildTurns(items, { live, expandedTurns: openTurns, expandedRuns: openRuns }),
    [items, live, openTurns, openRuns]
  )
  // The live run's strip already says what the agent is doing, with the same words and the same clock.
  // The trailing line is for the gap before any of it lands — a turn that has opened and done nothing
  // yet — so it stands down the moment a work object is there to carry it.
  const lastBody = turns[turns.length - 1]?.body
  const tail = lastBody?.[lastBody.length - 1]
  const absorbed = tail?.type === 'group' && tail.live
  return (
    <div className="space-y-4">
      {turns.map((turn) => {
        // An empty body means the turn opened but nothing's landed yet — the agent is still thinking, so
        // only the trailing working indicator will show below. The scrim + body padding are sized to give
        // real response content room to scroll under the pin; with no content they just strand the
        // indicator far from the message. Collapse both so it sits close (a turn with content keeps the
        // full spacing + the indicator's -mt-2.5 hug below).
        const bodyEmpty = turn.body.length === 0 && !turn.fold
        return (
        <section key={turn.id}>
          {/* The user's message pins to the top while its response scrolls beneath (Cursor-style);
              scroll up past it and the previous turn's message takes the slot. bg-bg backing covers
              the scrolling content; z-10 keeps it above the body, below app overlays. */}
          {turn.header && (
            <div className="sticky top-0 z-10">
              <div className="-mx-4 bg-bg px-4 pt-1">
                <PinnedUserMessage item={turn.header} />
              </div>
              {/* Scrim: fade the solid header backing into the body scrolling beneath, so the pin
                  softens the content instead of cutting it with a hard line. */}
              <div className={`pointer-events-none -mx-4 bg-gradient-to-b from-bg to-transparent ${bodyEmpty ? 'h-2' : 'h-5'}`} />
            </div>
          )}
          <div className={`space-y-3 ${bodyEmpty ? '' : 'pt-3'}`}>
            {turn.fold && (
              <WorkStrip
                glyph={<TurnFoldDot />}
                lead={turn.fold.expanded ? 'Hide the work' : foldLabel(turn.fold.count, turn.fold.elapsedMs)}
                meta={
                  turn.fold.expanded || turn.fold.elapsedMs === undefined ? undefined : (
                    <span className="opacity-70">{plural(turn.fold.count, 'step')}</span>
                  )
                }
                expanded={turn.fold.expanded}
                onToggle={() => toggle(setOpenTurns, turn.id)}
              />
            )}
            {turn.body.map((node) =>
              node.type === 'fleet' ? (
                <FleetRow key={node.key} entries={node.entries} onOpen={onOpenAgents} />
              ) : node.type === 'group' ? (
                <StepRun
                  key={node.key}
                  runKey={node.key}
                  entries={node.entries}
                  collapsed={node.collapsed}
                  expanded={node.expanded}
                  live={node.live}
                  // Only the live run reads these, and they churn every step — handing them to a
                  // finished run would re-render the whole conversation's plumbing on every tool call.
                  working={node.live ? working : undefined}
                  startedAt={node.live ? turnStartedAt : undefined}
                  onToggle={toggleRun}
                />
              ) : (
                <div key={node.entry.id}>
                  <TurnItemView item={node.entry} />
                </div>
              )
            )}
          </div>
        </section>
        )
      })}
      {streaming && (
        <div className="opacity-90">
          <Markdown>{streaming}</Markdown>
          <span className="animate-pulse text-accent">▌</span>
        </div>
      )}
      {/* Only for the gap before the turn has done anything a work object could hold. Pulled out of the
          full inter-turn `space-y-4` gap so it reads as a continuation, not a turn floating below. */}
      {working && !absorbed && (
        <div className="-mt-2.5">
          <WorkingIndicator label={working} startedAt={turnStartedAt} />
        </div>
      )}
    </div>
  )
})

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** How long it took, when Koda timed the turn; how much it did, when it didn't (older transcripts). */
function foldLabel(count: number, elapsedMs?: number): string {
  return elapsedMs === undefined ? `Worked · ${plural(count, 'step')}` : `Worked for ${formatDuration(elapsedMs)}`
}

/** The settled turn's door wears the same strip as a run, so folded work reads as one thing everywhere. */
function TurnFoldDot() {
  return <span className="h-1.5 w-1.5 rounded-full bg-current opacity-45" />
}

/**
 * The trailing "agent is working" row — a quiet pulse + a one-liner of the current activity. Always
 * present while the turn runs (driven by the busy lifecycle, not the reasoning stream), so the surface
 * never looks stuck during a pause. Suppressed by the caller while streaming text (the caret carries
 * it) or while an active thinking line is already showing.
 */
function WorkingIndicator({ label, startedAt }: { label: string; startedAt?: number }) {
  return (
    <div className="flex items-center gap-2 py-0.5 pl-0.5 text-[11px] text-text-muted" aria-live="polite">
      <PixelGlyph loader variant="diamond" size={12} className="text-accent" />
      <span className="italic">{label}</span>
      {startedAt !== undefined && (
        <span className="opacity-70">
          · <ElapsedLabel startedAt={startedAt} />
        </span>
      )}
    </div>
  )
}

/**
 * The pinned turn header — your message in a raised card (echoing the composer). A long message is
 * clamped to a few lines with a fade so the pin never eats the viewport; the fade only appears when
 * the content actually overflows (measured), so short messages render flush. When it overflows, an
 * expand toggle animates it open in place (up to 60vh, then scrolls) so you can re-read the full turn.
 */
function PinnedUserMessage({ item }: { item: UserEntry }) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflowed, setOverflowed] = useState(false)
  const [natural, setNatural] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const reduce = useReducedMotion()
  useLayoutEffect(() => {
    // Measure only while collapsed: the clamp hides the overflow, but scrollHeight still reports the
    // full content height — that's both the overflow test and the pixel target the expand animates to.
    // (Skipping while expanded also keeps `overflowed` latched so the collapse toggle stays available.)
    if (expanded) return
    const el = ref.current
    if (!el) return
    const check = (): void => {
      setNatural(el.scrollHeight)
      setOverflowed(el.scrollHeight > el.clientHeight + 1)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [item.text, item.images, item.files, expanded])
  // Animate maxHeight in px (not between rem/vh, which don't interpolate). Collapsed caps at 5rem;
  // expanded grows to the content height, itself capped at 60vh so a huge turn scrolls instead of
  // swallowing the viewport.
  const cap = Math.round(window.innerHeight * 0.6)
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-surface shadow-soft">
      <motion.div
        ref={ref}
        initial={false}
        animate={{ maxHeight: expanded ? Math.min(natural, cap) : 80 }}
        transition={reduce ? { duration: 0 } : { duration: duration.slow, ease: ease.inOut }}
        style={{ overflowY: expanded && natural > cap ? 'auto' : 'hidden' }}
        className="px-3 py-2"
      >
        <UserMessage text={item.text} images={item.images} files={item.files} />
      </motion.div>
      {overflowed && !expanded && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-surface to-transparent" />
      )}
      {overflowed && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center text-text-muted transition-colors hover:text-text"
          aria-label={expanded ? 'Collapse message' : 'Show full message'}
          title={expanded ? 'Collapse' : 'Show full message'}
        >
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            {expanded ? (
              // minimize — arrows pulling in toward the corners
              <>
                <path d="M4 14h6v6" />
                <path d="M20 10h-6V4" />
                <path d="M14 10l7-7" />
                <path d="M3 21l7-7" />
              </>
            ) : (
              // maximize — arrows pushing out to the corners
              <>
                <path d="M15 3h6v6" />
                <path d="M9 21H3v-6" />
                <path d="M21 3l-7 7" />
                <path d="M3 21l7-7" />
              </>
            )}
          </svg>
        </button>
      )}
    </div>
  )
}

/**
 * Memoized on the entry. The store's patches keep object identity for every item they didn't touch,
 * so a single streamed event re-renders only the item it landed on instead of the entire transcript.
 */
const TurnItemView = memo(function TurnItemView({ item }: { item: Entry }) {
  switch (item.kind) {
    case 'user':
      return <UserMessage text={item.text} images={item.images} files={item.files} />
    case 'assistant':
      return <AssistantMarkdown markdown={item.markdown} />
    case 'tool':
      // AskUserQuestion isn't a tool to "run" — it's a question. Render its options (answered through
      // the permission gate as the tool's `answers` input), not a generic tool row.
      if (item.name === 'AskUserQuestion')
        return (
          <QuestionCard
            toolUseId={item.toolUseId}
            input={item.input}
            result={item.result}
            isError={item.isError}
          />
        )
      return <ToolCard name={item.name} input={item.input} liveOutput={item.liveOutput} result={item.result} isError={item.isError} />
    case 'thinking':
      return <ThinkingIndicator estimatedTokens={item.estimatedTokens} active={item.active} />
    case 'tasklist':
      return <TaskList tasks={item.tasks} />
    case 'notice':
      return <SystemNotice text={item.text} />
    case 'canvas':
      return <CanvasEditChip docTitle={item.docTitle} instruction={item.instruction} selectedWords={item.selectedWords} />
  }
})
