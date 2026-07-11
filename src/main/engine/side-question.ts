/**
 * Side questions ("btw" / aside) — a throwaway one-shot query that has the FULL context of a live
 * session but never touches its conversation. The mechanism (spike/btw, verified vs the real engine):
 *
 *   claude -p … --resume <parentId> --fork-session --no-session-persistence
 *
 * `--fork-session` copies the parent's history into a NEW session id, so the parent transcript is left
 * untouched (proven: the parent's still-alive process never sees the aside's turns); `--no-session-
 * persistence` means the fork leaves nothing on disk. We send ONE user turn, stream the answer, then
 * kill it. NB: this re-reads the conversation, so the prompt cache is NOT reused (claude-code-guide) —
 * an aside on a large context isn't free; it's a deliberate, user-triggered cost.
 *
 * No tools: an aside answers only from what's already in the conversation. The hard guarantee is
 * `--strict-mcp-config` with NO `--mcp-config` → ZERO MCP servers load, so the user's connected
 * Notion/Supabase/Gmail tools (some of which WRITE) simply don't exist in the fork — a "harmless
 * question" can't mutate anything. bypassPermissions auto-allows anything NOT denied, so we also deny
 * the built-in mutators/readers (+ a redundant `mcp__*`/Skill/Agent belt). The system prompt tells the
 * model it has no tools, so it answers cleanly instead of hallucinating a tool use (spike/btw
 * run-denial). Every spawn goes through buildEngineEnv() — the billing/credential chokepoint (CLAUDE.md).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { resolveEnginePath } from './binary'
import { buildEngineEnv, type EngineEnvOptions } from './env'

// A STATIC FLOOR of tool names to deny. The PRIMARY defense is denying exactly the tools THIS engine
// version advertised at session start (opts.advertisedTools, from system/init) — that's version-proof, so
// a tool a future engine adds is denied automatically instead of silently going visible+executable under
// bypassPermissions. This floor only covers names that might exist but not be advertised in a given run.
// A BARE tool name (no `Bash(...)` scope) removes the tool from the model's context entirely — the fork
// never sees it, so it answers from context instead of burning its one turn attempting denied-but-visible
// tools (claude-code-guide). `--strict-mcp-config` (below) already drops the whole MCP surface, so the
// `mcp__*`/MCP-resource entries are belt only.
const SIDE_DISALLOWED = [
  'Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'Workflow',
  'mcp__*', 'ListMcpResources', 'ReadMcpResource',
]

const SIDE_PROMPT =
  'You are answering a quick SIDE QUESTION about an ongoing conversation. You have NO tools — you ' +
  'cannot read files, run commands, search, or edit anything. Answer ONLY from the existing ' +
  'conversation context, concisely. If the question genuinely needs a tool, say in one line that it ' +
  "can't be answered as a side question and to ask in the main chat. Never claim to perform an action " +
  'you cannot do.'

const STDERR_CAP = 2000
const SIDE_TIMEOUT_MS = 90_000

export interface SideQuestionCallbacks {
  onDelta: (text: string) => void
  onDone: (fullText: string) => void
  onError: (message: string) => void
}

export interface SideQuestionHandle {
  cancel(): void
}

export function askSideQuestion(
  opts: {
    parentSessionId: string
    cwd: string
    question: string
    /** Tool names the engine advertised for the parent session (system/init). Denied by bare name so the
     *  fork's tool context is exactly this engine version's surface — nothing visible, nothing executable. */
    advertisedTools?: string[]
    /** Billing parity with the parent: apiMode/apiKey only when the user chose API billing. */
    env?: EngineEnvOptions
    resourcesPath?: string
  },
  cb: SideQuestionCallbacks,
): SideQuestionHandle {
  const loc = resolveEnginePath({ resourcesPath: opts.resourcesPath })
  const env = buildEngineEnv(process.env, opts.env)
  const disallowed = Array.from(new Set([...SIDE_DISALLOWED, ...(opts.advertisedTools ?? [])]))

  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(
      loc.path,
      [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose', // required for stream-json output (spike/layer-a)
        '--include-partial-messages', // text_delta for live paint
        '--resume', opts.parentSessionId,
        '--fork-session', // new id — parent transcript untouched (spike/btw)
        '--no-session-persistence', // throwaway: nothing left on disk
        '--strict-mcp-config', // + no --mcp-config below ⇒ load ZERO MCP servers (no user write-tools)
        '--append-system-prompt', SIDE_PROMPT,
        ...disallowed.flatMap((t) => ['--disallowedTools', t]),
        // No broker for the fork; the deny list above is the whole gate. bypassPermissions avoids a
        // prompt-hang on any tool the model attempts despite the system prompt.
        '--permission-mode', 'bypassPermissions',
      ],
      { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams
  } catch (err) {
    // Defer so the caller can store the returned handle before any callback fires (sessions.ts records
    // the handle right after this returns; a synchronous onError would race that).
    const message = `couldn't start the side question: ${(err as Error).message}`
    queueMicrotask(() => cb.onError(message))
    return { cancel() {} }
  }

  let buf = ''
  let full = ''
  let stderr = ''
  let settled = false

  const kill = (): void => {
    clearTimeout(watchdog)
    try { child.stdin.end() } catch { /* half-dead pipe */ }
    try { child.kill('SIGINT') } catch { /* already gone */ }
  }
  const done = (): void => { if (settled) return; settled = true; cb.onDone(full.trim()); kill() }
  const fail = (m: string): void => { if (settled) return; settled = true; cb.onError(m); kill() }
  // Bound the fork: if the engine wedges (network stall) and neither `result` nor `close` ever arrives,
  // settle with an error instead of leaking the process until dismiss/dispose. Cleared on any settle.
  const watchdog = setTimeout(() => fail('the side question timed out'), SIDE_TIMEOUT_MS)

  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let ev: Record<string, any>
      try { ev = JSON.parse(line) } catch { continue } // partial/garbage line
      if (ev.type === 'stream_event') {
        const delta = ev?.event?.delta
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          full += delta.text
          cb.onDelta(delta.text)
        }
      } else if (ev.type === 'assistant' && ev.message?.content && !full) {
        // Fallback if partial deltas didn't fire: take the finalized block text.
        for (const b of ev.message.content) {
          if (b?.type === 'text' && typeof b.text === 'string') full += b.text
        }
      } else if (ev.type === 'result') {
        if (ev.subtype && ev.subtype !== 'success' && !full.trim()) {
          fail("couldn't answer that as a side question")
        } else {
          done()
        }
      }
    }
  })
  child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-STDERR_CAP) })
  child.on('error', (err) => fail(`side question error: ${err.message}`))
  child.on('close', (code) => {
    if (settled) return
    fail(code === 0 ? 'the side question ended with no answer' : `side question stopped (exit ${code})`)
  })

  // The one and only turn: the question itself. Defer a synchronous write failure (same handle-store
  // race as the spawn catch above).
  try {
    const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: opts.question }] } }
    child.stdin.write(JSON.stringify(msg) + '\n')
  } catch (err) {
    const message = `side question input failed: ${(err as Error).message}`
    queueMicrotask(() => fail(message))
  }

  return {
    cancel(): void { if (!settled) { settled = true; kill() } },
  }
}

export function askCodexSideQuestion(
  opts: {
    parentThreadId: string
    cwd: string
    question: string
    model?: string
    effort?: string
    resourcesPath?: string
    env?: EngineEnvOptions
  },
  cb: SideQuestionCallbacks,
): SideQuestionHandle {
  const loc = resolveEnginePath({ resourcesPath: opts.resourcesPath, binaryName: 'codex' })
  const env = buildEngineEnv(process.env, { ...opts.env, engineId: 'codex' })

  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(loc.path, ['app-server', '--stdio', '-c', 'check_for_update_on_startup=false'], {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    const message = `couldn't start the side question: ${(err as Error).message}`
    queueMicrotask(() => cb.onError(message))
    return { cancel() {} }
  }

  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let forkThreadId: string | null = null
  let currentTurnId: string | null = null
  let full = ''
  let stderr = ''
  let settled = false

  const write = (msg: unknown): void => {
    if (child.stdin.writable) child.stdin.write(JSON.stringify(msg) + '\n')
  }
  const rpc = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      write({ id, method, params })
    })
  }
  const kill = (): void => {
    clearTimeout(watchdog)
    try {
      if (forkThreadId && currentTurnId) {
        write({
          id: nextId++,
          method: 'turn/interrupt',
          params: { threadId: forkThreadId, turnId: currentTurnId },
        })
      }
    } catch {
      /* best effort */
    }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  const done = (): void => { if (settled) return; settled = true; cb.onDone(full.trim()); kill() }
  const fail = (m: string): void => { if (settled) return; settled = true; cb.onError(m); kill() }
  const watchdog = setTimeout(() => fail('the side question timed out'), SIDE_TIMEOUT_MS)

  const rl = readline.createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg: Record<string, any>
    try { msg = JSON.parse(line) } catch { return }

    if (msg.id !== undefined && msg.method === undefined) {
      const slot = pending.get(Number(msg.id))
      if (!slot) return
      pending.delete(Number(msg.id))
      if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)))
      else slot.resolve(msg.result)
      return
    }

    if (msg.id !== undefined && typeof msg.method === 'string') {
      // A side question must not mutate or inspect via tools. Deny approvals, answer user-input
      // requests empty, and ack protocol housekeeping so the app-server does not wedge.
      if (msg.method.endsWith('requestApproval')) write({ id: msg.id, result: { decision: 'decline' } })
      else if (msg.method === 'item/tool/requestUserInput') write({ id: msg.id, result: { answers: {} } })
      else write({ id: msg.id, result: {} })
      return
    }

    if (msg.method === 'item/agentMessage/delta') {
      const delta = String(msg.params?.delta ?? '')
      full += delta
      cb.onDelta(delta)
    } else if (msg.method === 'item/completed' && !full) {
      const item = msg.params?.item
      if (item?.type === 'agentMessage' && typeof item.text === 'string') full += item.text
    } else if (msg.method === 'turn/started') {
      currentTurnId = String(msg.params?.turn?.id ?? msg.params?.turnId ?? currentTurnId ?? '')
    } else if (msg.method === 'turn/completed') {
      done()
    } else if (msg.method === 'error' && !full.trim()) {
      fail(msg.params?.error?.message ?? "couldn't answer that as a side question")
    }
  })

  child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-STDERR_CAP) })
  child.on('error', (err) => fail(`side question error: ${err.message}`))
  child.on('close', (code) => {
    for (const slot of pending.values()) slot.reject(new Error('codex side question process closed'))
    pending.clear()
    if (settled) return
    const tail = stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ''
    fail(code === 0 ? 'the side question ended with no answer' : `side question stopped (exit ${code})${tail}`)
  })

  void (async () => {
    try {
      await rpc('initialize', {
        clientInfo: { name: 'koda', title: 'Koda', version: '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      const model = await pickCodexSideModel(rpc, opts.model)
      const fork = (await rpc('thread/fork', {
        threadId: opts.parentThreadId,
        cwd: opts.cwd,
        model,
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
        ephemeral: true,
        excludeTurns: true,
        ...(opts.effort ? { config: { model_reasoning_effort: opts.effort } } : {}),
        developerInstructions: SIDE_PROMPT,
      })) as { thread?: { id?: string } }
      forkThreadId = fork?.thread?.id ?? null
      if (!forkThreadId) throw new Error('thread/fork returned no thread id')
      const turn = (await rpc('turn/start', {
        threadId: forkThreadId,
        input: [{ type: 'text', text: opts.question, text_elements: [] }],
        approvalPolicy: 'on-request',
      })) as { turn?: { id?: string } }
      currentTurnId = turn?.turn?.id ?? currentTurnId
    } catch (err) {
      fail(`couldn't answer that as a side question: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()

  return {
    cancel(): void { if (!settled) { settled = true; kill() } },
  }
}

async function pickCodexSideModel(
  rpc: (method: string, params: unknown) => Promise<unknown>,
  preferred?: string,
): Promise<string | undefined> {
  const res = (await rpc('model/list', {}).catch(() => null)) as
    | { data?: Array<{ id?: string; isDefault?: boolean }> }
    | null
  const models = (res?.data ?? []).filter((m): m is { id: string; isDefault?: boolean } => !!m.id)
  if (models.length === 0) return preferred
  if (preferred && models.some((m) => m.id === preferred)) return preferred
  return (models.find((m) => m.isDefault) ?? models.find((m) => !m.id.endsWith('-codex')) ?? models[0]).id
}
