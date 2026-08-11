import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  InferRequestSchema,
  estimateUsd,
  BRIDGE_TIERS,
  issueBridgeToken,
  ensureBridgeServer,
  disposeBridgeServer,
  setBridgeConsent,
  bridgeAppState,
  _setCompleteForTest,
} from './app-bridge'

// The key store is Keychain-backed and unavailable in plain Node — mock it so the test drives both
// the no-key (402) and key-present (200) paths.
vi.mock('./api-key', () => ({ getApiKey: vi.fn(() => storedKey) }))
let storedKey: string | null = null

/**
 * The bridge's load-bearing seams: the request contract apps build against, the token gate (a stale
 * or missing token must never reach the key), the consent gate (default OFF — an app can never spend
 * on the owner's key without the Settings toggle), and the spend record behind the toggle's label.
 */

describe('infer request contract', () => {
  it('applies defaults: fast tier, 1024 max tokens', () => {
    const r = InferRequestSchema.parse({ prompt: 'hi' })
    expect(r.tier).toBe('fast')
    expect(r.maxTokens).toBe(1024)
  })

  it('rejects an empty prompt and out-of-range maxTokens', () => {
    expect(() => InferRequestSchema.parse({ prompt: '' })).toThrow()
    expect(() => InferRequestSchema.parse({ prompt: 'x', maxTokens: 0 })).toThrow()
    expect(() => InferRequestSchema.parse({ prompt: 'x', maxTokens: 9000 })).toThrow()
    expect(() => InferRequestSchema.parse({ prompt: 'x', tier: 'huge' })).toThrow()
  })
})

describe('spend estimate', () => {
  it('prices by the tier table', () => {
    // 1M input + 1M output at the fast tier = exactly the per-MTok prices summed.
    const t = BRIDGE_TIERS.fast
    expect(estimateUsd('fast', 1_000_000, 1_000_000)).toBeCloseTo(
      t.inputUsdPerMTok + t.outputUsdPerMTok,
    )
    expect(estimateUsd('smart', 0, 0)).toBe(0)
  })
})

describe('the endpoint', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'bridge-app-'))

  afterAll(() => {
    disposeBridgeServer()
    _setCompleteForTest(null)
  })

  async function call(
    token: string | null,
    body: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const port = await ensureBridgeServer()
    const res = await fetch(`http://127.0.0.1:${port}/v1/infer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: (await res.json()) as Record<string, unknown> }
  }

  it('rejects a missing or unknown token', async () => {
    expect((await call(null, { prompt: 'hi' })).status).toBe(401)
    expect((await call('bogus', { prompt: 'hi' })).status).toBe(401)
  })

  it('revokes the prior token when a new one is issued (restart = fresh token)', async () => {
    const first = issueBridgeToken(appDir)
    issueBridgeToken(appDir)
    expect((await call(first, { prompt: 'hi' })).status).toBe(401)
  })

  it('refuses without consent — the default is OFF', async () => {
    const token = issueBridgeToken(appDir)
    const r = await call(token, { prompt: 'hi' })
    expect(r.status).toBe(403)
    expect(String(r.json.error)).toContain('Settings')
  })

  it('with consent but no stored key, says so plainly', async () => {
    await setBridgeConsent(appDir, true)
    storedKey = null
    const token = issueBridgeToken(appDir)
    const r = await call(token, { prompt: 'hi' })
    expect(r.status).toBe(402)
    expect(String(r.json.error)).toContain('API key')
  })

  it('completes and records spend when consented + keyed', async () => {
    await setBridgeConsent(appDir, true)
    storedKey = 'sk-ant-test'
    _setCompleteForTest(async (apiKey, req) => {
      expect(apiKey).toBe('sk-ant-test')
      expect(req.tier).toBe('smart')
      return { text: 'the answer', model: 'test-model', inputTokens: 1000, outputTokens: 500 }
    })
    const token = issueBridgeToken(appDir)
    const r = await call(token, { prompt: 'question', tier: 'smart' })
    expect(r.status).toBe(200)
    expect(r.json.text).toBe('the answer')
    expect((r.json.usage as { inputTokens: number }).inputTokens).toBe(1000)

    const state = await bridgeAppState(appDir)
    expect(state.spend.inputTokens).toBe(1000)
    expect(state.spend.outputTokens).toBe(500)
    expect(state.spend.usd).toBeCloseTo(estimateUsd('smart', 1000, 500))
  })

  it('surfaces a provider failure as 502, not a hang or crash', async () => {
    _setCompleteForTest(async () => {
      throw new Error('the AI provider returned 429')
    })
    const token = issueBridgeToken(appDir)
    const r = await call(token, { prompt: 'question' })
    expect(r.status).toBe(502)
    expect(String(r.json.error)).toContain('429')
  })

  it('rejects malformed bodies with a 400', async () => {
    const token = issueBridgeToken(appDir)
    const port = await ensureBridgeServer()
    const res = await fetch(`http://127.0.0.1:${port}/v1/infer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })
})
