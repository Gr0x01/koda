/**
 * The engine environment chokepoint — ported from spike/auth/lib.ts (validated on 2.1.185).
 *
 * THE GUARDRAIL: never pass the ambient environment through wholesale. A stray
 * ANTHROPIC_API_KEY (shell rc, anywhere) silently outranks the subscription and bills at
 * API rates. A Finder-launched .app inherits no shell env, but dev (npm run dev) does — so
 * we always start clean and add back only what we mean to. Every engine spawn MUST go
 * through here.
 *
 * Multi-engine (architecture/multi-engine-codex.md, Piece 1): the engine-specific bits — which
 * ambient keys to strip, how to pin the binary, which env var the API key re-injects as — live in
 * the EngineProfile. `engineId` defaults to 'claude', so every existing caller compiles and behaves
 * bit-identically; a Codex spawn passes `engineId: 'codex'`.
 */
import { homedir } from 'node:os'
import { userPath } from './user-path'
import { engineProfile, type EngineId } from './profile'
import { codexHome } from './codex-home'

export interface EngineEnvOptions {
  /** Which engine this spawn is for — selects the EngineProfile. Defaults to 'claude'. */
  engineId?: EngineId
  /** True only when the user explicitly chose API billing. */
  apiMode?: boolean
  /** The API key to inject in API mode — from Keychain, never from the shell. */
  apiKey?: string
  /** Deliberate tool secrets (Tavily/ScrapingDog/…), injected Keychain→process-env. */
  inject?: Record<string, string>
}

export function buildEngineEnv(
  base: NodeJS.ProcessEnv,
  opts: EngineEnvOptions = {},
): NodeJS.ProcessEnv {
  const profile = engineProfile(opts.engineId)
  const env: NodeJS.ProcessEnv = { ...base }

  for (const key of profile.stripEnvKeys) delete env[key]

  // The shared-home guarantee rests on HOME (the engine resolves ~/.claude from it). A
  // Finder-launched .app gets HOME from launchd, but make the guarantee real, not assumed.
  if (!env.HOME) env.HOME = homedir()

  // Codex gets its OWN isolated home (not the user's ~/.codex) so Koda's bundled skills/subagents
  // plugin installs there without polluting their standalone Codex. Set for EVERY Codex spawn (login,
  // auth probe, driver) so they all agree on the home. CODEX_HOME was stripped above (profile), so
  // this is the sole source. See codex-home.ts.
  if (opts.engineId === 'codex') env.CODEX_HOME = codexHome()

  // Freeze the bundled copy at its pinned version — never let it self-update out from under us.
  // (Claude: DISABLE_AUTOUPDATER=1; Codex: none — it never self-replaces.)
  Object.assign(env, profile.disableUpdaterEnv)

  // Keep subagents running FOREGROUND (inline), not the engine's new background-by-default (≥2.1.197).
  // Koda's UX is human-steered + everything-visible-in-turn: a backgrounded subagent lands its result
  // out-of-band as a notification, so its card renders empty and the turn ends before the answer. This
  // flag restores the inline stream Koda's adapter (and cleanSubagentResult's trailer format) expects.
  // Claude-only; Codex has its own task model.
  if ((opts.engineId ?? 'claude') === 'claude') env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'

  // Give the agent's Bash tool the user's real login-shell PATH. A Finder-launched .app otherwise
  // inherits launchd's minimal PATH and can't find node/npm/python the user has installed.
  env.PATH = userPath()

  // Re-add the API key ONLY when the user explicitly opted into API billing.
  if (opts.apiMode && opts.apiKey) env[profile.apiKeyEnvVar] = opts.apiKey

  // Deliberate tool secrets — nothing arrives from the shell.
  if (opts.inject) Object.assign(env, opts.inject)

  return env
}
