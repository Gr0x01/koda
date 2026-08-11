import { describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '@shared/ipc'
import { connectApprovals } from './approval-catchup'

describe('approval renderer catch-up', () => {
  it('restores a prompt that was raised before the renderer subscribed', async () => {
    const pending: ApprovalRequest = {
      sessionId: 'session-1',
      requestId: 'tool-1',
      toolName: 'Bash',
      input: { command: 'npm test' },
    }
    const add = vi.fn()
    const off = vi.fn()
    const bridge = {
      onApprovalRequest: vi.fn(() => off),
      onApprovalResolved: vi.fn(() => off),
      onApprovalCancelled: vi.fn(() => off),
      getPendingApprovals: vi.fn(async () => [pending]),
    }

    connectApprovals(bridge, { add, resolve: vi.fn(), cancel: vi.fn(), failed: vi.fn() })
    await vi.waitFor(() => expect(add).toHaveBeenCalledWith(pending))
  })

  it.each([
    ['resolved', (listeners: Listeners) => listeners.resolved({ sessionId: 'session-1', requestId: 'tool-1' })],
    ['cancelled', (listeners: Listeners) => listeners.cancelled({ sessionId: 'session-1' })],
  ])('does not resurrect a prompt %s while the snapshot is in flight', async (_label, finish) => {
    let release!: (requests: ApprovalRequest[]) => void
    const snapshot = new Promise<ApprovalRequest[]>((resolve) => (release = resolve))
    const { bridge, listeners } = fakeBridge(snapshot)
    const add = vi.fn()
    connectApprovals(bridge, { add, resolve: vi.fn(), cancel: vi.fn(), failed: vi.fn() })

    finish(listeners)
    release([{ sessionId: 'session-1', requestId: 'tool-1', toolName: 'Bash', input: {} }])
    await snapshot
    await Promise.resolve()
    expect(add).not.toHaveBeenCalled()
  })

  it('ignores a snapshot that returns after the renderer unmounts', async () => {
    let release!: (requests: ApprovalRequest[]) => void
    const snapshot = new Promise<ApprovalRequest[]>((resolve) => (release = resolve))
    const { bridge } = fakeBridge(snapshot)
    const add = vi.fn()
    const disconnect = connectApprovals(bridge, { add, resolve: vi.fn(), cancel: vi.fn(), failed: vi.fn() })
    disconnect()
    release([{ sessionId: 'session-1', requestId: 'tool-1', toolName: 'Bash', input: {} }])
    await snapshot
    await Promise.resolve()
    expect(add).not.toHaveBeenCalled()
  })
})

type Listeners = {
  resolved: (event: { sessionId: string; requestId: string }) => void
  cancelled: (event: { sessionId: string }) => void
}

function fakeBridge(snapshot: Promise<ApprovalRequest[]>) {
  const listeners: Listeners = { resolved: () => {}, cancelled: () => {} }
  return {
    listeners,
    bridge: {
      onApprovalRequest: vi.fn(() => vi.fn()),
      onApprovalResolved: vi.fn((listener) => {
        listeners.resolved = listener
        return vi.fn()
      }),
      onApprovalCancelled: vi.fn((listener) => {
        listeners.cancelled = listener
        return vi.fn()
      }),
      getPendingApprovals: vi.fn(() => snapshot),
    },
  }
}
