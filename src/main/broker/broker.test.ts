import { describe, it, expect } from 'vitest'
import { PermissionBroker, withApprovalHeartbeat } from './server'
import type { ToolDecision } from '@shared/ipc'

/**
 * These guard the ONE invariant the broker exists to keep alive: a tool approval can block on a human
 * indefinitely, but every layer of HTTP/MCP/undici wants to time out an idle request. The keepalive
 * mechanisms (disabled HTTP timeouts + the progress heartbeat) defend that. They're pinned to the
 * engine client's internals — the comments in server.ts literally cite an engine version — so a
 * refactor that "cleans up" a timeout=0 or breaks the heartbeat wiring must fail here, not silently
 * ship an approval that vanishes after ~5 minutes on the next engine bump.
 */

// The broker constructor takes ten collaborators; none are exercised by these transport-level tests.
const noop = (async () => {}) as never
function makeBroker(): PermissionBroker {
  return new PermissionBroker(
    async (): Promise<ToolDecision> => ({ kind: 'allow' }), // decide
    () => {}, // onError
    noop, // listCheckpoints
    noop, // restoreCheckpoint
    noop, // startPreview
    noop, // capturePreview
    noop, // previewFile
    noop, // ensureTool
    noop, // openTerminal
    { install: noop, start: noop, stop: noop, status: noop }, // miniApps
  )
}

describe('broker HTTP keepalive', () => {
  it('ensureListening disables every idle timeout that would drop a pending approval', async () => {
    const broker = makeBroker()
    try {
      await broker.ensureListening()
      // The four caps that, left at their Node defaults, destroy a still-open approval POST mid-wait.
      const http = (broker as unknown as { http: import('node:http').Server }).http
      expect(http.requestTimeout).toBe(0)
      expect(http.headersTimeout).toBe(0)
      expect(http.timeout).toBe(0)
      expect(http.keepAliveTimeout).toBe(0)
    } finally {
      await broker.dispose()
    }
  })
})

describe('approval heartbeat', () => {
  function collector() {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    return { calls, sendNotification: async (n: { method: string; params?: Record<string, unknown> }) => void calls.push(n) }
  }

  it('keeps pinging progress while a decision is pending, so the client timer never fires', async () => {
    const sink = collector()
    // Work outlives several 10ms intervals; expect multiple progress pings addressed to our token.
    await withApprovalHeartbeat(sink, 'tok-1', () => new Promise((r) => setTimeout(r, 55)), 10)
    expect(sink.calls.length).toBeGreaterThanOrEqual(3)
    expect(sink.calls.every((c) => c.method === 'notifications/progress')).toBe(true)
    expect(sink.calls.every((c) => c.params?.progressToken === 'tok-1')).toBe(true)
  })

  it('emits nothing when the client sent no progressToken (nowhere to address a ping)', async () => {
    const sink = collector()
    await withApprovalHeartbeat(sink, undefined, () => new Promise((r) => setTimeout(r, 40)), 10)
    expect(sink.calls).toHaveLength(0)
  })

  it('emits nothing for an instant auto-approval (resolves before the first interval)', async () => {
    const sink = collector()
    await withApprovalHeartbeat(sink, 'tok-2', async () => 'done', 10)
    expect(sink.calls).toHaveLength(0)
  })
})
