import { describe, expect, it } from 'vitest'
import {
  fleetLead,
  fleetMemberStates,
  fleetStatus,
  humanizeAgentLabel,
  resultLead,
  SUBAGENT_STALL_MS,
  subagentActivity,
  subagentToolCount,
  summarizeFleet,
  type FleetEntry,
} from './fleet'

let nextId = 0
type AgentEntry = Extract<FleetEntry, { kind: 'subagent' }>
const agent = (over: Partial<AgentEntry> = {}): AgentEntry => ({
  id: ++nextId,
  kind: 'subagent',
  toolUseId: `tu${nextId}`,
  subagentType: 'scout',
  description: 'Check the docs',
  status: 'completed',
  children: [],
  ...over,
})

describe('summarizeFleet', () => {
  it('counts the batch, its live members, and their tokens', () => {
    const summary = summarizeFleet([
      agent({ status: 'running', usage: { totalTokens: 1200 } }),
      agent({ usage: { totalTokens: 8400 } }),
      agent({ isError: true }),
    ])
    expect(summary).toMatchObject({ count: 3, working: 1, failed: 1, live: true, totalTokens: 9600 })
  })

  it('keeps a workflow live when either its coordinator or a known member is running', () => {
    // Every member row can be settled while the run is still spawning its next phase, so member
    // counts alone would report a live run as done.
    const summary = summarizeFleet([
      { id: ++nextId, kind: 'workflow', runId: 'wf1', name: 'review-changes', status: 'running', agents: [{ agentId: 'a', status: 'done' }] },
    ])
    expect(summary).toMatchObject({ count: 1, live: true, workflowName: 'review-changes' })

    // Journal silence can settle the coordinator before a long-running member reports its result.
    // The roster must not drop that member from Working now or call the workflow complete.
    const memberStillRunning = summarizeFleet([
      {
        id: ++nextId,
        kind: 'workflow',
        runId: 'wf-member-live',
        name: 'long-review',
        status: 'completed',
        agents: [{ agentId: 'a', status: 'running' }],
      },
    ])
    expect(memberStillRunning).toMatchObject({ count: 1, working: 1, live: true })
    expect(fleetStatus(memberStillRunning)).toBe('1 working')
  })

  it('names the workflow only when the batch is that one run', () => {
    const workflow: FleetEntry = { id: ++nextId, kind: 'workflow', runId: 'wf2', name: 'audit', status: 'completed', agents: [] }
    expect(summarizeFleet([workflow, agent()]).workflowName).toBeNull()
  })

  it('reads present tense live and past tense settled', () => {
    const live = summarizeFleet([agent({ status: 'running' }), agent()])
    expect(fleetLead(live)).toBe('Kicked off 2 agents')
    expect(fleetStatus(live)).toBe('1 working')

    const settled = summarizeFleet([agent()])
    expect(fleetLead(settled)).toBe('Ran 1 agent')
    expect(fleetStatus(settled)).toBe('done')
    expect(fleetStatus(summarizeFleet([agent({ isError: true })]))).toBe('1 failed')

    // Stopped is its own outcome: neither of the two a settled row would otherwise claim.
    expect(fleetStatus(summarizeFleet([agent({ status: 'interrupted' })]))).toBe('stopped')
    expect(fleetStatus(summarizeFleet([agent({ status: 'interrupted' }), agent()]))).toBe('1 stopped')
    expect(fleetStatus(summarizeFleet([agent({ status: 'unknown' })]))).toBe('1 unknown')
  })
})

describe('agent roster presentation', () => {
  it('turns machine task ids into stable sentence-case labels', () => {
    expect(humanizeAgentLabel('deep_review_inventory')).toBe('Deep review inventory')
    expect(humanizeAgentLabel('koda:code-reviewer')).toBe('Code reviewer')
    expect(humanizeAgentLabel('Review the renderer')).toBe('Review the renderer')
    expect(humanizeAgentLabel('Review API: permissions')).toBe('Review API: permissions')
  })

  it('uses the first meaningful result line without leaking Markdown furniture', () => {
    expect(resultLead('## Verdict\n\n- **Mapped** every delegate surface.')).toBe('Mapped every delegate surface.')
    expect(resultLead('Kept C# and foo_bar literal while removing `code_style` furniture.')).toBe(
      'Kept C# and foo_bar literal while removing code_style furniture.',
    )
    expect(resultLead('')).toBeNull()
    expect(resultLead('A very long result that should be clipped for the roster', 24)).toBe('A very long result that…')
  })

  it('keeps task identity separate from live and settled activity', () => {
    const now = 1_000_000
    expect(subagentActivity(agent({ status: 'running', liveStatus: 'Reading the canonical architecture' }), now)).toBe(
      'Reading the canonical architecture',
    )
    expect(subagentActivity(agent({ status: 'running' }), now)).toBe('Working…')
    expect(subagentActivity(agent({ status: 'running', stopRequested: true }), now)).toBe(
      'Stopping after the current operation',
    )
    expect(
      subagentActivity(agent({ status: 'running', lastActivityAt: now - SUBAGENT_STALL_MS }), now),
    ).toBe('No activity for 10 minutes')
    expect(subagentActivity(agent({ resultText: '# Outcome\nFound no lifecycle bypass.' }), now)).toBe(
      'Found no lifecycle bypass.',
    )
    expect(subagentActivity(agent({ isError: true, resultText: 'Contract check failed.' }), now)).toBe(
      'Failed: Contract check failed.',
    )
    expect(subagentActivity(agent({ status: 'interrupted' }), now)).toBe('Stopped before it finished')
    expect(subagentActivity(agent({ status: 'unknown' }), now)).toBe('Status unknown after restart')
  })

  it('uses engine tool counts when present and rendered tool children otherwise', () => {
    expect(subagentToolCount(agent({ usage: { toolUses: 7 } }))).toBe(7)
    expect(
      subagentToolCount(
        agent({
          children: [
            { id: 1, kind: 'tool', toolUseId: 'read', name: 'Read', input: {} },
            { id: 2, kind: 'assistant', markdown: 'Done.' },
          ],
        }),
      ),
    ).toBe(1)
  })

  it('builds one visual state per worker without changing launch order', () => {
    const workflow: FleetEntry = {
      id: ++nextId,
      kind: 'workflow',
      runId: 'wf-states',
      name: 'review',
      status: 'running',
      agents: [
        { agentId: 'first', status: 'done' },
        { agentId: 'second', status: 'running' },
        { agentId: 'third', status: 'unknown' },
      ],
    }
    expect(
      fleetMemberStates([
        agent({ status: 'running' }),
        workflow,
        agent({ isError: true }),
        agent({ status: 'interrupted' }),
        agent({ status: 'unknown' }),
      ]),
    ).toEqual(['working', 'done', 'working', 'unknown', 'failed', 'stopped', 'unknown'])
  })

  it('treats an unobservable workflow member as terminal, not permanently live', () => {
    const summary = summarizeFleet([
      {
        id: ++nextId,
        kind: 'workflow',
        runId: 'restored-workflow',
        name: 'restored-review',
        status: 'unknown',
        agents: [{ agentId: 'lost', status: 'unknown' }],
      },
    ])
    expect(summary).toMatchObject({
      count: 1,
      working: 0,
      stopped: 0,
      unknown: 1,
      workflowUnknown: true,
      live: false,
    })
    expect(fleetStatus(summary)).toBe('status unknown')
  })
})
