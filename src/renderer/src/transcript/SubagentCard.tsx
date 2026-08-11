import { useEffect, useState } from 'react'
import type { SubagentItem } from './types'
import { Collapse } from '../motion'
import { Caret } from '../Caret'
import { AssistantMarkdown } from './AssistantMarkdown'
import { ToolCard } from './ToolCard'

/**
 * A subagent's work, nested. The main agent fanned a task out to a subagent; this
 * card holds the subagent's own prose + tool steps (its `children`) so they read as
 * a contained sub-thread, not loose noise in the main transcript. A thin neutral
 * left rule signals the nesting (the accent label carries the subagent identity);
 * the header carries live status + rolling token/time counters.
 *
 * Expanded by default — the point of the pillar is that the user CAN watch what a
 * subagent did (scrollback, per the roadmap), one click from collapsing it away.
 */
const STALL_MS = 10 * 60 * 1000

export function SubagentCard({ item, onStop }: { item: SubagentItem; onStop?: (taskId: string) => void }) {
  const [open, setOpen] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const running = item.status === 'running'
  const stopping = running && item.stopRequested === true
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [running])
  const stalled = running && item.lastActivityAt != null && now - item.lastActivityAt >= STALL_MS
  // Live: the progress one-liner / current tool. At rest: the stable task description.
  const status = running
    ? stopping
      ? 'Stopping…'
      : stalled
      ? 'No activity for 10 minutes'
      : item.liveStatus ?? item.lastToolName ?? (item.description || 'working…')
    : item.status === 'interrupted'
      ? 'Stopped'
      : item.status === 'unknown'
        ? 'Status unknown after restart'
        : item.description

  const stateIcon = running
    ? '●'
    : item.status === 'unknown'
      ? '?'
      : item.status === 'interrupted'
        ? '■'
        : item.isError
          ? '✗'
          : '✓'
  const stateClass = running
    ? stalled
      ? 'text-amber-500'
      : 'animate-pulse text-accent'
    : item.isError
      ? 'text-red-400'
      : 'text-text-muted'

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border bg-surface shadow-soft">
      <div className="flex w-full items-center border-l-2 border-border text-xs">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left"
        >
          <span className="shrink-0 font-mono text-[11px] font-semibold uppercase tracking-wide text-accent">
            {item.subagentType}
          </span>
          <span className="truncate text-text-muted">{status}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2.5 font-mono text-[11px] text-text-muted">
            {item.usage?.totalTokens != null && <span>{fmtTokens(item.usage.totalTokens)}</span>}
            {item.usage?.durationMs != null && <span>{(item.usage.durationMs / 1000).toFixed(1)}s</span>}
            <span className={stateClass}>{stateIcon}</span>
            <Caret dir={open ? 'down' : 'right'} className="text-text-muted/50" />
          </span>
        </button>
        {running && item.taskId && onStop && (
          <button
            type="button"
            onClick={() => onStop(item.taskId!)}
            disabled={stopping}
            className="mr-2 min-h-11 rounded-md px-2.5 text-[11px] text-text-muted transition-colors hover:bg-bg hover:text-text disabled:opacity-60"
            aria-label={`Stop ${item.description || item.subagentType}`}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>

      <Collapse open={open}>
        {/* Click the body to fold the card away — an expanded Explore card can run taller than the
            viewport, and hunting back up to the header chevron to close it is the pain point. Guarded
            so real interactions survive: nested tool rows / links (button, a), selectable code (pre),
            and an in-progress text selection all pass through untouched. */}
        <div
          onClick={(e) => {
            if (window.getSelection()?.toString()) return
            if ((e.target as HTMLElement).closest('button, a, pre, input, textarea')) return
            setOpen(false)
          }}
          className="cursor-pointer space-y-3 border-t border-l-2 border-border px-4 py-3">
          {item.prompt && (
            <p className="border-l-2 border-border pl-2 text-xs italic text-text-muted">{item.prompt}</p>
          )}
          {item.children.length === 0 && running && (
            <p className="text-xs text-text-muted">Starting…</p>
          )}
          {item.children.map((c) =>
            c.kind === 'assistant' ? (
              <AssistantMarkdown key={c.id} markdown={c.markdown} />
            ) : (
              <ToolCard key={c.id} name={c.name} input={c.input} liveOutput={c.liveOutput} result={c.result} isError={c.isError} />
            ),
          )}
          {item.resultText && (
            <div className="rounded-lg border-t border-border bg-bg px-3 py-2">
              <AssistantMarkdown markdown={item.resultText} />
            </div>
          )}
        </div>
      </Collapse>
    </div>
  )
}

/** Compact token count: 11549 → "11.5k". */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
