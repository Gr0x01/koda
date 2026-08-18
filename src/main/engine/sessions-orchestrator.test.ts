import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalMode } from '@shared/ipc'
import type { EngineSession } from './adapter'

const harness = vi.hoisted(() => ({
  loadSessionAgentRole: vi.fn(() => 'adaptive' as 'adaptive' | 'orchestrator'),
  startCodexSession: vi.fn(),
}))

vi.mock('../settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings')>()),
  loadSessionAgentRole: harness.loadSessionAgentRole,
}))

vi.mock('./codex-home', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./codex-home')>()),
  ensureCodexHome: vi.fn().mockResolvedValue(undefined),
  reconcileCodexAuth: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./codex-driver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./codex-driver')>()),
  startCodexSession: harness.startCodexSession,
}))

import { EngineSessionManager } from './sessions'

type BrokerHarness = {
  ensureListening: ReturnType<typeof vi.fn>
  register: ReturnType<typeof vi.fn>
  tokenFor: ReturnType<typeof vi.fn>
  mcpHttpUrl: ReturnType<typeof vi.fn>
  unregister: ReturnType<typeof vi.fn>
}

type GateHarness = {
  setPlanFence: ReturnType<typeof vi.fn>
  getSessionMode: ReturnType<typeof vi.fn<() => ApprovalMode>>
  decide: ReturnType<typeof vi.fn>
  cancelSession: ReturnType<typeof vi.fn>
}

type StartHarness = {
  broker: BrokerHarness
  gate: GateHarness
  dreamSessions: Set<string>
  start: EngineSessionManager['start']
  dispose: EngineSessionManager['dispose']
}

function fakeSession(id: string): EngineSession {
  return {
    id,
    sendTurn: vi.fn(() => true),
    interrupt: vi.fn(),
    setApprovalMode: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  }
}

afterEach(() => {
  harness.loadSessionAgentRole.mockReset().mockReturnValue('adaptive')
  harness.startCodexSession.mockReset()
})

describe('session orchestrator preference wiring', () => {
  it('carries the opted-in install role into the actual Codex session instructions', async () => {
    harness.loadSessionAgentRole.mockReturnValue('orchestrator')
    harness.startCodexSession.mockImplementation((_onEvent, opts: { sessionId: string }) =>
      fakeSession(opts.sessionId),
    )

    const manager = new EngineSessionManager() as unknown as StartHarness
    manager.broker = {
      ensureListening: vi.fn().mockResolvedValue(undefined),
      register: vi.fn().mockResolvedValue(undefined),
      tokenFor: vi.fn(() => undefined),
      mcpHttpUrl: vi.fn(() => 'http://127.0.0.1:1/mcp/session'),
      unregister: vi.fn().mockResolvedValue(undefined),
    }
    manager.gate = {
      setPlanFence: vi.fn(),
      getSessionMode: vi.fn(() => 'auto'),
      decide: vi.fn(),
      cancelSession: vi.fn(),
    }

    const started = await manager.start({ cwd: process.cwd(), engineId: 'codex' })
    const options = harness.startCodexSession.mock.calls[0]?.[1] as
      | { developerInstructions?: string }
      | undefined

    expect(harness.loadSessionAgentRole).toHaveBeenCalledOnce()
    expect(options?.developerInstructions).toContain('Lead through delegation')
    expect(options?.developerInstructions).toContain('Load `fan-out-work`')

    await manager.dispose(started.sessionId)
  })

  it('keeps unattended Dream and REM sessions out of the orchestrator role', async () => {
    harness.loadSessionAgentRole.mockReturnValue('orchestrator')
    harness.startCodexSession.mockImplementation((_onEvent, opts: { sessionId: string }) =>
      fakeSession(opts.sessionId),
    )

    const manager = new EngineSessionManager() as unknown as StartHarness
    manager.broker = {
      ensureListening: vi.fn().mockResolvedValue(undefined),
      register: vi.fn().mockResolvedValue(undefined),
      tokenFor: vi.fn(() => undefined),
      mcpHttpUrl: vi.fn(() => 'http://127.0.0.1:1/mcp/session'),
      unregister: vi.fn().mockResolvedValue(undefined),
    }
    manager.gate = {
      setPlanFence: vi.fn(),
      getSessionMode: vi.fn(() => 'auto'),
      decide: vi.fn(),
      cancelSession: vi.fn(),
    }
    const sessionId = 'dream-system-session'
    manager.dreamSessions.add(sessionId)

    const started = await manager.start({ cwd: process.cwd(), engineId: 'codex', sessionId })
    const options = harness.startCodexSession.mock.calls[0]?.[1] as
      | { developerInstructions?: string }
      | undefined

    expect(harness.loadSessionAgentRole).not.toHaveBeenCalled()
    expect(options?.developerInstructions).not.toContain('Lead through delegation')
    expect(options?.developerInstructions).not.toContain('Load `fan-out-work`')

    await manager.dispose(started.sessionId)
  })
})
