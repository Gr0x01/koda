/**
 * Per-engine record — the Claude-welded bits factored out so a second engine (Codex) can reuse the
 * env chokepoint (`env.ts`), the binary resolver (`binary.ts`), and the session manager without the
 * neutral parts (`EngineSession`, the `EngineEvent` union, the approval gate) caring which engine ran.
 *
 * This is the "EngineProfile split" from architecture/multi-engine-codex.md (Piece 1): the data that
 * differs between engines, kept in one place so the wiring code stays engine-agnostic.
 */
import type { EngineId } from '@shared/ipc'
export type { EngineId }

export interface EngineProfile {
  id: EngineId
  /** The binary's name on disk / in the releases bucket (`claude` | `codex`). */
  binaryName: string
  /**
   * Ambient credentials/toggles that outrank the subscription login or redirect the engine — deleted
   * from the env so none leak in (the billing/trust guarantee). Engine-specific: a stray
   * `ANTHROPIC_API_KEY` silently flips Claude to API billing; `OPENAI_API_KEY` is the Codex analog.
   */
  stripEnvKeys: readonly string[]
  /**
   * Env vars set to freeze the bundled binary at its pinned version. Claude self-replaces unless
   * `DISABLE_AUTOUPDATER=1`; Codex has NO env-var auto-updater (it never self-replaces — `codex update`
   * is a manual subcommand, updates ride Homebrew), so this is empty for Codex and its startup
   * version-*check* is suppressed by a `-c check_for_update_on_startup=false` spawn arg in the driver.
   */
  disableUpdaterEnv: Readonly<Record<string, string>>
  /** The env var the API key is re-injected as, ONLY when the user explicitly chose API billing. */
  apiKeyEnvVar: string
}

/**
 * Claude — the exact behavior `env.ts` and `binary.ts` had before the split. Default profile, so every
 * existing caller (which passes no `engineId`) resolves to this and stays bit-identical.
 */
export const CLAUDE_PROFILE: EngineProfile = {
  id: 'claude',
  binaryName: 'claude',
  stripEnvKeys: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    // Endpoint redirects: a stray base-url silently points the subscription engine at a different
    // server (wrong billing / data-exfil surface). Never inherit them.
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_VERTEX_BASE_URL',
    // We deliberately SHARE the user's ~/.claude home (no custom config dir). Strip any ambient
    // override so the bundled engine always resolves the default home.
    'CLAUDE_CONFIG_DIR',
  ],
  disableUpdaterEnv: { DISABLE_AUTOUPDATER: '1' },
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
}

/**
 * Codex — drive `codex app-server --stdio` on the user's ChatGPT subscription (or a BYO
 * `OPENAI_API_KEY`). Inverted auth-trap vs Claude: an active ChatGPT login *ignores* `OPENAI_API_KEY`,
 * so there's no silent flip-to-API — but we still strip the key in subscription mode (no ambient leak)
 * and re-inject it only in API mode. `CODEX_HOME` redirects the config/credential home, `OPENAI_BASE_URL`
 * redirects the endpoint — both stripped like Claude's analogs.
 */
export const CODEX_PROFILE: EngineProfile = {
  id: 'codex',
  binaryName: 'codex',
  stripEnvKeys: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'],
  disableUpdaterEnv: {},
  apiKeyEnvVar: 'OPENAI_API_KEY',
}

const PROFILES: Record<EngineId, EngineProfile> = {
  claude: CLAUDE_PROFILE,
  codex: CODEX_PROFILE,
}

export function engineProfile(id: EngineId = 'claude'): EngineProfile {
  return PROFILES[id]
}
