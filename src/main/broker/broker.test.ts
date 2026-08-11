import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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
    async () => ({ url: 'koda-preview://test' }), // previewFile
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

  it('keeps Koda tools available when Codex rebuilds its MCP connection between turns', async () => {
    const broker = makeBroker()
    const sessionId = 'codex-refresh'
    try {
      await broker.ensureListening()
      await broker.register(sessionId, { includeApprove: false })
      const token = broker.tokenFor(sessionId)
      expect(token).toBeTruthy()

      const connectAndList = async (callPreview = false): Promise<string[]> => {
        const client = new Client({ name: 'codex-refresh-test', version: '1.0.0' })
        const transport = new StreamableHTTPClientTransport(new URL(broker.mcpHttpUrl(sessionId)), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        })
        await client.connect(transport)
        const tools = (await client.listTools()).tools.map((tool) => tool.name)
        if (callPreview) {
          const result = await client.callTool({ name: 'preview_file', arguments: { path: '.koda/scratch/test.html' } })
          expect(result.isError).not.toBe(true)
        }
        await client.close()
        return tools
      }

      expect(await connectAndList()).toContain('preview_file')
      // Codex drops all RunningServices before the next turn, then initializes the same configured
      // endpoint again. This second connection used to get no Koda tools for the rest of the chat.
      expect(await connectAndList(true)).toContain('preview_file')

      const connectOnly = async (): Promise<Client> => {
        const client = new Client({ name: 'codex-overlap-test', version: '1.0.0' })
        await client.connect(new StreamableHTTPClientTransport(new URL(broker.mcpHttpUrl(sessionId)), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }))
        return client
      }
      // Retries may overlap while Codex rebuilds its services. The superseded client may lose its MCP
      // session, but the replacements must not race Server.close/connect or wedge the logical session.
      const overlapping = await Promise.allSettled([connectOnly(), connectOnly()])
      await Promise.all(overlapping.flatMap((result) => result.status === 'fulfilled' ? [result.value.close()] : []))
      expect(await connectAndList(true)).toContain('preview_file')

      const internal = broker as unknown as {
        sessions: Map<string, { initializeChain: Promise<void>; keepalive: NodeJS.Timeout }>
      }
      const entry = internal.sessions.get(sessionId)!
      const keepaliveBeforeClose = entry.keepalive
      let release!: () => void
      const barrier = new Promise<void>((resolve) => { release = resolve })
      entry.initializeChain = barrier
      const reconnecting = connectOnly()
      // Wait until the request has actually queued behind our barrier, then close the logical session.
      for (let i = 0; i < 100 && entry.initializeChain === barrier; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      expect(entry.initializeChain).not.toBe(barrier)
      const unregistering = broker.unregister(sessionId)
      release()
      await unregistering
      await Promise.allSettled([reconnecting])
      expect(internal.sessions.has(sessionId)).toBe(false)
      expect(entry.keepalive).toBe(keepaliveBeforeClose)
      expect((entry.keepalive as NodeJS.Timeout & { _destroyed?: boolean })._destroyed).toBe(true)
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
