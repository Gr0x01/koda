import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { PermissionBroker, withApprovalHeartbeat, type KeepDocumentFn } from './server'
import type { ToolDecision } from '@shared/ipc'

/**
 * These guard the ONE invariant the broker exists to keep alive: a tool approval can block on a human
 * indefinitely, but every layer of HTTP/MCP/undici wants to time out an idle request. The keepalive
 * mechanisms (disabled HTTP timeouts + the progress heartbeat) defend that. They're pinned to the
 * engine client's internals — the comments in server.ts literally cite an engine version — so a
 * refactor that "cleans up" a timeout=0 or breaks the heartbeat wiring must fail here, not silently
 * ship an approval that vanishes after ~5 minutes on the next engine bump.
 */

// The broker constructor takes collaborators for every capability; only the one a test names is exercised.
const noop = (async () => {}) as never
function makeBroker(keepDocument: KeepDocumentFn = noop): PermissionBroker {
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
    keepDocument,
    noop, // presentFile
  )
}

/** Connect one MCP client to a registered session, run `use`, and close it. */
async function withClient<T>(broker: PermissionBroker, sessionId: string, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'broker-test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(broker.mcpHttpUrl(sessionId)), {
      requestInit: { headers: { Authorization: `Bearer ${broker.tokenFor(sessionId)}` } },
    }),
  )
  try {
    return await use(client)
  } finally {
    await client.close()
  }
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

/**
 * "Keep this as a document" is one of two halves of offer-and-keep, and only this half is built. The
 * other — Koda deciding on its own that a conversation deserves a document — is deferred behind an
 * unresolved product question, and the audience segment that owns notes describes it as their fear
 * ("my vault is slowly being rewritten behind my back"). The tool description is where that polarity is
 * enforced, because it reaches the agent on every turn whether or not a playbook was routed. These pin
 * it: a future edit that softens the description into "when it seems worth keeping" has to fail here.
 */
describe('keep_document', () => {
  it("states the user-asked polarity and the editorial bar where the agent can't miss them", async () => {
    const broker = makeBroker()
    try {
      await broker.ensureListening()
      await broker.register('keep-schema', { includeApprove: false })
      const tool = await withClient(broker, 'keep-schema', async (client) =>
        (await client.listTools()).tools.find((t) => t.name === 'keep_document'),
      )
      expect(tool).toBeDefined()
      // The half that is built: the user supplies the signal, always.
      expect(tool!.description).toContain('ONLY when they ask')
      expect(tool!.description).toContain('Never on your own initiative')
      // RB's editorial bar, from Documents/Goal sessions.md — a Library of autogenerated sludge is
      // worse than an empty one, so the agent must be told that writing nothing is a valid outcome.
      expect(tool!.description).toContain('an empty result is a valid result')
      // Filing: extend the document that already owns the topic rather than adding a parallel memo.
      expect(tool!.description).toContain('already owns the topic')

      const schema = tool!.inputSchema as { required?: string[]; properties?: Record<string, unknown> }
      expect(schema.required).toEqual(['title', 'description', 'kind', 'body'])
      expect(Object.keys(schema.properties ?? {})).toEqual(['title', 'description', 'kind', 'body', 'folder'])
      expect((schema.properties?.kind as { enum: string[] }).enum).toEqual([
        'plan',
        'decision',
        'research',
        'guide',
        'reference',
        'note',
      ])
    } finally {
      await broker.dispose()
    }
  })

  it('routes every field to the manager and reports where the document landed', async () => {
    const seen: unknown[] = []
    const broker = makeBroker((async (sessionId, args) => {
      seen.push({ sessionId, args })
      return { kept: true as const, path: 'Documents/decisions/Branches.md', title: 'Branches', kind: 'decision' as const }
    }) as KeepDocumentFn)
    try {
      await broker.ensureListening()
      await broker.register('keep-call', { includeApprove: false })
      const result = await withClient(broker, 'keep-call', (client) =>
        client.callTool({
          name: 'keep_document',
          arguments: {
            title: 'Branches',
            description: 'What we settled about branch names and when a branch gets deleted.',
            kind: 'decision',
            body: '# Branches\n\nOne branch per piece of work.\n',
            folder: 'Documents/decisions',
          },
        }),
      )
      expect(result.isError).not.toBe(true)
      // The sessionId is the whole reason this is a broker tool rather than a Write: it becomes the
      // document's provenance, and the agent has no way to know it.
      expect(seen).toEqual([
        {
          sessionId: 'keep-call',
          args: {
            title: 'Branches',
            description: 'What we settled about branch names and when a branch gets deleted.',
            kind: 'decision',
            body: '# Branches\n\nOne branch per piece of work.\n',
            folder: 'Documents/decisions',
          },
        },
      ])
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({
        kept: true,
        path: 'Documents/decisions/Branches.md',
        title: 'Branches',
        kind: 'decision',
      })
    } finally {
      await broker.dispose()
    }
  })

  it('reports a refusal to the agent as a tool error rather than dropping the turn', async () => {
    const broker = makeBroker((async () => {
      throw new Error('description just restates the title')
    }) as KeepDocumentFn)
    try {
      await broker.ensureListening()
      await broker.register('keep-refuse', { includeApprove: false })
      const result = await withClient(broker, 'keep-refuse', (client) =>
        client.callTool({ name: 'keep_document', arguments: { title: 'X', description: 'X', kind: 'note', body: 'x' } }),
      )
      expect(result.isError).toBe(true)
      expect((result.content as Array<{ text: string }>)[0].text).toContain('restates the title')
    } finally {
      await broker.dispose()
    }
  })
})

describe('capabilities directory', () => {
  it('returns exact invocations for only the surfaces registered in this session', async () => {
    const broker = makeBroker()
    try {
      await broker.ensureListening()
      await broker.register('capabilities-default', { includeApprove: false })
      const result = await withClient(broker, 'capabilities-default', (client) =>
        client.callTool({ name: 'capabilities', arguments: {} }),
      )
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text) as {
        capabilities: Array<{ id: string; invoke: string[] }>
      }
      expect(payload.capabilities.map((entry) => entry.id)).toEqual([
        'recovery',
        'preview',
        'stage',
        'environment',
        'documents',
      ])
      expect(payload.capabilities.find((entry) => entry.id === 'preview')?.invoke).toEqual([
        'mcp__koda_broker__preview_file',
        'mcp__koda_broker__preview',
        'mcp__koda_broker__view_preview',
      ])
      expect(payload.capabilities.some((entry) => entry.id === 'mini-apps')).toBe(false)
    } finally {
      await broker.dispose()
    }
  })

  it('filters by goal and includes mini apps only when their tools are enabled', async () => {
    const broker = makeBroker()
    try {
      await broker.ensureListening()
      await broker.register('capabilities-mini', { includeApprove: false, includeMiniApps: true })
      const result = await withClient(broker, 'capabilities-mini', (client) =>
        client.callTool({ name: 'capabilities', arguments: { query: 'lifecycle' } }),
      )
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text) as {
        capabilities: Array<{ id: string; invoke: string[] }>
      }
      expect(payload.capabilities).toEqual([
        expect.objectContaining({
          id: 'mini-apps',
          invoke: expect.arrayContaining(['mcp__koda_broker__app_start', 'mcp__koda_broker__app_status']),
        }),
      ])

      const preview = await withClient(broker, 'capabilities-mini', (client) =>
        client.callTool({ name: 'capabilities', arguments: { query: 'show the app' } }),
      )
      const previewPayload = JSON.parse((preview.content as Array<{ text: string }>)[0].text) as {
        capabilities: Array<{ id: string }>
      }
      expect(previewPayload.capabilities.map((entry) => entry.id)).toContain('preview')
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
