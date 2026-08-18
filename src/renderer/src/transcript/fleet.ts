import type { Entry, SubagentItem } from './types'
import type { WorkflowItemData } from './WorkflowCard'
import { delegationItemIsLive } from '@shared/delegation'

/**
 * The fleet — what a fan-out looks like from the conversation.
 *
 * One idea, shared by the transcript row and the Agents surface: a batch of delegated agents is ONE
 * event in the chat (a row you can open), and the roster of who is doing what is a place you go, not
 * a stack that grows down the reading column. Pure (no React, no store) so both readers derive the
 * same numbers from the same items.
 */

/** A launched delegate: a subagent the main agent spawned, or a background workflow run. */
export type FleetEntry = Extract<Entry, { kind: 'subagent' } | { kind: 'workflow' }>

export type FleetSummary = {
  /** Agents in the batch — a workflow counts its own members, not itself. */
  count: number
  /** Members still working. Every in-flight state reads the same here; only settled states differ. */
  working: number
  failed: number
  /** Explicitly stopped by the user. */
  stopped: number
  /** Koda can no longer observe these members; this does not claim that their process stopped. */
  unknown: number
  /** The workflow coordinator itself became unobservable before completion was confirmed. */
  workflowUnknown: boolean
  /** Anything still going. A workflow stays live while its coordinator or an observed member runs. */
  live: boolean
  totalTokens: number
  /** Named when the batch is a single workflow run, so the row can say which one. */
  workflowName: string | null
}

export type FleetMemberState = 'working' | 'done' | 'failed' | 'stopped' | 'unknown'

export const SUBAGENT_STALL_MS = 10 * 60 * 1000

export function isFleetEntry(entry: Entry): entry is FleetEntry {
  return entry.kind === 'subagent' || entry.kind === 'workflow'
}

/** A workflow can be marked complete after journal silence while a known member is still running. */
export function workflowIsLive(item: WorkflowItemData): boolean {
  return delegationItemIsLive(item)
}

export function fleetEntryIsLive(entry: FleetEntry): boolean {
  return delegationItemIsLive(entry)
}

export function summarizeFleet(entries: readonly FleetEntry[]): FleetSummary {
  let count = 0
  let working = 0
  let failed = 0
  let stopped = 0
  let unknown = 0
  let workflowUnknown = false
  let live = false
  let totalTokens = 0
  const workflows: WorkflowItemData[] = []
  for (const entry of entries) {
    if (entry.kind === 'subagent') {
      count += 1
      if (entry.status === 'running') {
        working += 1
        live = true
      }
      if (entry.isError) failed += 1
      else if (entry.status === 'interrupted') stopped += 1
      else if (entry.status === 'unknown') unknown += 1
      totalTokens += entry.usage?.totalTokens ?? 0
      continue
    }
    workflows.push(entry)
    count += entry.agents.length
    if (workflowIsLive(entry)) {
      live = true
      working += entry.agents.filter((a) => a.status === 'running').length
    }
    unknown += entry.agents.filter((a) => a.status === 'unknown').length
    if (entry.status === 'unknown') workflowUnknown = true
  }
  return {
    count,
    working,
    failed,
    stopped,
    unknown,
    workflowUnknown,
    live,
    totalTokens,
    workflowName: workflows.length === 1 && entries.length === 1 ? workflows[0].name : null,
  }
}

/** The row's lead: what happened, in the tense it happened in. */
export function fleetLead(summary: FleetSummary): string {
  const noun = summary.count === 1 ? 'agent' : 'agents'
  if (summary.workflowName) return summary.live ? 'Started a workflow' : 'Ran a workflow'
  return summary.live ? `Kicked off ${summary.count} ${noun}` : `Ran ${summary.count} ${noun}`
}

/** The row's right-hand readout: one steady in-flight state, detail only once it settles. */
export function fleetStatus(summary: FleetSummary): string {
  if (summary.live) return summary.working > 0 ? `${summary.working} working` : 'working'
  if (summary.failed > 0) return `${summary.failed} failed`
  // A stopped agent neither succeeded nor failed, and calling it done is the one reading that would
  // send someone off with an answer half of the fleet never produced.
  if (summary.stopped > 0) return summary.stopped === summary.count ? 'stopped' : `${summary.stopped} stopped`
  if (summary.workflowUnknown || summary.unknown > 0) {
    return summary.unknown > 0 && !summary.workflowUnknown ? `${summary.unknown} unknown` : 'status unknown'
  }
  return 'done'
}

/** Compact token count: 11549 → "11.5k". */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** Turn an engine/task identifier into the stable human label the roster leads with. */
export function humanizeAgentLabel(value: string | undefined, fallback = 'Agent'): string {
  const raw = value?.trim()
  if (!raw) return fallback
  // Drop a machine namespace (`koda:code-reviewer`), but preserve a human task containing a colon
  // (`Review API: permissions`).
  const source = /^(?:[a-z0-9_-]+:)+[a-z0-9_-]+$/i.test(raw) ? raw.slice(raw.lastIndexOf(':') + 1) : raw
  const words = source.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : fallback
}

/** The first meaningful sentence/line from a free-form Markdown result, for the collapsed row. */
export function resultLead(markdown: string | undefined, max = 132): string | null {
  if (!markdown) return null
  const lines = markdown
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?/, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^\s*>\s?/, '')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/__([^_\n]+)__/g, '$1')
        .replace(/~~([^~\n]+)~~/g, '$1')
        .replace(/(^|[^\p{L}\p{N}])\*([^*\n]+)\*(?![\p{L}\p{N}])/gu, '$1$2')
        .replace(/(^|[^\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu, '$1$2')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
  const line = lines.find((candidate) => !/^(summary|result|outcome|findings|verdict):?$/i.test(candidate))
  if (!line) return null
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** Live action while running; outcome once settled. Stable task identity lives in the title. */
export function subagentActivity(item: SubagentItem, now: number): string {
  if (item.status === 'running') {
    if (item.stopRequested) return 'Stopping after the current operation'
    if (item.lastActivityAt != null && now - item.lastActivityAt >= SUBAGENT_STALL_MS) {
      return 'No activity for 10 minutes'
    }
    return item.liveStatus ?? item.lastToolName ?? 'Working…'
  }
  if (item.status === 'interrupted') return 'Stopped before it finished'
  if (item.status === 'unknown') return 'Status unknown after restart'
  const outcome = resultLead(item.resultText)
  if (item.isError) return outcome ? `Failed: ${outcome}` : 'Failed'
  return outcome ?? 'Completed'
}

/** Prefer the engine's counter, with the rendered child stream as the honest fallback. */
export function subagentToolCount(item: SubagentItem): number {
  return item.usage?.toolUses ?? item.children.filter((child) => child.kind === 'tool').length
}

/** One status glyph per actual worker, including members inside a background workflow. */
export function fleetMemberStates(entries: readonly FleetEntry[]): FleetMemberState[] {
  return entries.flatMap((entry) => {
    if (entry.kind === 'workflow') {
      return entry.agents.map((agent) =>
        agent.status === 'running' ? 'working' : agent.status === 'unknown' ? 'unknown' : 'done',
      )
    }
    if (entry.status === 'running') return ['working']
    if (entry.isError) return ['failed']
    if (entry.status === 'interrupted') return ['stopped']
    if (entry.status === 'unknown') return ['unknown']
    return ['done']
  })
}
