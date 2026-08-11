import { describe, it, expect } from 'vitest'
import { ApprovalGate } from './gate'

/**
 * cancelSession fires on every ENGINE-PROCESS exit — including a respawn under the same session id
 * (broker recovery, a model/effort change, a plan-mode crossing). It must never touch a session's
 * posture (`modes`/`unattended`); that's forgetSession's job, called only when the session itself is
 * truly over. A regression here means a respawn silently resets the user's approval mode to default —
 * exactly the bug this split fixes (see debt-burndown notes on gate.ts).
 */
function makeGate() {
  const cancelled: string[] = []
  const gate = new ApprovalGate(
    async () => true, // checkpoint always succeeds
    () => {}, // pushRequest
    (sessionId) => cancelled.push(sessionId), // pushCancelled
    () => {}, // pushResolved
    () => {}, // warn
  )
  return { gate, cancelled }
}

describe('cancelSession vs forgetSession: process-exit vs session-identity', () => {
  it('keeps the full pending prompt available for a head that reloads after the live push', async () => {
    const { gate } = makeGate()
    gate.setSessionMode('s1', 'ask')
    const decision = gate.decide('s1', {
      toolUseId: 't1',
      toolName: 'Bash',
      input: { command: 'npm test' },
    })

    expect(gate.pendingRequests('s1')).toEqual([
      { sessionId: 's1', requestId: 't1', toolName: 'Bash', input: { command: 'npm test' } },
    ])

    gate.resolve('t1', { kind: 'allow' })
    expect(await decision).toEqual({ kind: 'allow' })
    expect(gate.pendingRequests('s1')).toEqual([])
  })

  it('cancelSession (a respawn) resolves pending approvals but leaves the posture intact', async () => {
    const { gate, cancelled } = makeGate()
    gate.setSessionMode('s1', 'ask')
    const pending = gate.decide('s1', { toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' } })
    gate.cancelSession('s1')
    expect(gate.getSessionMode('s1')).toBe('ask') // the respawn case — mode survives
    expect(cancelled).toEqual(['s1'])
    expect(await pending).toEqual({ kind: 'deny', reason: 'session ended' })
  })

  it('forgetSession (a true end) drops the posture entirely, back to the default', () => {
    const { gate } = makeGate()
    gate.setDefaultMode('auto')
    gate.setSessionMode('s1', 'ask')
    expect(gate.getSessionMode('s1')).toBe('ask')
    gate.forgetSession('s1')
    expect(gate.getSessionMode('s1')).toBe('auto') // gone — falls back to the default
  })

  it('a session marked unattended denies a forced ask during the run, and stops denying once cleared', async () => {
    const { gate } = makeGate()
    gate.setUnattended('s1', true)
    const during = await gate.decide('s1', { toolUseId: 'q1', toolName: 'AskUserQuestion', input: { questions: [] } })
    expect(during.kind).toBe('deny')
    expect(during.kind === 'deny' && during.reason).toContain('has NOT consented')

    // The dream turn ends — DreamScheduler.clearUnattended (a thin passthrough to this) fires.
    gate.setUnattended('s1', false)

    const afterPending = gate.decide('s1', { toolUseId: 'q2', toolName: 'AskUserQuestion', input: { questions: [] } })
    // No longer auto-denied — it's now a real pending ask; resolve it to prove the allow path runs.
    gate.resolve('q2', { kind: 'allow-with-edit', input: { questions: [], answers: [] } })
    expect(await afterPending).toEqual({ kind: 'allow-with-edit', input: { questions: [], answers: [] } })
  })

  it('a read-only REM session allows evidence reads but denies every mutation', async () => {
    const { gate } = makeGate()
    gate.setReadOnly('s1', true)

    expect(await gate.decide('s1', { toolUseId: 'r1', toolName: 'Read', input: { file_path: 'Goal.md' } })).toEqual(
      { kind: 'allow' },
    )
    const write = await gate.decide('s1', {
      toolUseId: 'w1',
      toolName: 'Write',
      input: { file_path: 'candidate.md', content: 'nope' },
    })
    expect(write.kind).toBe('deny')
    expect(write.kind === 'deny' && write.reason).toContain('read-only overnight REM')
    for (const [toolName, input] of [
      ['Bash', { command: 'cat Goal.md' }],
      ['mcp__playwright__browser_click', { element: 'Submit', ref: 'b7' }],
      ['mcp__unknown__readish_name', {}],
    ] as const) {
      expect((await gate.decide('s1', { toolUseId: `deny-${toolName}`, toolName, input })).kind).toBe('deny')
    }

    gate.forgetSession('s1')
    expect((await gate.decide('s1', { toolUseId: 'w2', toolName: 'Write', input: {} })).kind).toBe('allow')
  })
})
