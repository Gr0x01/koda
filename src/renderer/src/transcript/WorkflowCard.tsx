import { memo, useState } from 'react'
import { Collapse } from '../motion'
import { Caret } from '../Caret'
import { humanizeAgentLabel, workflowIsLive } from './fleet'
import { PixelGlyph } from '../ui'

/**
 * A background workflow (multi-agent orchestration via the Workflow tool). Koda watches its journal
 * and surfaces progress here because detached workflows do not stream a normal result back into the
 * turn. On desktop it shares the roster anatomy with ordinary subagents; the phone keeps the compact
 * card presentation.
 */
export type WorkflowAgentRow = { agentId: string; status: 'running' | 'done' | 'unknown'; result?: string }

export type WorkflowItemData = {
  runId: string
  name: string
  status: 'running' | 'completed' | 'unknown'
  agents: WorkflowAgentRow[]
}

type WorkflowCardProps = {
  item: WorkflowItemData
  presentation?: 'card' | 'roster'
  open?: boolean
  rosterKey?: string
  rowId?: string
  onOpenChange?: (rosterKey: string, open: boolean) => void
}

export const WorkflowCard = memo(function WorkflowCard({
  item,
  presentation = 'card',
  open: controlledOpen,
  rosterKey,
  rowId,
  onOpenChange,
}: WorkflowCardProps) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const running = workflowIsLive(item)
  const done = item.agents.filter((agent) => agent.status === 'done').length
  const working = item.agents.filter((agent) => agent.status === 'running').length
  const unknown = item.agents.filter((agent) => agent.status === 'unknown').length
  const unknownState = item.status === 'unknown' || unknown > 0
  const setOpen = (next: boolean): void => {
    if (controlledOpen === undefined) setLocalOpen(next)
    onOpenChange?.(rosterKey ?? item.runId, next)
  }

  if (presentation === 'roster') {
    const title = humanizeAgentLabel(item.name, 'Workflow')
    const status = running
      ? working > 0
        ? `${working} still working`
        : 'Preparing the next step'
      : unknownState
        ? 'Koda is no longer observing this workflow'
      : item.agents.length === 0
        ? 'Completed without member results'
        : `${done} ${done === 1 ? 'agent has' : 'agents have'} finished`
    const meta = [
      running ? 'Working' : unknownState ? 'Status unknown' : 'Completed',
      'Workflow',
      `${item.agents.length} ${item.agents.length === 1 ? 'agent' : 'agents'}`,
      item.agents.length > 0 ? `${done}/${item.agents.length} completed` : null,
    ].filter(Boolean)
    const detailsId = `${rowId ?? `workflow-${item.runId}`}-details`

    return (
      <article
        className={`relative min-w-0 rounded-[10px] transition-colors ${open ? 'bg-accent/[0.075]' : ''}`}
        data-agent-entry="workflow"
        data-agent-status={running ? 'working' : unknownState ? 'unknown' : 'done'}
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
            <PixelGlyph
              glyph={running ? 'dotRound' : unknownState ? 'bang' : 'check'}
              loader={running}
              variant="diamond"
              size={13}
              className={running ? 'text-accent' : unknownState ? 'text-amber-500' : 'text-text-muted/70'}
            />
          </span>
          <span className="min-w-0 truncate text-[12.5px] font-medium text-text">{title}</span>
          <span className="flex items-center gap-2 pl-3 font-mono text-[10px] tabular-nums text-text-muted/65">
            <Caret dir={open ? 'down' : 'right'} size={13} className="text-text-muted/45" />
          </span>
          <span className={`col-start-2 col-end-4 min-w-0 truncate text-[11.5px] ${running ? 'text-text/75' : 'text-text-muted'}`}>
            {status}
          </span>
          <span className="col-start-2 col-end-4 min-w-0 truncate font-mono text-[9.5px] tabular-nums text-text-muted/60">
            <span className="sr-only">Status: </span>
            {meta.join(' · ')}
          </span>
        </button>

        <Collapse open={open}>
          <div
            id={detailsId}
            data-agent-details=""
            className="mb-2 ml-[41px] mr-3 border-t border-border/70 pb-5 pt-5"
          >
            <h3 className="mb-3 flex items-baseline justify-between font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-text-muted">
              Activity
              <span className="normal-case tracking-normal text-text-muted/60">
                {item.agents.length} {item.agents.length === 1 ? 'member' : 'members'}
              </span>
            </h3>
            {running && (
              <p className="mb-3 text-[12px] leading-relaxed text-text-muted">
                This workflow is running in the background. Koda is watching its progress.
              </p>
            )}
            {unknownState && !running && (
              <p className="mb-3 text-[12px] leading-relaxed text-text-muted">
                Koda stopped observing this workflow before it could confirm completion.
              </p>
            )}
            {item.agents.length === 0 && !running && !unknownState && (
              <p className="text-[12px] text-text-muted">It returned no member results.</p>
            )}
            <div className="space-y-4">
              {item.agents.map((agent, index) => (
                <div key={agent.agentId} className="min-w-0">
                  <div className="flex items-center gap-2 text-[11px] text-text-muted">
                    <span aria-hidden>
                      <PixelGlyph
                        glyph={agent.status === 'done' ? 'check' : agent.status === 'unknown' ? 'bang' : 'dotRound'}
                        loader={agent.status === 'running'}
                        variant="diamond"
                        size={11}
                        className={
                          agent.status === 'running'
                            ? 'text-accent'
                            : agent.status === 'unknown'
                              ? 'text-amber-500'
                              : 'text-text-muted/70'
                        }
                      />
                    </span>
                    <span>Agent {index + 1}</span>
                    <span className="font-mono text-[9.5px] text-text-muted/60">
                      {agent.status === 'running'
                        ? 'Working'
                        : agent.status === 'unknown'
                          ? 'Status unknown'
                          : 'Completed'}
                    </span>
                  </div>
                  {agent.result && (
                    <p className="ml-5 mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-text">
                      {agent.result}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Collapse>
      </article>
    )
  }

  // Live: what the run is doing. At rest: what it was. The background note belongs to a running
  // workflow only, because a settled one has nothing left to wait through.
  const status = running
    ? working > 0
      ? `${working} still working`
      : 'starting…'
    : unknownState
      ? 'status unknown'
    : `${item.agents.length || 'no'} ${item.agents.length === 1 ? 'agent' : 'agents'}`

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border bg-surface shadow-soft">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2.5 border-l-2 border-border px-3 py-2 text-left text-xs"
      >
        <span className="shrink-0 font-mono text-[11px] font-semibold uppercase tracking-wide text-accent">workflow</span>
        <span className="truncate text-text">{item.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2.5 font-mono text-[11px] text-text-muted">
          <span>{status}</span>
          {item.agents.length > 0 && (
            <span className="tabular-nums">
              {done}/{item.agents.length}
            </span>
          )}
          <span className={running ? 'animate-pulse text-accent' : unknownState ? 'text-amber-500' : 'text-text-muted'}>
            {running ? '●' : unknownState ? '?' : '✓'}
          </span>
          <Caret dir={open ? 'down' : 'right'} className="text-text-muted/50" />
        </span>
      </button>

      <Collapse open={open}>
        <div className="space-y-3 border-l-2 border-t border-border px-4 py-3">
          {running && (
            <p className="text-xs text-text-muted">
              Runs in the background. Koda is watching its progress, you don't need to wait here.
            </p>
          )}
          {unknownState && !running && (
            <p className="text-xs text-text-muted">Koda stopped observing this workflow before it could confirm completion.</p>
          )}
          {item.agents.length === 0 && !running && !unknownState && <p className="text-xs text-text-muted">It returned nothing.</p>}
          {item.agents.map((agent, index) => (
            <div key={agent.agentId} className="text-xs">
              <div className="flex items-center gap-2">
                <span
                  className={
                    agent.status === 'running'
                      ? 'animate-pulse text-accent'
                      : agent.status === 'unknown'
                        ? 'text-amber-500'
                        : 'text-text-muted'
                  }
                >
                  {agent.status === 'done' ? '✓' : agent.status === 'unknown' ? '?' : '●'}
                </span>
                <span className="text-text-muted">Agent {index + 1}</span>
                {agent.status === 'unknown' && <span className="text-text-muted/70">status unknown</span>}
              </div>
              {agent.result && (
                <p className="ml-6 mt-0.5 whitespace-pre-wrap break-words text-[13px] text-text">{agent.result}</p>
              )}
            </div>
          ))}
        </div>
      </Collapse>
    </div>
  )
})
