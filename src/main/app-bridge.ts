/**
 * The mini-app bridge, Lane B: plain inference calls (mini-apps-plan.md "Bridge v0 plumbing").
 *
 * A mini app never holds provider credentials — AI designed into its own UX calls ONE host endpoint
 * on a loopback server Koda's main process runs, authenticated by a per-app token the supervisor
 * hands it at start (exactly like PORT via env). The endpoint executes the completion with the user's
 * already-stored BYO Anthropic API key (api-key.ts — the existing billing-modes key space; the key
 * itself never enters the app folder) and only for apps the owner explicitly allowed in Settings
 * ("<App> may use your API key" — default OFF, user-visible-never-silent), with per-app spend
 * recorded so the toggle can show what each app has cost.
 *
 * Why a proxy and not the key: share-an-app = share-the-folder, so a baked-in key would ride along
 * to every recipient; per-app revoke + spend visibility; and this endpoint IS the chokepoint that
 * makes the subscription/API billing split enforceable (Lane A agent turns ride the subscription;
 * anything an app fires itself is API-billed here).
 */
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { getApiKey } from './api-key'
import { log } from './logger'
import { publishedRate } from '@shared/model-pricing'

// ── Tier map ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The ONE sanctioned place Koda names models (RB decision 2026-07-19): apps ask for a TIER, never a
 * model id, so generated apps don't bake in names that rot. Update models + prices here when the
 * catalog moves. Prices are USD per million tokens, used only for the user-facing spend estimate.
 */
export const BRIDGE_TIERS = {
  fast: { model: 'claude-haiku-4-5' },
  smart: { model: 'claude-sonnet-5' },
} as const
export type BridgeTier = keyof typeof BRIDGE_TIERS

// ── Request contract ──────────────────────────────────────────────────────────────────────────────

/** POST /v1/infer body — prompt in, completion out; that's the whole surface. */
export const InferRequestSchema = z.object({
  prompt: z.string().min(1).max(200_000),
  system: z.string().max(50_000).optional(),
  tier: z.enum(['fast', 'smart']).default('fast'),
  maxTokens: z.number().int().min(1).max(8192).default(1024),
})
export type InferRequest = z.infer<typeof InferRequestSchema>

/**
 * Measured tokens at the tier model's published rate — the spend line, not an invoice. Rates come from
 * `shared/model-pricing.ts` so this file and the Usage view can never quote a model differently; a tier
 * pointed at a model that table can't price bills 0 here, which `app-bridge.test.ts` guards against.
 */
export function estimateUsd(tier: BridgeTier, inputTokens: number, outputTokens: number): number {
  const rate = publishedRate(BRIDGE_TIERS[tier].model)
  if (!rate) return 0
  return (inputTokens * rate.inputPerMTok + outputTokens * rate.outputPerMTok) / 1_000_000
}

// ── Per-app consent + spend store ─────────────────────────────────────────────────────────────────

export interface BridgeAppState {
  consent: boolean
  spend: { inputTokens: number; outputTokens: number; usd: number }
}

/** Keyed by the app's absolute dir (the supervisor's app identity). Persisted to userData —
 *  app-lifetime state, same fail-soft posture as the mini-apps registry. */
const appState = new Map<string, BridgeAppState>()
let stateLoaded: Promise<void> | null = null

const stateFile = (): string => join(app.getPath('userData'), 'app-bridge.json')

function ensureState(): Promise<void> {
  stateLoaded ??= (async () => {
    try {
      const raw = JSON.parse(await readFile(stateFile(), 'utf8')) as {
        apps?: Record<string, BridgeAppState>
      }
      for (const [dir, s] of Object.entries(raw.apps ?? {})) {
        if (s && typeof s.consent === 'boolean' && s.spend) appState.set(dir, s)
      }
    } catch {
      // first run / unreadable — every app starts with consent off, zero spend
    }
  })()
  return stateLoaded
}

async function saveState(): Promise<void> {
  try {
    await writeFile(stateFile(), JSON.stringify({ apps: Object.fromEntries(appState) }, null, 2))
  } catch (err) {
    log.warn('app-bridge', 'failed to persist bridge state', err instanceof Error ? err.message : err)
  }
}

function stateFor(dir: string): BridgeAppState {
  let s = appState.get(dir)
  if (!s) {
    s = { consent: false, spend: { inputTokens: 0, outputTokens: 0, usd: 0 } }
    appState.set(dir, s)
  }
  return s
}

/** Settings reads this (joined with the registry's names by dir in ipc.ts). */
export async function bridgeAppState(dir: string): Promise<BridgeAppState> {
  await ensureState()
  // Return a copy — the live object mutates as calls land.
  const s = stateFor(dir)
  return { consent: s.consent, spend: { ...s.spend } }
}

/** The Settings toggle — the owner's explicit, per-app "may use my API key". */
export async function setBridgeConsent(dir: string, allowed: boolean): Promise<void> {
  await ensureState()
  stateFor(dir).consent = allowed
  await saveState()
}

async function recordSpend(dir: string, tier: BridgeTier, inputTokens: number, outputTokens: number): Promise<void> {
  await ensureState()
  const s = stateFor(dir).spend
  s.inputTokens += inputTokens
  s.outputTokens += outputTokens
  s.usd += estimateUsd(tier, inputTokens, outputTokens)
  await saveState()
}

// ── Per-app tokens ────────────────────────────────────────────────────────────────────────────────

/** In-memory only, per Koda run — a fresh token every app start, revoking the previous one. The app
 *  reads it from env at start, so a restart always has the current token. */
const tokenToDir = new Map<string, string>()
const dirToToken = new Map<string, string>()

export function issueBridgeToken(dir: string): string {
  const prior = dirToToken.get(dir)
  if (prior) tokenToDir.delete(prior)
  const token = randomBytes(32).toString('hex')
  tokenToDir.set(token, dir)
  dirToToken.set(dir, token)
  return token
}

// ── The completion call ───────────────────────────────────────────────────────────────────────────

/** Non-streaming Anthropic Messages call with the stored BYO key. Injectable so tests never hit the
 *  network. Returns the joined text + real usage for the spend record. */
type CompleteFn = (
  apiKey: string,
  req: InferRequest,
) => Promise<{ text: string; model: string; inputTokens: number; outputTokens: number }>

async function completeViaAnthropic(
  apiKey: string,
  req: InferRequest,
): Promise<{ text: string; model: string; inputTokens: number; outputTokens: number }> {
  const tier = BRIDGE_TIERS[req.tier]
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: tier.model,
      max_tokens: req.maxTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: [{ role: 'user', content: req.prompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    let detail = ''
    try {
      const err = (await res.json()) as { error?: { message?: string } }
      detail = err.error?.message ?? ''
    } catch {
      // non-JSON error body — status alone will have to do
    }
    throw new Error(`the AI provider returned ${res.status}${detail ? ` — ${detail}` : ''}`)
  }
  const body = (await res.json()) as {
    model: string
    content: Array<{ type: string; text?: string }>
    usage: { input_tokens: number; output_tokens: number }
  }
  return {
    text: body.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(''),
    model: body.model,
    inputTokens: body.usage.input_tokens,
    outputTokens: body.usage.output_tokens,
  }
}

let completeFn: CompleteFn = completeViaAnthropic
/** Test seam — swap the provider call out; returns a restore function. */
export function _setCompleteForTest(fn: CompleteFn | null): void {
  completeFn = fn ?? completeViaAnthropic
}

// ── The loopback server ───────────────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 1_000_000

let server: http.Server | null = null
let serverPort: Promise<number> | null = null

/** Lazy singleton — started by the first app launch, so with mini-apps off (or no apps) nothing
 *  listens. Loopback only; auth is the per-app bearer token. */
export function ensureBridgeServer(): Promise<number> {
  serverPort ??= new Promise((resolve, reject) => {
    server = http.createServer((req, res) => void handle(req, res))
    server.once('error', (err) => {
      serverPort = null
      server = null
      reject(err)
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server!.address() as { port: number }).port
      log.info('app-bridge', 'bridge listening', { port })
      resolve(port)
    })
  })
  return serverPort
}

export function disposeBridgeServer(): void {
  server?.close()
  server = null
  serverPort = null
}

function reply(res: http.ServerResponse, status: number, body: object): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(json)
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    if (req.method !== 'POST' || req.url !== '/v1/infer') {
      return reply(res, 404, { error: 'the bridge has one endpoint: POST /v1/infer' })
    }
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
    const dir = tokenToDir.get(token)
    if (!dir) {
      return reply(res, 401, {
        error: 'missing or stale bridge token — read KODA_BRIDGE_TOKEN from env at every start',
      })
    }

    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY_BYTES) return reply(res, 413, { error: 'request body too large' })
      chunks.push(chunk as Buffer)
    }
    let parsed: InferRequest
    try {
      parsed = InferRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch (err) {
      return reply(res, 400, {
        error: `invalid request — ${err instanceof Error ? err.message : 'bad JSON'}`,
      })
    }

    await ensureState()
    if (!stateFor(dir).consent) {
      return reply(res, 403, {
        error:
          'this app is not allowed to use the API key — the owner can enable it in Settings → AI providers → Anthropic',
      })
    }
    const apiKey = getApiKey('claude')
    if (!apiKey) {
      return reply(res, 402, {
        error: 'no Anthropic API key is connected — add one in Settings → AI providers → Anthropic',
      })
    }

    const result = await completeFn(apiKey, parsed)
    await recordSpend(dir, parsed.tier, result.inputTokens, result.outputTokens)
    onSpendChanged?.()
    return reply(res, 200, {
      text: result.text,
      tier: parsed.tier,
      model: result.model,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    })
  } catch (err) {
    log.warn('app-bridge', 'infer call failed', err instanceof Error ? err.message : err)
    return reply(res, 502, { error: err instanceof Error ? err.message : 'inference failed' })
  }
}

/** ipc.ts hooks this to refresh the Settings spend line live (same posture as the mini-apps
 *  changed listener — a callback, not a BrowserWindow import). */
let onSpendChanged: (() => void) | null = null
export function setBridgeSpendListener(fn: (() => void) | null): void {
  onSpendChanged = fn
}
