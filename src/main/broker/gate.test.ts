import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { ApprovalGate } from './gate'

/**
 * cancelSession fires on every ENGINE-PROCESS exit — including a respawn under the same session id
 * (broker recovery, a model/effort change, a plan-mode crossing). It must never touch a session's
 * posture (`modes`/`unattended`); that's forgetSession's job, called only when the session itself is
 * truly over. A regression here means a respawn silently resets the user's approval mode to default —
 * exactly the bug this split fixes (see debt-burndown notes on gate.ts).
 */
function makeGate(checkpoint: (sessionId: string, label: string) => Promise<boolean> = async () => true) {
  const cancelled: string[] = []
  const resolved: Array<{ sessionId: string; requestId: string }> = []
  const gate = new ApprovalGate(
    checkpoint,
    () => {}, // pushRequest
    (sessionId) => cancelled.push(sessionId), // pushCancelled
    (sessionId, requestId) => resolved.push({ sessionId, requestId }), // pushResolved
    () => {}, // warn
  )
  return { gate, cancelled, resolved }
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

  it('contains overnight tidy writes to the real memory tree and denies every other capability', async () => {
    const { gate } = makeGate()
    const root = mkdtempSync(join(tmpdir(), 'koda-memory-gate-'))
    const memory = join(root, '.koda', 'memory')
    const outside = join(root, 'outside')
    mkdirSync(memory, { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(memory, 'MEMORY.md'), '# Memory\n')
    writeFileSync(join(memory, 'obsolete.md'), '# Old note\n')
    symlinkSync(outside, join(memory, 'escape'))
    try {
      gate.setMemoryTidyRoot('s1', root)
      expect(
        await gate.decide('s1', { toolUseId: 'r1', toolName: 'Read', input: { file_path: 'src/app.ts' } }),
      ).toEqual({ kind: 'allow' })
      expect(
        await gate.decide('s1', {
          toolUseId: 'w1',
          toolName: 'Edit',
          input: { file_path: '.koda/memory/MEMORY.md' },
        }),
      ).toEqual({ kind: 'allow' })
      expect(
        await gate.decide('s1', {
          toolUseId: 'w2',
          toolName: 'Write',
          input: { file_path: '.koda/memory/new-note.md' },
        }),
      ).toEqual({ kind: 'allow' })
      expect(
        await gate.decide('s1', {
          toolUseId: 'skill-memory',
          toolName: 'Skill',
          input: { skill: 'memory' },
        }),
      ).toEqual({ kind: 'allow' })
      expect(
        await gate.decide('s1', {
          toolUseId: 'delete-note',
          toolName: 'Bash',
          input: { command: "rm -f -- '.koda/memory/obsolete.md'" },
        }),
      ).toEqual({ kind: 'allow' })

      for (const [toolName, input] of [
        ['Write', { file_path: 'src/outside.ts' }],
        [
          'Write',
          { file_path: '.koda/memory/MEMORY.md', file_paths: ['.koda/memory/MEMORY.md', 'src/outside.ts'] },
        ],
        ['Write', { file_path: '.koda/memory/escape/stolen.md' }],
        ['Bash', { command: 'printf nope > .koda/memory/MEMORY.md' }],
        ['Bash', { command: 'rm -f -- .koda/memory/obsolete.md; touch src/outside.ts' }],
        ['Bash', { command: 'rm -rf -- .koda/memory' }],
        ['Skill', { skill: 'code-work' }],
        ['WebFetch', { url: 'https://example.com' }],
        ['mcp__unknown__write', {}],
      ] as const) {
        const decision = await gate.decide('s1', { toolUseId: `deny-${toolName}`, toolName, input })
        expect(decision.kind).toBe('deny')
        expect(decision.kind === 'deny' && decision.reason).toContain('overnight memory tidy')
      }

      gate.forgetSession('s1')
      expect(
        await gate.decide('s1', {
          toolUseId: 'after',
          toolName: 'Write',
          input: { file_path: 'src/outside.ts' },
        }),
      ).toEqual({ kind: 'allow' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves a contained memory note in place when its deletion checkpoint fails', async () => {
    const { gate } = makeGate(async () => false)
    const root = mkdtempSync(join(tmpdir(), 'koda-memory-delete-gate-'))
    const memory = join(root, '.koda', 'memory')
    mkdirSync(memory, { recursive: true })
    writeFileSync(join(memory, 'obsolete.md'), '# Old note\n')
    try {
      gate.setMemoryTidyRoot('s1', root)
      const decision = await gate.decide('s1', {
        toolUseId: 'delete-note',
        toolName: 'Bash',
        input: { command: 'rm .koda/memory/obsolete.md' },
      })
      expect(decision.kind).toBe('deny')
      expect(decision.kind === 'deny' && decision.reason).toContain('recovery point')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * The stranded-approval backstop. An "Ask me" prompt whose asking `approve` call outlived its turn
 * (the engine aborted it on the ~1025s MCP idle timeout, sending no cancellation) leaks a pending slot
 * that then gates the next turn's admission with a card no head can answer — the session bricks until
 * restart. sweepStranded, fired at a genuine TurnComplete, and the askUser abort hook both clean it.
 */
describe('sweepStranded / abort: a leaked approval slot cannot brick the next turn', () => {
  it('sweeps every pending slot of the session: card cleared per request, promise denied, others untouched', async () => {
    const { gate, resolved } = makeGate()
    gate.setSessionMode('s1', 'ask')
    const a = gate.decide('s1', { toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' } })
    const b = gate.decide('s1', { toolUseId: 't2', toolName: 'Bash', input: { command: 'pwd' } })
    // A second session's slot must survive s1's sweep.
    gate.setSessionMode('s2', 'ask')
    const other = gate.decide('s2', { toolUseId: 'u1', toolName: 'Bash', input: { command: 'id' } })
    expect(gate.pendingRequests('s1')).toHaveLength(2)

    gate.sweepStranded('s1')

    expect(gate.pendingRequests('s1')).toEqual([])
    expect(resolved).toEqual([
      { sessionId: 's1', requestId: 't1' },
      { sessionId: 's1', requestId: 't2' },
    ])
    for (const decision of [await a, await b]) {
      expect(decision.kind).toBe('deny')
      expect(decision.kind === 'deny' && decision.reason).toContain('ended along with its turn')
    }
    // s2 kept its slot — resolve it to prove it was never touched.
    expect(gate.pendingRequests('s2')).toHaveLength(1)
    gate.resolve('u1', { kind: 'allow' })
    expect(await other).toEqual({ kind: 'allow' })
  })

  it('is a no-op for a session with no pending slots', () => {
    const { gate, resolved } = makeGate()
    gate.sweepStranded('empty')
    expect(resolved).toEqual([])
    expect(gate.pendingRequests('empty')).toEqual([])
  })

  it('an abort while the ask is pending denies and clears the card exactly once', async () => {
    const { gate, resolved } = makeGate()
    gate.setSessionMode('s1', 'ask')
    const controller = new AbortController()
    const pending = gate.decide('s1', { toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' } }, controller.signal)
    expect(gate.pendingRequests('s1')).toHaveLength(1)

    controller.abort()
    const decision = await pending
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('cancelled this request')
    expect(gate.pendingRequests('s1')).toEqual([])
    expect(resolved).toEqual([{ sessionId: 's1', requestId: 't1' }])

    // A later turn-end sweep finds nothing to do — no second broadcast.
    gate.sweepStranded('s1')
    expect(resolved).toEqual([{ sessionId: 's1', requestId: 't1' }])
  })

  it('a sweep before the abort wins; the late abort is a no-op (no double clear)', async () => {
    const { gate, resolved } = makeGate()
    gate.setSessionMode('s1', 'ask')
    const controller = new AbortController()
    const pending = gate.decide('s1', { toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' } }, controller.signal)

    gate.sweepStranded('s1')
    expect((await pending).kind).toBe('deny')
    expect(resolved).toEqual([{ sessionId: 's1', requestId: 't1' }])

    controller.abort() // the engine's cancellation lands after the sweep already cleaned the slot
    expect(resolved).toEqual([{ sessionId: 's1', requestId: 't1' }]) // still once
  })

  it('an already-aborted signal denies immediately, pushing no card and no resolved event', async () => {
    const { gate, resolved } = makeGate()
    gate.setSessionMode('s1', 'ask')
    const decision = await gate.decide(
      's1',
      { toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' } },
      AbortSignal.abort(),
    )
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('cancelled this request')
    expect(gate.pendingRequests('s1')).toEqual([]) // never registered
    expect(resolved).toEqual([]) // nothing to broadcast — no card was ever pushed
  })
})

/**
 * Plan mode on an engine that has none of its own (Codex — capabilities `planMode: 'turnText'`). The
 * turn's steering block tells the agent Koda refuses project changes while planning; these are the
 * refusals that make that sentence true rather than decorative.
 */
describe('plan fence for engines without a native plan mode', () => {
  it('hard-denies a project change while planning, and says why in terms the agent can act on', async () => {
    const { gate } = makeGate()
    gate.setPlanFence('s1', true)
    gate.setSessionMode('s1', 'plan')
    const decision = await gate.decide('s1', {
      toolUseId: 't1',
      toolName: 'Write',
      input: { file_path: 'src/app.ts' },
    })
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('Plan mode is active')
    expect(decision.kind === 'deny' && decision.reason).toContain('hard stop')
  })

  it('keeps read-only exploration alive: commands and reads still pass while planning', async () => {
    const { gate } = makeGate()
    gate.setPlanFence('s1', true)
    gate.setSessionMode('s1', 'plan')
    // Codex runs commands in its own read-only sandbox and the driver refuses to widen it while
    // planning, so tests, builds, and greps are exactly the exploration Plan mode asks for.
    expect(await gate.decide('s1', { toolUseId: 't2', toolName: 'Bash', input: { command: 'npm test' } })).toEqual({
      kind: 'allow',
    })
    expect(await gate.decide('s1', { toolUseId: 't3', toolName: 'Read', input: { file_path: 'src/app.ts' } })).toEqual({
      kind: 'allow',
    })
  })

  it('lifts the moment the posture leaves plan — no respawn, no latch', async () => {
    const { gate } = makeGate()
    gate.setPlanFence('s1', true)
    gate.setSessionMode('s1', 'plan')
    expect((await gate.decide('s1', { toolUseId: 't4', toolName: 'Write', input: {} })).kind).toBe('deny')
    gate.setSessionMode('s1', 'auto')
    expect(await gate.decide('s1', { toolUseId: 't5', toolName: 'Write', input: {} })).toEqual({ kind: 'allow' })
  })

  it('keeps a turn steered as Plan fenced even after the user switches mode mid-turn', async () => {
    const { gate } = makeGate()
    gate.setPlanFence('s1', true)
    gate.setSessionMode('s1', 'plan')
    gate.pinTurnMode('s1', 'plan') // the turn went out carrying the Plan block

    // The user flips to Auto while that turn is still running. The model was never told — it is still
    // working under the Plan block — so this turn's tool calls stay judged as Plan.
    gate.setSessionMode('s1', 'auto')
    const midTurn = await gate.decide('s1', {
      toolUseId: 'mid',
      toolName: 'Write',
      input: { file_path: 'src/app.ts' },
    })
    expect(midTurn.kind).toBe('deny')
    expect(midTurn.kind === 'deny' && midTurn.reason).toContain('Plan mode is active')

    // Turn boundary: the pin releases and the new posture applies, exactly as the next turn's block says.
    gate.pinTurnMode('s1', null)
    expect(await gate.decide('s1', { toolUseId: 'next', toolName: 'Write', input: {} })).toEqual({
      kind: 'allow',
    })
  })

  it('does not fence a turn steered as Default when the user switches INTO Plan mid-turn', async () => {
    const { gate } = makeGate()
    gate.setPlanFence('s1', true)
    gate.setSessionMode('s1', 'auto')
    gate.pinTurnMode('s1', 'auto')
    gate.setSessionMode('s1', 'plan')

    // The running turn was told it could build; a surprise hard deny would punish it for the user's
    // click. Plan starts biting on the next turn, which is the one that carries the Plan block.
    expect(await gate.decide('s1', { toolUseId: 'mid', toolName: 'Write', input: {} })).toEqual({
      kind: 'allow',
    })
    gate.pinTurnMode('s1', null)
    expect((await gate.decide('s1', { toolUseId: 'next', toolName: 'Write', input: {} })).kind).toBe('deny')
  })

  it('never fences an engine that enforces its own plan mode', async () => {
    const { gate } = makeGate()
    gate.setSessionMode('s1', 'plan') // Claude: `--permission-mode plan` is the fence, in the engine
    expect(await gate.decide('s1', { toolUseId: 't6', toolName: 'Write', input: {} })).toEqual({ kind: 'allow' })
  })

  it('forgets the fence with the session, so a reused id cannot inherit it', async () => {
    const { gate } = makeGate()
    gate.setPlanFence('s1', true)
    gate.forgetSession('s1')
    gate.setSessionMode('s1', 'plan')
    expect(await gate.decide('s1', { toolUseId: 't7', toolName: 'Write', input: {} })).toEqual({ kind: 'allow' })
  })
})
