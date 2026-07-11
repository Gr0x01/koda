/**
 * Codex engine contract smoke test — drives a CANDIDATE `codex` build through Koda's REAL driver
 * (src/main/engine/codex-driver.ts) and asserts the app-server seams that break silently on a version
 * bump. This is the gate that lets us re-bundle a new Codex engine with confidence — the analog of
 * smoke.test.ts for the second engine.
 *
 * Codex bills to a ChatGPT OAuth login it can't do headlessly, so CI vets with an OpenAI API key instead:
 * buildEngineEnv (the chokepoint) maps { apiMode, apiKey } → OPENAI_API_KEY. The suite SKIPS unless
 * OPENAI_API_KEY is set, so `npm run test:engine-contract` (Claude, ANTHROPIC_API_KEY) never trips it.
 *
 *   OPENAI_API_KEY=sk-… npm run test:engine-contract-codex                          # bundled/dev codex
 *   OPENAI_API_KEY=sk-… KODA_CODEX_CANDIDATE=/tmp/codex npm run test:engine-contract-codex   # a candidate
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EngineEvent } from '@shared/ipc'
import type { EngineSession } from '../../src/main/engine/adapter'
import { startCodexSession } from '../../src/main/engine/codex-driver'
import { resolveEnginePath } from '../../src/main/engine/binary'
import { buildEngineEnv } from '../../src/main/engine/env'

/**
 * Authenticate the isolated CODEX_HOME with an API-key login. Codex's app-server IGNORES OPENAI_API_KEY in
 * the environment for auth (getAuthStatus → authMethod:null) — an api-key login must be WRITTEN into
 * CODEX_HOME via `codex login --with-api-key` (key on stdin). This is the CI auth path (no ChatGPT OAuth
 * headless); `buildEngineEnv({engineId:'codex'})` supplies CODEX_HOME and strips the ambient env key.
 */
function loginCodexWithApiKey(apiKey: string): void {
  const bin = CANDIDATE ?? resolveEnginePath({ binaryName: 'codex' }).path
  const env = buildEngineEnv(process.env, { engineId: 'codex' })
  const home = env.CODEX_HOME as string
  mkdirSync(home, { recursive: true })
  rmSync(join(home, 'auth.json'), { force: true }) // drop any stale ChatGPT login copied in earlier
  execFileSync(bin, ['login', '--with-api-key'], { input: apiKey, env, stdio: ['pipe', 'ignore', 'ignore'] })
}

const CANDIDATE = process.env.KODA_CODEX_CANDIDATE || undefined
const API_KEY = process.env.OPENAI_API_KEY || undefined

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Collects the driver's normalized event stream and lets a check await a specific event. */
class Harness {
  readonly events: EngineEvent[] = []
  readonly session: EngineSession
  constructor(sessionId: string, cwd: string) {
    this.session = startCodexSession((e) => this.events.push(e), {
      sessionId,
      cwd,
      // No tools are needed for the checks below; deny anything the model tries so a turn can't hang.
      decide: async () => ({ kind: 'deny' }),
      ...(CANDIDATE ? { binaryPath: CANDIDATE } : {}),
      ...(API_KEY ? { env: { apiMode: true, apiKey: API_KEY } } : {}),
    })
  }
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

describe.skipIf(!API_KEY)('codex engine contract', () => {
  const sessionId = randomUUID()
  let cwd: string
  let h: Harness
  let firstTurn: EngineEvent[]
  let firstComplete: Extract<EngineEvent, { type: 'TurnComplete' }> | undefined

  beforeAll(async () => {
    // Seed the isolated CODEX_HOME with an api-key login before any codex spawn (env key alone is ignored).
    loginCodexWithApiKey(API_KEY!)
    cwd = mkdtempSync(join(tmpdir(), 'koda-codex-contract-'))
    h = new Harness(sessionId, cwd)
    firstTurn = await h.runTurn('Reply with exactly the word PONG and nothing else.', 180_000)
    firstComplete = firstTurn.find((e) => e.type === 'TurnComplete') as Extract<EngineEvent, { type: 'TurnComplete' }>
  }, 240_000)

  afterAll(async () => {
    await h?.session.dispose().catch(() => {})
  })

  it('Check 1 — init: SessionStarted carries a model', () => {
    const started = firstTurn.find((e) => e.type === 'SessionStarted') as
      | Extract<EngineEvent, { type: 'SessionStarted' }>
      | undefined
    expect(started, 'SessionStarted in the opening stream').toBeTruthy()
    expect(started!.sessionId).toBe(sessionId)
    expect(typeof started!.model).toBe('string')
    expect(started!.model.length).toBeGreaterThan(0)
  })

  it('Check 2 — turn streaming: AssistantDelta → AssistantBlock(PONG) → TurnComplete', () => {
    expect(has(firstTurn, 'AssistantDelta'), 'at least one streamed delta').toBe(true)
    expect(blockText(firstTurn)).toContain('PONG')
    // Codex maps a SUCCESSFUL turn's stopReason to undefined (normalizeTurnStatus); only failures set
    // `error_*`. So the success contract is "not an error code", i.e. undefined here — not truthy.
    expect(firstComplete?.stopReason).toBeUndefined()
  })

  it('Check 3 — usage: TurnComplete reports a sane context', () => {
    const ctx = firstComplete?.context
    expect(ctx, 'TurnComplete.context present').toBeTruthy()
    expect(ctx!.contextTokens).toBeGreaterThan(0)
    if (typeof ctx!.contextWindow === 'number') {
      expect(ctx!.contextTokens).toBeLessThan(ctx!.contextWindow)
    }
  })

  it('Check 4 — interrupt: the turn aborts but the process stays usable', async () => {
    const from = h.events.length
    h.session.sendTurn('Count slowly from 1 to 100, one number per line.')
    await h.waitFor((e) => e.type === 'AssistantDelta', { from, timeout: 90_000, label: 'AssistantDelta (count)' })
    h.session.interrupt()
    await h.waitFor((e) => e.type === 'TurnComplete', { from, timeout: 90_000, label: 'TurnComplete (interrupted)' })
    // Proof of life: a brand-new turn on the SAME process still works.
    const turn = await h.runTurn('Reply with exactly the word ALIVE and nothing else.')
    expect(blockText(turn)).toContain('ALIVE')
  })
})
