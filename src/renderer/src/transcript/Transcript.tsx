import { memo, useLayoutEffect, useRef, useState } from 'react'
import { motion, useReducedMotion, duration, ease } from '../motion'
import { Markdown } from '../output/Markdown'
import { AssistantMarkdown } from './AssistantMarkdown'
import { ToolCard } from './ToolCard'
import { QuestionCard } from './QuestionCard'
import { SubagentCard } from './SubagentCard'
import { UserMessage } from './UserMessage'
import { SystemNotice } from './SystemNotice'
import { CanvasEditChip } from './CanvasEditChip'
import { ThinkingIndicator } from './ThinkingIndicator'
import { TaskList } from './TaskList'
import { WorkflowCard } from './WorkflowCard'
import { PixelGlyph } from '../ui'
import type { Entry } from './types'

// The turn-item types live in ./types (pure, no runtime imports) so non-renderer consumers can reuse
// them. Re-exported here for the existing `from './Transcript'` import sites (store, useEngineBridge, …).
export type { Entry, TurnItem, SubagentChild, SubagentChildData, SubagentItem } from './types'

/**
 * The ordered transcript. Each turn-item knows how to render itself; the
 * AssistantMarkdown item also knows how to serialize-for-copy. The live streaming
 * buffer renders through the SAME Markdown path, so partial output is already
 * structured (not raw `**`), then the finalized AssistantBlock supersedes it.
 *
 * The `subagent` item (the design's 5th turn-item) is a nesting container: the
 * subagent's own prose + tool steps render as `children` UNDER its card, kept out
 * of the main flow. Built off the #24612 capture (spike/subagent/FINDINGS.md).
 */
/**
 * The plumbing rows (tool steps + the thinking line) are the agent's mechanical
 * work — left bare they float between prose paragraphs. We group every *run* of
 * consecutive plumbing items into one inset "well" so the actions read as a
 * contained unit, while prose stays bare narration. Subagent/workflow/tasklist
 * already carry their own container, so they break a run and render standalone.
 */
function isPlumbing(item: Entry): boolean {
  if (item.kind === 'thinking') return true
  // AskUserQuestion renders as a QuestionCard, not a tool row — keep it out of the well.
  if (item.kind === 'tool' && item.name !== 'AskUserQuestion') return true
  return false
}

type RenderNode =
  | { type: 'item'; entry: Entry }
  | { type: 'group'; key: string; entries: Entry[] }

type UserEntry = Extract<Entry, { kind: 'user' }>

/**
 * A turn = the user's message (its sticky header) + everything the agent did in response (its body).
 * Items before the first user message form a leading headerless turn (rare — a system notice on
 * resume). Consecutive plumbing items inside a body still collapse into one "well".
 */
type Turn = { id: number; header: UserEntry | null; body: RenderNode[] }

function toTurns(items: Entry[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn = { id: -1, header: null, body: [] }
  let run: Entry[] = []
  const flushRun = () => {
    if (run.length) {
      current.body.push({ type: 'group', key: `g${run[0].id}`, entries: run })
      run = []
    }
  }
  const closeTurn = () => {
    flushRun()
    if (current.header || current.body.length) turns.push(current)
  }
  items.forEach((item) => {
    // Each user message opens a fresh turn; it becomes the turn's pinned header.
    if (item.kind === 'user') {
      closeTurn()
      current = { id: item.id, header: item, body: [] }
      return
    }
    if (isPlumbing(item)) {
      run.push(item)
      return
    }
    flushRun()
    current.body.push({ type: 'item', entry: item })
  })
  closeTurn()
  return turns
}

// Memoized: the composer draft lives in the store, so every keystroke re-renders the parent surface.
// `setDraft` never touches `items`, so the shallow prop compare short-circuits a keystroke here instead
// of re-parsing the whole conversation's markdown + syntax highlighting each character.
export const Transcript = memo(function Transcript({
  items,
  streaming,
  working,
}: {
  items: Entry[]
  streaming: string
  /** A human one-liner of what a busy session is doing now ("Running a command", "Thinking…"), or
   *  null when nothing should show. Drives the trailing working indicator — the in-session answer to
   *  "is it working or stuck?" that the engine's reasoning stream can't be relied on to give (Codex
   *  barely streams reasoning deltas, so without this the surface goes blank between actions). */
  working?: string | null
}) {
  return (
    <div className="space-y-4">
      {toTurns(items).map((turn) => {
        // An empty body means the turn opened but nothing's landed yet — the agent is still thinking, so
        // only the trailing working indicator will show below. The scrim + body padding are sized to give
        // real response content room to scroll under the pin; with no content they just strand the
        // indicator far from the message. Collapse both so it sits close (the tool-well case, which does
        // have content, keeps the full spacing + its -mt-2.5 hug below).
        const bodyEmpty = turn.body.length === 0
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
            {turn.body.map((node) =>
              node.type === 'group' ? (
                <div
                  key={node.key}
                  className="rounded-[10px] border border-border bg-black/[0.02] px-2 py-1 dark:bg-white/[0.025]"
                >
                  {node.entries.map((entry) => (
                    <TurnItemView key={entry.id} item={entry} />
                  ))}
                </div>
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
      {/* The trailing indicator is the tail of the current turn's activity (the tool-call well right
          above it), not a new turn — pull it out of the full inter-turn `space-y-4` gap so it reads as
          a continuation rather than floating a turn-width below. */}
      {working && (
        <div className="-mt-2.5">
          <WorkingIndicator label={working} />
        </div>
      )}
    </div>
  )
})

/**
 * The trailing "agent is working" row — a quiet pulse + a one-liner of the current activity. Always
 * present while the turn runs (driven by the busy lifecycle, not the reasoning stream), so the surface
 * never looks stuck during a pause. Suppressed by the caller while streaming text (the caret carries
 * it) or while an active thinking line is already showing.
 */
function WorkingIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5 pl-0.5 text-[11px] text-text-muted" aria-live="polite">
      <PixelGlyph loader variant="diamond" size={12} className="text-accent" />
      <span className="italic">{label}</span>
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

function TurnItemView({ item }: { item: Entry }) {
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
      return <ToolCard name={item.name} input={item.input} result={item.result} isError={item.isError} />
    case 'subagent':
      return <SubagentCard item={item} />
    case 'thinking':
      return <ThinkingIndicator estimatedTokens={item.estimatedTokens} active={item.active} />
    case 'tasklist':
      return <TaskList tasks={item.tasks} />
    case 'workflow':
      return <WorkflowCard item={item} />
    case 'notice':
      return <SystemNotice text={item.text} />
    case 'canvas':
      return <CanvasEditChip docTitle={item.docTitle} instruction={item.instruction} />
  }
}
