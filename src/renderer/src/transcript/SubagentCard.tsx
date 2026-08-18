import { memo, useEffect, useState } from 'react'
import type { SubagentItem } from './types'
import { Collapse } from '../motion'
import { Caret } from '../Caret'
import { AssistantMarkdown } from './AssistantMarkdown'
import { ToolCard } from './ToolCard'
import {
  fmtTokens,
  humanizeAgentLabel,
  SUBAGENT_STALL_MS,
  subagentActivity,
  subagentToolCount,
} from './fleet'
import { formatDuration } from './folding'
import { IconButton, PixelGlyph } from '../ui'

type SubagentPresentation = 'card' | 'roster'

type SubagentCardProps = {
  item: SubagentItem
  onStop?: (taskId: string) => void
  /** Desktop Agents uses a quiet roster row. The default preserves the phone/transcript card. */
  presentation?: SubagentPresentation
  /** Controlled disclosure for the desktop roster, where only one row may be open at a time. */
  open?: boolean
  rosterKey?: string
  rowId?: string
  onOpenChange?: (rosterKey: string, open: boolean) => void
}

type AgentVisualState = 'working' | 'stopping' | 'stalled' | 'done' | 'failed' | 'stopped' | 'unknown'

function visualState(item: SubagentItem, now: number): AgentVisualState {
  if (item.status === 'running') {
    if (item.stopRequested) return 'stopping'
    if (item.lastActivityAt != null && now - item.lastActivityAt >= SUBAGENT_STALL_MS) return 'stalled'
    return 'working'
  }
  if (item.status === 'interrupted') return 'stopped'
  if (item.status === 'unknown') return 'unknown'
  return item.isError ? 'failed' : 'done'
}

function stateLabel(state: AgentVisualState): string {
  switch (state) {
    case 'working':
      return 'Working'
    case 'stopping':
      return 'Stopping'
    case 'stalled':
      return 'Stalled'
    case 'failed':
      return 'Failed'
    case 'stopped':
      return 'Stopped'
    case 'unknown':
      return 'Unknown'
    default:
      return 'Completed'
  }
}

function StateGlyph({ state }: { state: AgentVisualState }) {
  if (state === 'working' || state === 'stopping') {
    return <PixelGlyph loader variant="diamond" size={13} className="text-accent" />
  }
  if (state === 'failed') return <PixelGlyph glyph="cross" size={13} className="text-red-400" />
  if (state === 'stalled' || state === 'unknown') {
    return <PixelGlyph glyph="bang" size={13} className="text-amber-500" />
  }
  if (state === 'stopped') return <PixelGlyph glyph="dotBlock" size={13} className="text-text-muted/70" />
  return <PixelGlyph glyph="check" size={13} className="text-text-muted/70" />
}

/**
 * One delegate, rendered either as the compact card used by the phone or as a row in the desktop
 * Agents roster. Both presentations keep the full child stream and final result available; only the
 * desktop surface coordinates disclosure so the app never turns into a stack of open sub-threads.
 */
export const SubagentCard = memo(function SubagentCard({
  item,
  onStop,
  presentation = 'card',
  open: controlledOpen,
  rosterKey,
  rowId,
  onOpenChange,
}: SubagentCardProps) {
  const [localOpen, setLocalOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const open = controlledOpen ?? localOpen
  const running = item.status === 'running'
  const stopping = running && item.stopRequested === true

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [running])

  const setOpen = (next: boolean): void => {
    if (controlledOpen === undefined) setLocalOpen(next)
    onOpenChange?.(rosterKey ?? item.toolUseId, next)
  }

  if (presentation === 'roster') {
    const state = visualState(item, now)
    const title = humanizeAgentLabel(item.description, humanizeAgentLabel(item.subagentType))
    const activity = subagentActivity(item, now)
    const tools = subagentToolCount(item)
    const meta = [
      stateLabel(state),
      humanizeAgentLabel(item.subagentType),
      tools > 0 ? `${tools} ${tools === 1 ? 'tool' : 'tools'}` : null,
      item.usage?.totalTokens != null ? `${fmtTokens(item.usage.totalTokens)} tokens` : null,
    ].filter(Boolean)
    const detailsId = `${rowId ?? `agent-${item.toolUseId}`}-details`
    const purpose = item.prompt?.trim()
    const showPurpose = purpose && purpose !== item.description.trim()

    return (
      <article
        className={`relative min-w-0 rounded-[10px] transition-colors ${open ? 'bg-accent/[0.075]' : ''}`}
        data-agent-entry="subagent"
        data-agent-status={state}
      >
        <button
          id={rowId}
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen(!open)}
          className={`relative grid min-h-[66px] w-full min-w-0 grid-cols-[18px_minmax(0,1fr)_auto] grid-rows-[20px_18px_16px] items-center gap-x-3 rounded-[9px] px-3 py-1.5 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
            open ? '' : 'hover:bg-text/[0.035]'
          }`}
        >
          <span className="row-span-3 grid place-items-center" aria-hidden>
            <StateGlyph state={state} />
          </span>
          <span className="min-w-0 truncate text-[12.5px] font-medium text-text">{title}</span>
          <span className="flex items-center gap-2 pl-3 font-mono text-[10px] tabular-nums text-text-muted/65">
            {item.usage?.durationMs != null && <span>{formatDuration(item.usage.durationMs)}</span>}
            <Caret dir={open ? 'down' : 'right'} size={13} className="text-text-muted/45" />
          </span>
          <span className={`col-start-2 col-end-4 min-w-0 truncate text-[11.5px] ${running ? 'text-text/75' : 'text-text-muted'}`}>
            {activity}
          </span>
          <span className="col-start-2 col-end-4 min-w-0 truncate pr-8 font-mono text-[9.5px] tabular-nums text-text-muted/60">
            <span className="sr-only">Status: </span>
            {meta.join(' · ')}
          </span>
        </button>

        {running && item.taskId && onStop && (
          <IconButton
            label={stopping ? `Stopping ${title}` : `Stop ${title}`}
            size="sm"
            onClick={() => onStop(item.taskId!)}
            disabled={stopping}
            className="absolute right-2.5 top-[39px] text-red-500/70 hover:bg-red-500/10 hover:text-red-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400/70"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden>
              <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
            </svg>
          </IconButton>
        )}

        <Collapse open={open}>
          <div
            id={detailsId}
            data-agent-details=""
            className="mb-2 ml-[41px] mr-3 border-t border-border/70 pb-5 pt-5"
          >
            {showPurpose && (
              <div className="min-w-[180px] flex-1">
                <h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-accent">Purpose</h3>
                <p className="mt-1.5 max-w-[690px] whitespace-pre-wrap break-words text-[12px] leading-relaxed text-text-muted">
                  {purpose}
                </p>
              </div>
            )}

            <section className={showPurpose ? 'mt-5' : ''}>
              <h3 className="mb-3 flex items-baseline justify-between font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-text-muted">
                Activity
                <span className="normal-case tracking-normal text-text-muted/60">
                  {item.children.length} {item.children.length === 1 ? 'event' : 'events'}
                </span>
              </h3>
              <div className="space-y-2.5">
                {item.children.length === 0 && (
                  <p className="text-[12px] text-text-muted">{running ? 'Starting…' : 'No recorded activity.'}</p>
                )}
                {item.children.map((child) =>
                  child.kind === 'assistant' ? (
                    <AssistantMarkdown key={child.id} markdown={child.markdown} />
                  ) : (
                    <ToolCard
                      key={child.id}
                      name={child.name}
                      input={child.input}
                      liveOutput={child.liveOutput}
                      result={child.result}
                      isError={child.isError}
                    />
                  ),
                )}
              </div>
            </section>

            {item.resultText && (
              <section className="mt-5 border-t border-border/55 pt-5">
                <h3 className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-text-muted">Outcome</h3>
                <AssistantMarkdown markdown={item.resultText} />
              </section>
            )}
          </div>
        </Collapse>
      </article>
    )
  }

  const stalled = running && item.lastActivityAt != null && now - item.lastActivityAt >= SUBAGENT_STALL_MS
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

  const stateIcon = running ? '●' : item.status === 'unknown' ? '?' : item.status === 'interrupted' ? '■' : item.isError ? '✗' : '✓'
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
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left">
          <span className="shrink-0 font-mono text-[11px] font-semibold uppercase tracking-wide text-accent">{item.subagentType}</span>
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
        <div
          onClick={(event) => {
            if (window.getSelection()?.toString()) return
            if ((event.target as HTMLElement).closest('button, a, pre, input, textarea')) return
            setOpen(false)
          }}
          className="cursor-pointer space-y-3 border-l-2 border-t border-border px-4 py-3"
        >
          {item.prompt && <p className="border-l-2 border-border pl-2 text-xs italic text-text-muted">{item.prompt}</p>}
          {item.children.length === 0 && running && <p className="text-xs text-text-muted">Starting…</p>}
          {item.children.map((child) =>
            child.kind === 'assistant' ? (
              <AssistantMarkdown key={child.id} markdown={child.markdown} />
            ) : (
              <ToolCard
                key={child.id}
                name={child.name}
                input={child.input}
                liveOutput={child.liveOutput}
                result={child.result}
                isError={child.isError}
              />
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
})
