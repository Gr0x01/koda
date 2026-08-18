import { memo } from 'react'
import { PixelGlyph } from '../ui'
import { RestDot, WorkStrip } from './StepRun'
import { fleetLead, fleetStatus, fmtTokens, summarizeFleet, type FleetEntry } from './fleet'

/**
 * A fan-out, as one work object in the conversation. The main agent handed work to delegates; this
 * strip says that happened, how it is going, and opens the roster. It is deliberately the whole of a
 * fan-out's presence in the reading column: nested agent cards used to stack the sub-thread's prose
 * and tool steps into the transcript, which buried the conversation exactly when the most was
 * happening.
 *
 * It wears the same strip as a run of steps and as the settled turn's door, because it is the same
 * promise at a third scale — work folded away, one click from the whole of it. The one difference the
 * shape has to carry is where that click goes: a run opens in place, a fan-out opens the Agents
 * surface, so the caret is replaced by a named door rather than implying a drawer.
 *
 * Live it reads present tense with a pulsing glyph; settled it freezes to past tense. Every in-flight
 * state presents the same way (working), because a queued or quiet delegate is still the fleet doing
 * its job, not something the user has to act on.
 */
export const FleetRow = memo(function FleetRow({
  entries,
  onOpen,
}: {
  entries: FleetEntry[]
  onOpen: () => void
}) {
  const summary = summarizeFleet(entries)
  const lead = fleetLead(summary)
  const status = fleetStatus(summary)
  return (
    <WorkStrip
      glyph={
        summary.live ? (
          <PixelGlyph loader variant="diamond" size={12} className="text-accent" />
        ) : summary.failed > 0 ? (
          <span className="text-red-400">✗</span>
        ) : (
          <RestDot />
        )
      }
      lead={lead}
      detail={summary.workflowName ?? undefined}
      label={`${lead}. ${status}. Open the Agents view.`}
      meta={
        <>
          <span>{status}</span>
          {summary.totalTokens > 0 && (
            <span className="tabular-nums opacity-70">{fmtTokens(summary.totalTokens)} tokens</span>
          )}
        </>
      }
      trailing={<span className="text-accent">Open Agents ▸</span>}
      onToggle={onOpen}
    />
  )
})
