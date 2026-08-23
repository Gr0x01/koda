import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  PermissionBroker,
  withApprovalHeartbeat,
  type CreateDocumentFn,
  type CreateInteractiveFn,
  type DecideFn,
  type KeepDocumentFn,
  type PresentFileFn,
  type StarDocumentFn,
} from './server'
import type { ToolDecision } from '@shared/ipc'
import { ApprovalGate } from './gate'

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
function makeBroker(
  keepDocument: KeepDocumentFn = noop,
  starDocument: StarDocumentFn = noop,
  documents: {
    create?: CreateDocumentFn
    interactive?: CreateInteractiveFn
    /** The Stage receipt a successful create opens the new file through — a spy in the present tests. */
    present?: PresentFileFn
  } = {},
  /** The gate seam. Default auto-allows; the abort test wires a real ApprovalGate here so `approve`
   *  blocks on a human and the request's cancellation can strand-then-clean a real pending slot. */
  decide: DecideFn = async (): Promise<ToolDecision> => ({ kind: 'allow' }),
): PermissionBroker {
  return new PermissionBroker(
    decide,
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
    documents.present ?? noop, // presentFile
    starDocument,
    documents.create ?? noop,
    documents.interactive ?? noop,
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

/**
 * The shelf is project state Koda owns, and the agent reaching it through this tool is what keeps
 * "put that document on my shelf" answerable in conversation instead of only under a mouse. These pin
 * the boundary: the routed call carries the exact path and state, and a refusal from the command comes
 * back as something the agent can read rather than a silent success.
 */
describe('star_document', () => {
  it('routes the path and the state to the one shelf command', async () => {
    const seen: unknown[] = []
    const broker = makeBroker(noop, (async (sessionId, args) => {
      seen.push({ sessionId, args })
      return { path: args.path, starred: args.starred }
    }) as StarDocumentFn)
    try {
      await broker.ensureListening()
      await broker.register('star-call', { includeApprove: false })
      const result = await withClient(broker, 'star-call', (client) =>
        client.callTool({
          name: 'star_document',
          arguments: { path: 'Documents/brief.md', starred: true },
        }),
      )

      expect(result.isError).not.toBe(true)
      expect(seen).toEqual([
        { sessionId: 'star-call', args: { path: 'Documents/brief.md', starred: true } },
      ])
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({
        path: 'Documents/brief.md',
        starred: true,
      })
    } finally {
      await broker.dispose()
    }
  })

  it('reports a bad path as a tool error the agent can act on', async () => {
    const broker = makeBroker(noop, (async () => {
      throw new Error('no document at "Documents/ghost.md"')
    }) as StarDocumentFn)
    try {
      await broker.ensureListening()
      await broker.register('star-refuse', { includeApprove: false })
      const result = await withClient(broker, 'star-refuse', (client) =>
        client.callTool({ name: 'star_document', arguments: { path: 'Documents/ghost.md', starred: true } }),
      )

      expect(result.isError).toBe(true)
      expect((result.content as Array<{ text: string }>)[0].text).toContain('no document at')
    } finally {
      await broker.dispose()
    }
  })

  it('refuses a call with no state instead of guessing which way the user meant it', async () => {
    let called = false
    const broker = makeBroker(noop, (async () => {
      called = true
      return { path: 'x', starred: true }
    }) as StarDocumentFn)
    try {
      await broker.ensureListening()
      await broker.register('star-missing', { includeApprove: false })
      const result = await withClient(broker, 'star-missing', (client) =>
        client.callTool({ name: 'star_document', arguments: { path: 'Documents/brief.md' } }),
      )

      expect(result.isError).toBe(true)
      expect(called).toBe(false)
    } finally {
      await broker.dispose()
    }
  })

  it('advertises the reversible, project-relative contract in the schema', async () => {
    const broker = makeBroker()
    try {
      await broker.ensureListening()
      await broker.register('star-schema', { includeApprove: false })
      const tool = await withClient(broker, 'star-schema', async (client) =>
        (await client.listTools()).tools.find((t) => t.name === 'star_document'),
      )

      expect(tool).toBeDefined()
      expect(tool!.description).toContain('reversible')
      const schema = tool!.inputSchema as { required?: string[]; properties?: Record<string, unknown> }
      expect(schema.required).toEqual(['path', 'starred'])
      expect(Object.keys(schema.properties ?? {})).toEqual(['path', 'starred'])
    } finally {
      await broker.dispose()
    }
  })
})

/**
 * The routing decision — Markdown, HTML, mini app, or "Koda cannot do that yet" — is made before the
 * first word is written, and it is made by the model. So it belongs in the tool descriptions, which
 * reach both engines on every turn, rather than in a playbook that has to be routed to be read (the
 * same reasoning that put keep_document's polarity there). These pin the four branches of that
 * contract: a later edit that trims the description down to "creates a document" has to fail here.
 */
describe('create_document', () => {
  it('states the whole routing contract where both engines see it', async () => {
    const broker = makeBroker()
    try {
      await broker.ensureListening()
      await broker.register('create-schema', { includeApprove: false })
      const tool = await withClient(broker, 'create-schema', async (client) =>
        (await client.listTools()).tools.find((t) => t.name === 'create_document'),
      )

      expect(tool).toBeDefined()
      const description = tool!.description ?? ''
      // Routed by the feedback loop, never by the noun in the request.
      expect(description).toContain('Writing, revising, citing, or maintaining')
      expect(description).toContain('Comparing, inspecting, navigating, or interacting')
      // The two things that are NOT a document, named so the agent does not force them into one.
      expect(description).toContain('mini app, NOT a document')
      expect(description).toContain('Koda cannot produce yet')
      // HTML's security contract is part of the routing, not a footnote: the sandbox blocks external
      // resources, so an artifact born with a linked font renders wrong in the only surface that opens it.
      expect(description).toContain('self-contained')

      const schema = tool!.inputSchema as { required?: string[]; properties?: Record<string, unknown> }
      expect(schema.required).toEqual(['format', 'title'])
      expect(Object.keys(schema.properties ?? {})).toEqual([
        'format',
        'title',
        'kind',
        'description',
        'body',
        'folder',
      ])
      expect((schema.properties?.format as { enum: string[] }).enum).toEqual(['markdown', 'html'])
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

  it('routes every field to the one command and reports where the document landed', async () => {
    const seen: unknown[] = []
    const broker = makeBroker(noop, noop, {
      create: (async (sessionId, args) => {
        seen.push({ sessionId, args })
        return {
          created: true as const,
          path: 'Documents/decisions/Route comparison.html',
          title: 'Route comparison',
          format: 'html' as const,
          kind: 'decision' as const,
        }
      }) as CreateDocumentFn,
    })
    try {
      await broker.ensureListening()
      await broker.register('create-call', { includeApprove: false })
      const result = await withClient(broker, 'create-call', (client) =>
        client.callTool({
          name: 'create_document',
          arguments: {
            format: 'html',
            title: 'Route comparison',
            kind: 'decision',
            description: 'Which shipping route wins under a late order.',
            body: '<p>Two sliders.</p>',
            folder: 'Documents/decisions',
          },
        }),
      )

      expect(result.isError).not.toBe(true)
      // The sessionId is why this is a broker verb rather than a Write: it becomes the document's
      // provenance, and the agent has no way to know it.
      expect(seen).toEqual([
        {
          sessionId: 'create-call',
          args: {
            format: 'html',
            title: 'Route comparison',
            kind: 'decision',
            description: 'Which shipping route wins under a late order.',
            body: '<p>Two sliders.</p>',
            folder: 'Documents/decisions',
          },
        },
      ])
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({
        created: true,
        path: 'Documents/decisions/Route comparison.html',
        title: 'Route comparison',
        format: 'html',
        kind: 'decision',
      })
    } finally {
      await broker.dispose()
    }
  })

  it('passes only the optional fields the agent actually sent', async () => {
    const seen: unknown[] = []
    const broker = makeBroker(noop, noop, {
      create: (async (_sessionId, args) => {
        seen.push(args)
        return {
          created: true as const,
          path: 'Documents/T.md',
          title: 'T',
          format: 'markdown' as const,
          kind: 'note' as const,
        }
      }) as CreateDocumentFn,
    })
    try {
      await broker.ensureListening()
      await broker.register('create-sparse', { includeApprove: false })
      await withClient(broker, 'create-sparse', (client) =>
        client.callTool({ name: 'create_document', arguments: { format: 'markdown', title: 'T' } }),
      )

      // An omitted `kind` has to arrive omitted, not as an empty string: the command's folder fallback
      // is what fills it, and an empty string would fail validation instead of taking that default.
      expect(seen).toEqual([{ format: 'markdown', title: 'T' }])
    } finally {
      await broker.dispose()
    }
  })

  it('reports a refusal as a tool error rather than dropping the turn', async () => {
    const broker = makeBroker(noop, noop, {
      create: (async () => {
        throw new Error('format is required, and must be "markdown" or "html"')
      }) as CreateDocumentFn,
    })
    try {
      await broker.ensureListening()
      await broker.register('create-refuse', { includeApprove: false })
      const result = await withClient(broker, 'create-refuse', (client) =>
        client.callTool({ name: 'create_document', arguments: { format: 'docx', title: 'X' } }),
      )

      expect(result.isError).toBe(true)
      expect((result.content as Array<{ text: string }>)[0].text).toContain('format is required')
    } finally {
      await broker.dispose()
    }
  })

  it('opens the created document on the Stage through the present_file receipt', async () => {
    const presented: Array<{ sessionId: string; args: unknown }> = []
    const broker = makeBroker(noop, noop, {
      create: (async () => ({
        created: true as const,
        path: 'Documents/decisions/Route comparison.html',
        title: 'Route comparison',
        format: 'html' as const,
        kind: 'decision' as const,
      })) as CreateDocumentFn,
      present: (async (sessionId, args) => {
        presented.push({ sessionId, args })
        return { kind: 'present-file' }
      }) as PresentFileFn,
    })
    try {
      await broker.ensureListening()
      await broker.register('create-present', { includeApprove: false })
      const result = await withClient(broker, 'create-present', (client) =>
        client.callTool({ name: 'create_document', arguments: { format: 'html', title: 'Route comparison' } }),
      )

      expect(result.isError).not.toBe(true)
      // Path only, no body attachment and no view override — the same read-only receipt present_file
      // itself emits, on the session that made the document.
      expect(presented).toEqual([
        { sessionId: 'create-present', args: { path: 'Documents/decisions/Route comparison.html' } },
      ])
    } finally {
      await broker.dispose()
    }
  })

  it('still reports the created document when presenting it hiccups', async () => {
    const broker = makeBroker(noop, noop, {
      create: (async () => ({
        created: true as const,
        path: 'Documents/T.md',
        title: 'T',
        format: 'markdown' as const,
        kind: 'note' as const,
      })) as CreateDocumentFn,
      // The written file is the durable outcome; a Stage that has gone away must not fail the create.
      present: (async () => {
        throw new Error('stage is gone')
      }) as PresentFileFn,
    })
    try {
      await broker.ensureListening()
      await broker.register('create-present-fail', { includeApprove: false })
      const result = await withClient(broker, 'create-present-fail', (client) =>
        client.callTool({ name: 'create_document', arguments: { format: 'markdown', title: 'T' } }),
      )

      expect(result.isError).not.toBe(true)
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
        created: true,
        path: 'Documents/T.md',
      })
    } finally {
      await broker.dispose()
    }
  })
})

describe('create_interactive', () => {
  it('carries the same routing rule and says plainly that it will not touch the source', async () => {
    const broker = makeBroker()
    try {
      await broker.ensureListening()
      await broker.register('interactive-schema', { includeApprove: false })
      const tool = await withClient(broker, 'interactive-schema', async (client) =>
        (await client.listTools()).tools.find((t) => t.name === 'create_interactive'),
      )

      expect(tool).toBeDefined()
      const description = tool!.description ?? ''
      expect(description).toContain('mini app, not a document')
      expect(description).toContain('not available yet')
      // The boundary the renderer lane depends on: this verb writes ONE file, and the link back into
      // the narrative is the caller's. An agent that assumes otherwise leaves the source unlinked.
      expect(description).toContain('does not touch the source document')

      const schema = tool!.inputSchema as { required?: string[]; properties?: Record<string, unknown> }
      expect(schema.required).toEqual(['source_path', 'selection', 'title'])
      expect(Object.keys(schema.properties ?? {})).toEqual(['source_path', 'selection', 'title'])
    } finally {
      await broker.dispose()
    }
  })

  it('marshals the snake_case arguments onto the command’s request shape', async () => {
    const seen: unknown[] = []
    const broker = makeBroker(noop, noop, {
      interactive: (async (sessionId, args) => {
        seen.push({ sessionId, args })
        return { ok: true as const, htmlPath: 'Documents/plans/Route comparison.html' }
      }) as CreateInteractiveFn,
    })
    try {
      await broker.ensureListening()
      await broker.register('interactive-call', { includeApprove: false })
      const result = await withClient(broker, 'interactive-call', (client) =>
        client.callTool({
          name: 'create_interactive',
          arguments: {
            source_path: 'Documents/plans/launch.md',
            selection: 'Air freight beats sea by 12 days.',
            title: 'Route comparison',
          },
        }),
      )

      expect(result.isError).not.toBe(true)
      expect(seen).toEqual([
        {
          sessionId: 'interactive-call',
          args: {
            sourcePath: 'Documents/plans/launch.md',
            selection: 'Air freight beats sea by 12 days.',
            title: 'Route comparison',
          },
        },
      ])
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({
        ok: true,
        htmlPath: 'Documents/plans/Route comparison.html',
      })
    } finally {
      await broker.dispose()
    }
  })

  it('turns the command’s refusal RESULT into a tool error', async () => {
    const broker = makeBroker(noop, noop, {
      interactive: (async () => ({ ok: false as const, reason: 'no document at "Documents/ghost.md"' })) as CreateInteractiveFn,
    })
    try {
      await broker.ensureListening()
      await broker.register('interactive-refuse', { includeApprove: false })
      const result = await withClient(broker, 'interactive-refuse', (client) =>
        client.callTool({
          name: 'create_interactive',
          arguments: { source_path: 'Documents/ghost.md', selection: 'x', title: 'T' },
        }),
      )

      // The command answers a refusal as `{ ok: false }` because the Stage renders it as a sentence.
      // For the agent it has to be an ERROR: a success-shaped result reads as "done", and the next turn
      // tells the user about a file that was never written.
      expect(result.isError).toBe(true)
      expect((result.content as Array<{ text: string }>)[0].text).toContain('no document at')
    } finally {
      await broker.dispose()
    }
  })

  it('opens the created HTML view on the Stage beside its source', async () => {
    const presented: Array<{ sessionId: string; args: unknown }> = []
    const broker = makeBroker(noop, noop, {
      interactive: (async () => ({ ok: true as const, htmlPath: 'Documents/plans/Route comparison.html' })) as CreateInteractiveFn,
      present: (async (sessionId, args) => {
        presented.push({ sessionId, args })
        return { kind: 'present-file' }
      }) as PresentFileFn,
    })
    try {
      await broker.ensureListening()
      await broker.register('interactive-present', { includeApprove: false })
      await withClient(broker, 'interactive-present', (client) =>
        client.callTool({
          name: 'create_interactive',
          arguments: { source_path: 'Documents/plans/launch.md', selection: 'x', title: 'Route comparison' },
        }),
      )

      expect(presented).toEqual([
        { sessionId: 'interactive-present', args: { path: 'Documents/plans/Route comparison.html' } },
      ])
    } finally {
      await broker.dispose()
    }
  })

  it('does not present anything when the create is refused', async () => {
    const presented: unknown[] = []
    const broker = makeBroker(noop, noop, {
      interactive: (async () => ({ ok: false as const, reason: 'selection is required' })) as CreateInteractiveFn,
      present: (async (...call) => {
        presented.push(call)
        return { kind: 'present-file' }
      }) as PresentFileFn,
    })
    try {
      await broker.ensureListening()
      await broker.register('interactive-refuse-present', { includeApprove: false })
      const result = await withClient(broker, 'interactive-refuse-present', (client) =>
        client.callTool({
          name: 'create_interactive',
          arguments: { source_path: 'Documents/plans/launch.md', selection: '', title: 'T' },
        }),
      )

      // No file was written, so there is nothing to open — a receipt here would point the Stage at a
      // path that does not exist.
      expect(result.isError).toBe(true)
      expect(presented).toEqual([])
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
        capabilities: Array<{ id: string; outcome: string; invoke: string[] }>
      }
      expect(payload.capabilities.map((entry) => entry.id)).toEqual([
        'recovery',
        'preview',
        'stage',
        'environment',
        'documents',
      ])
      // The documents outcome advertises all four verbs, so the agent learns that Koda can make a
      // document in the right format — and shelve it — at the same moment it learns the surface exists.
      expect(payload.capabilities.find((entry) => entry.id === 'documents')?.invoke).toEqual([
        'mcp__koda_broker__create_document',
        'mcp__koda_broker__create_interactive',
        'mcp__koda_broker__keep_document',
        'mcp__koda_broker__star_document',
      ])
      // The routing rule reaches an agent that asks the directory rather than reading a tool schema.
      expect(payload.capabilities.find((entry) => entry.id === 'documents')?.outcome).toContain(
        'self-contained HTML',
      )
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

describe('per-server idle timeout (mcpConfig)', () => {
  it('sizes the koda_broker timeout for a human answering overnight, so a forced ask is not idle-aborted', async () => {
    const broker = makeBroker()
    try {
      await broker.ensureListening()
      const config = JSON.parse(broker.mcpConfig('cfg-1')) as {
        mcpServers: Record<string, { timeout?: number }>
      }
      // The engine aborts an idle MCP tool after ~1025s by default; this per-server override is the real
      // hold for a pending approval a user hasn't gotten back to (24h in ms).
      expect(config.mcpServers.koda_broker.timeout).toBe(86_400_000)
    } finally {
      await broker.dispose()
    }
  })
})

describe('approve request abort cleans the gate slot (engine-side cancellation)', () => {
  it('a cancelled approve unblocks the handler AND drops the pending gate slot exactly once', async () => {
    const resolved: Array<{ sessionId: string; requestId: string }> = []
    const gate = new ApprovalGate(
      async () => true, // checkpoint
      () => {}, // pushRequest
      () => {}, // pushCancelled
      (sessionId, requestId) => resolved.push({ sessionId, requestId }), // pushResolved
      () => {}, // warn
    )
    const sessionId = 's-abort'
    gate.setSessionMode(sessionId, 'ask') // force every tool to a human ask, so approve blocks
    const broker = makeBroker(noop, noop, {}, (sid, req, signal) => gate.decide(sid, req, signal))
    try {
      await broker.ensureListening()
      await broker.register(sessionId, { includeApprove: true })
      const client = new Client({ name: 'abort-test', version: '1.0.0' })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(broker.mcpHttpUrl(sessionId)), {
          requestInit: { headers: { Authorization: `Bearer ${broker.tokenFor(sessionId)}` } },
        }),
      )
      const controller = new AbortController()
      // The aborted request rejects on the client; capture that so it never becomes an unhandled reject.
      const call = client
        .callTool(
          { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'call-1' } },
          undefined,
          { signal: controller.signal },
        )
        .catch((err) => err)
      // Wait until the gate has actually registered the pending ask before cancelling.
      for (let i = 0; i < 400 && gate.pendingRequests(sessionId).length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(gate.pendingRequests(sessionId)).toHaveLength(1)

      controller.abort() // sends notifications/cancelled → the handler's extra.signal fires
      await call

      // The cancellation crosses the wire; give the server a moment to fire extra.signal and clean up.
      for (let i = 0; i < 400 && gate.pendingRequests(sessionId).length > 0; i += 1) {
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(gate.pendingRequests(sessionId)).toEqual([])
      expect(resolved).toEqual([{ sessionId, requestId: 'call-1' }])
      await client.close()
    } finally {
      await broker.dispose()
    }
  })
})
