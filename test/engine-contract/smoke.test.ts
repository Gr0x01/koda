/**
 * Engine contract smoke test — drives a CANDIDATE `claude` CLI build through Koda's REAL adapter
 * (src/main/engine/adapter.ts) and asserts the stream-json seams that break silently on a version
 * bump. This is the gate that lets us re-bundle a new engine with confidence.
 *
 * NOT part of `npm test` — it spawns a real engine and spends tokens. Run it explicitly:
 *   npm run test:engine-contract                       # against the bundled engine, your subscription
 *   KODA_ENGINE_CANDIDATE=/tmp/claude npm run test:engine-contract   # against a candidate binary
 *   ANTHROPIC_API_KEY=sk-… KODA_ENGINE_CANDIDATE=… npm run test:engine-contract   # CI (API billing)
 *
 * Credentials route through buildEngineEnv (the chokepoint we're also testing): with ANTHROPIC_API_KEY
 * set we pass { apiMode, apiKey } so CI bills to the API; unset ⇒ the ambient ~/.claude subscription.
 *
 * Note: the engine emits system/init (→ SessionStarted) only AFTER the first turn is written to stdin,
 * not on bare spawn — so the opening turn is driven in beforeAll and Checks 1–3 assert against it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EngineEvent } from '@shared/ipc'
import { startClaudeSession, type EngineSession, type SessionOpts } from '../../src/main/engine/adapter'

const CANDIDATE = process.env.KODA_ENGINE_CANDIDATE || undefined
const API_KEY = process.env.ANTHROPIC_API_KEY || undefined

const baseOpts = (extra: Partial<SessionOpts>): SessionOpts => ({
  ...(CANDIDATE ? { binaryPath: CANDIDATE } : {}),
  ...(API_KEY ? { env: { apiMode: true, apiKey: API_KEY } } : {}),
  ...extra,
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Collects the adapter's normalized event stream and lets a check await a specific event. */
class Harness {
  readonly events: EngineEvent[] = []
  readonly session: EngineSession
  constructor(opts: SessionOpts) {
    this.session = startClaudeSession((e) => this.events.push(e), opts)
  }
  /** Resolve with the first event at/after `from` matching `match`; reject on fatal error or timeout. */
  async waitFor(
    match: (e: EngineEvent) => boolean,
    { from = 0, timeout = 90_000, label = 'event' }: { from?: number; timeout?: number; label?: string } = {},
  ): Promise<{ event: EngineEvent; index: number }> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const idx = this.events.findIndex((e, i) => i >= from && match(e))
      if (idx >= 0) return { event: this.events[idx], index: idx }
      const fatal = this.events.find(
        (e, i) => i >= from && e.type === 'EngineError' && (e as Extract<EngineEvent, { type: 'EngineError' }>).fatal,
      )
      if (fatal) throw new Error(`fatal engine error while awaiting ${label}: ${(fatal as any).message}`)
      await sleep(100)
    }
    throw new Error(`timed out (${timeout}ms) awaiting ${label}; last seen: ${this.events.slice(-6).map((e) => e.type).join(', ')}`)
  }
  /** Send a turn and resolve once its TurnComplete lands; returns the events for that turn. */
  async runTurn(text: string, timeout = 120_000): Promise<EngineEvent[]> {
    const from = this.events.length
    this.session.sendTurn(text)
    const { index } = await this.waitFor((e) => e.type === 'TurnComplete', { from, timeout, label: 'TurnComplete' })
    return this.events.slice(from, index + 1)
  }
}

const has = (events: EngineEvent[], type: EngineEvent['type']): boolean => events.some((e) => e.type === type)

const blockText = (events: EngineEvent[]): string =>
  events
    .filter((e): e is Extract<EngineEvent, { type: 'AssistantBlock' }> => e.type === 'AssistantBlock')
    .map((e) => e.markdown)
    .join('\n')
    .toUpperCase()

describe('engine contract', () => {
  const sessionId = randomUUID()
  let cwd: string
  let h: Harness
  let firstTurn: EngineEvent[]
  let firstComplete: Extract<EngineEvent, { type: 'TurnComplete' }> | undefined

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'koda-engine-contract-'))
    h = new Harness(baseOpts({ sessionId, cwd }))
    // Drive the opening turn; its stream carries SessionStarted + the PONG reply that Checks 1–3 read.
    firstTurn = await h.runTurn('Reply with exactly the word PONG and nothing else.')
    firstComplete = firstTurn.find((e) => e.type === 'TurnComplete') as Extract<EngineEvent, { type: 'TurnComplete' }>
  }, 180_000)

  afterAll(async () => {
    await h?.session.dispose().catch(() => {})
  })

  it('Check 1 — init: SessionStarted carries model + tools', () => {
    const started = firstTurn.find((e) => e.type === 'SessionStarted') as
      | Extract<EngineEvent, { type: 'SessionStarted' }>
      | undefined
    expect(started, 'SessionStarted in the opening stream').toBeTruthy()
    expect(started!.sessionId).toBe(sessionId)
    expect(typeof started!.model).toBe('string')
    expect(started!.model.length).toBeGreaterThan(0)
    expect(Array.isArray(started!.tools)).toBe(true)
    expect(started!.tools.length).toBeGreaterThan(0)
  })

  it('Check 2 — turn streaming: AssistantDelta → AssistantBlock(PONG) → TurnComplete', () => {
    expect(has(firstTurn, 'AssistantDelta'), 'at least one streamed delta').toBe(true)
    expect(blockText(firstTurn)).toContain('PONG')
    expect(firstComplete?.stopReason).toBeTruthy()
  })

  it('Check 3 — usage: TurnComplete reports a sane context (not the cumulative-usage bug)', () => {
    const ctx = firstComplete?.context
    expect(ctx, 'TurnComplete.context present').toBeTruthy()
    expect(ctx!.contextTokens).toBeGreaterThan(0)
    expect(ctx!.outputTokens).toBeGreaterThan(0)
    // A single-step "PONG" reply can never fill the window; a cumulative-usage regression would blow past it.
    if (typeof ctx!.contextWindow === 'number') {
      expect(ctx!.contextTokens).toBeLessThan(ctx!.contextWindow)
    }
  })

  it('Check 4 — interrupt: control_request aborts the turn but the process stays usable', async () => {
    const from = h.events.length
    h.session.sendTurn('Count slowly from 1 to 100, one number per line.')
    await h.waitFor((e) => e.type === 'AssistantDelta', { from, timeout: 90_000, label: 'AssistantDelta (count)' })
    h.session.interrupt()
    await h.waitFor((e) => e.type === 'TurnComplete', { from, timeout: 90_000, label: 'TurnComplete (interrupted)' })
    // Proof of life: a brand-new turn on the SAME process still works.
    const turn = await h.runTurn('Reply with exactly the word ALIVE and nothing else.')
    expect(blockText(turn)).toContain('ALIVE')
  })

  it('Check 5 — subagent runs foreground: its result lands inline in the same turn', async () => {
    // Regression guard for the engine's background-by-default subagents (≥2.1.197): backgrounded, the
    // turn ends before the subagent finishes and its result never lands inline. buildEngineEnv sets
    // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 to keep them foreground — this proves the answer is in-turn.
    const turn = await h.runTurn(
      'Use the Task tool to launch a general-purpose subagent whose only job is to reply with exactly the word BANANA. Wait for it, then tell me the single word it replied with.',
      180_000,
    )
    expect(has(turn, 'SubagentStarted'), 'a subagent was launched').toBe(true)
    // The result is narrated inline by the main assistant only when the subagent ran to completion in-turn.
    expect(blockText(turn)).toContain('BANANA')
  })

  it('Check 6 — resume: --resume reattaches the conversation with context intact', async () => {
    await h.session.dispose()
    const h2 = new Harness(baseOpts({ sessionId, cwd, resume: true }))
    try {
      const turn = await h2.runTurn(
        'Earlier I asked you to reply with one specific word first. What was that word? Answer with just the word.',
      )
      expect(has(turn, 'SessionStarted'), 'resumed session re-emits SessionStarted').toBe(true)
      expect(blockText(turn)).toContain('PONG')
    } finally {
      await h2.session.dispose()
    }
  })
})
