import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useWorkspace } from '../workspace/store'
import { DockEmpty } from './Dock'
import { SubagentCard } from '../transcript/SubagentCard'
import { WorkflowCard } from '../transcript/WorkflowCard'
import {
  fleetMemberStates,
  fleetEntryIsLive,
  fmtTokens,
  humanizeAgentLabel,
  isFleetEntry,
  subagentActivity,
  summarizeFleet,
  type FleetEntry,
  type FleetMemberState,
} from '../transcript/fleet'
import { PixelGlyph } from '../ui'

type RosterEntry = {
  entry: FleetEntry
  key: string
  rowId: string
  live: boolean
}

function memberStateLabel(state: FleetMemberState): string {
  switch (state) {
    case 'working':
      return 'working'
    case 'done':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'stopped'
    default:
      return 'unknown'
  }
}

function MemberGlyph({ state }: { state: FleetMemberState }) {
  if (state === 'working') return <PixelGlyph loader variant="diamond" size={12} className="text-accent" />
  if (state === 'failed') return <PixelGlyph glyph="cross" size={12} className="text-red-400" />
  if (state === 'unknown') return <PixelGlyph glyph="bang" size={12} className="text-amber-500" />
  if (state === 'stopped') return <PixelGlyph glyph="dotBlock" size={12} className="text-text-muted/60" />
  return <PixelGlyph glyph="check" size={12} className="text-text-muted/60" />
}

function topLevelActivity(entry: FleetEntry, now: number): string {
  if (entry.kind === 'subagent') return subagentActivity(entry, now)
  const working = entry.agents.filter((agent) => agent.status === 'running').length
  if (working > 0) return `${working} ${working === 1 ? 'agent is' : 'agents are'} still working`
  return 'Preparing the next step'
}

function entryLabel(entry: FleetEntry): string {
  return entry.kind === 'subagent'
    ? humanizeAgentLabel(entry.description, humanizeAgentLabel(entry.subagentType))
    : humanizeAgentLabel(entry.name, 'Workflow')
}

/**
 * The one-column desktop roster. It is split out so `key={sessionId}` can reset disclosure when the
 * active chat changes without an effect briefly showing one chat's selected row in another.
 */
function AgentsRoster({
  fleet,
  sessionLabel,
  onStop,
}: {
  fleet: FleetEntry[]
  sessionLabel: string
  onStop: (taskId: string) => void
}) {
  const summary = useMemo(() => summarizeFleet(fleet), [fleet])
  const members = useMemo(() => fleetMemberStates(fleet), [fleet])
  const entries = useMemo<RosterEntry[]>(
    () =>
      fleet.map((entry) => ({
        entry,
        key: `${entry.kind}:${entry.id}`,
        rowId: `agent-roster-row-${entry.id}`,
        live: fleetEntryIsLive(entry),
      })),
    [fleet],
  )
  const liveEntries = entries.filter((candidate) => candidate.live)
  const [openKey, setOpenKey] = useState<string | null>(() => liveEntries[0]?.key ?? null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!summary.live) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [summary.live])

  const entryKeys = entries.map((candidate) => candidate.key).join('|')
  useEffect(() => {
    const valid = new Set(entries.map((candidate) => candidate.key))
    setOpenKey((current) => (current != null && !valid.has(current) ? liveEntries[0]?.key ?? null : current))
    // `entryKeys` is the append/remove signal. Depending on the entry objects themselves would rerun
    // this reconciliation on every progress patch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKeys])

  const handleOpenChange = useCallback((key: string, open: boolean) => {
    setOpenKey((current) => (open ? key : current === key ? null : current))
  }, [])

  const jumpTo = useCallback((candidate: RosterEntry) => {
    setOpenKey(candidate.key)
    window.requestAnimationFrame(() => {
      const row = document.getElementById(candidate.rowId)
      row?.scrollIntoView({ block: 'nearest' })
      row?.focus({ preventScroll: true })
    })
  }, [])

  const done = Math.max(
    0,
    summary.count - summary.working - summary.failed - summary.stopped - summary.unknown,
  )
  const counts = [
    summary.working > 0 ? `${summary.working} working` : null,
    `${done} done`,
    summary.failed > 0 ? `${summary.failed} failed` : null,
    summary.stopped > 0 ? `${summary.stopped} stopped` : null,
    summary.workflowUnknown ? 'workflow status unknown' : summary.unknown > 0 ? `${summary.unknown} unknown` : null,
    summary.totalTokens > 0 ? `${fmtTokens(summary.totalTokens)} tokens` : null,
  ].filter(Boolean)
  const memberLabel = members.length
    ? members.reduce<Record<string, number>>((acc, state) => {
        const label = memberStateLabel(state)
        acc[label] = (acc[label] ?? 0) + 1
        return acc
      }, {})
    : null
  const memberAria = memberLabel
    ? Object.entries(memberLabel)
        .map(([label, count]) => `${count} ${label}`)
        .join(', ')
    : undefined

  return (
    <div className="min-h-full w-full min-w-0 max-w-[920px] mx-auto" data-testid="agents-roster">
      <header className="border-b border-border/70 px-6 pb-5 pt-7">
        <div className="mb-2 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.08em] text-accent">
          <PixelGlyph
            glyph={summary.live ? 'dotRound' : 'check'}
            loader={summary.live}
            variant="diamond"
            size={12}
          />
          <span>{summary.live ? 'Live agents' : 'Agent history'}</span>
        </div>
        <h2 className="min-w-0 max-w-[650px] [overflow-wrap:anywhere] font-display text-[23px] font-semibold leading-[1.13] tracking-[-0.025em] text-text">
          {sessionLabel}
        </h2>
        <p className="mt-2 text-[11.5px] text-text-muted">Delegated work stays in launch order.</p>

        <div className="mt-5 flex min-w-0 flex-wrap items-center justify-between gap-x-5 gap-y-2">
          <div
            className="flex min-h-4 min-w-0 flex-wrap items-center gap-2"
            role={memberAria ? 'img' : undefined}
            aria-label={memberAria}
          >
            {members.map((state, index) => (
              <span key={`${state}-${index}`} aria-hidden>
                <MemberGlyph state={state} />
              </span>
            ))}
          </div>
          <p className="min-w-0 font-mono text-[10.5px] tabular-nums text-text-muted">
            {counts.map((count, index) => (
              <span key={count}>
                {index > 0 && <span className="px-1.5 text-text-muted/40">·</span>}
                {count}
              </span>
            ))}
          </p>
        </div>

        {liveEntries.length > 0 && (
          <section className="mt-4 border-t border-border/55 pt-3" aria-labelledby="working-now-heading">
            <h3 id="working-now-heading" className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-text-muted/65">
              Working now
            </h3>
            <div className="space-y-0.5">
              {liveEntries.map((candidate) => (
                <button
                  key={candidate.key}
                  type="button"
                  aria-expanded={openKey === candidate.key}
                  aria-controls={`${candidate.rowId}-details`}
                  onClick={() => jumpTo(candidate)}
                  className="grid min-h-7 w-full min-w-0 grid-cols-[14px_minmax(72px,auto)_minmax(0,1fr)] items-center gap-2 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-accent/[0.055] focus-visible:bg-accent/[0.07] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                >
                  <PixelGlyph loader variant="diamond" size={11} className="text-accent" />
                  <span className="min-w-0 truncate text-[10.5px] font-medium text-text">{entryLabel(candidate.entry)}</span>
                  <span className="min-w-0 truncate text-[10px] text-text-muted">
                    {topLevelActivity(candidate.entry, now)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </header>

      <section aria-labelledby="agent-list-heading" className="pb-5">
        <div className="flex items-center justify-between px-6 pb-2 pt-4 font-mono text-[10px] uppercase tracking-[0.08em] text-text-muted/65">
          <h3 id="agent-list-heading">Agents</h3>
          <span>{summary.count} in this chat</span>
        </div>
        <div className="space-y-0.5 px-3">
          {entries.map((candidate) =>
            candidate.entry.kind === 'workflow' ? (
              <WorkflowCard
                key={candidate.key}
                item={candidate.entry}
                presentation="roster"
                open={openKey === candidate.key}
                rosterKey={candidate.key}
                rowId={candidate.rowId}
                onOpenChange={handleOpenChange}
              />
            ) : (
              <SubagentCard
                key={candidate.key}
                item={candidate.entry}
                presentation="roster"
                open={openKey === candidate.key}
                rosterKey={candidate.key}
                rowId={candidate.rowId}
                onOpenChange={handleOpenChange}
                onStop={onStop}
              />
            ),
          )}
        </div>
      </section>
    </div>
  )
}

/**
 * AGENTS — the roster of everything this session delegated, on stage as a tab like everything else.
 * The conversation shows a fan-out as one row; this is what that row opens. Session-scoped and
 * ordered by launch, never re-sorted by status, so a row cannot move while someone is reading it.
 */
export function AgentsSurface() {
  const sessionId = useWorkspace((state) => state.activeId)
  const sessionLabel = useWorkspace((state) =>
    state.activeId ? state.sessions[state.activeId]?.label : undefined,
  )
  const fleet = useWorkspace(
    useShallow((state) =>
      state.activeId ? (state.sessions[state.activeId]?.items ?? []).filter(isFleetEntry) : [],
    ),
  )
  const stopSubagent = useWorkspace((state) => state.stopSubagent)

  const handleStop = useCallback(
    (taskId: string) => {
      if (sessionId) stopSubagent(sessionId, taskId)
    },
    [sessionId, stopSubagent],
  )

  if (fleet.length === 0) {
    return (
      <DockEmpty
        icon={<PixelGlyph glyph="dotRound" size={18} />}
        title="No agents yet"
        hint="When this chat hands work to its own agents, they show up here with what each one is doing and what it came back with."
      />
    )
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-bg px-3" data-testid="agents-scroll-owner">
      <AgentsRoster key={sessionId} fleet={fleet} sessionLabel={sessionLabel || 'This chat’s delegated work'} onStop={handleStop} />
    </div>
  )
}
