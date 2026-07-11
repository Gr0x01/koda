/**
 * API-key storage for the opt-in API-billing mode (BYO key, Cursor-style), per engine.
 *
 * Each engine bills a DIFFERENT provider account, so each gets its own encrypted key slot: Claude's
 * `sk-ant-…` and Codex's OpenAI `sk-…`. Keys are encrypted at rest with Electron `safeStorage`
 * (Keychain-backed on macOS — no native dependency) and written as base64 ciphertext to per-engine files
 * in userData. They are NEVER written to koda-settings.json, never logged, and never sent to the renderer
 * (the UI only learns whether a key EXISTS). The plaintext is read in-process only to inject into a session
 * spawn via buildEngineEnv({ apiMode, apiKey }) — the chokepoint that otherwise strips ambient credentials.
 * (Codex additionally needs the key WRITTEN into its isolated home via `codex login --with-api-key`; the env
 * var alone is ignored — see reconcileCodexAuth in codex-home.ts.)
 *
 * Every entry point is fail-soft: encryption unavailable / a corrupt file / a write failure degrades to
 * "no key" rather than throwing, so a storage hiccup falls back to subscription billing, never a crash.
 */
import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineId } from '@shared/ipc'
import { log } from './logger'

/** Per-engine key file. Claude keeps the original `billing-key.enc` name (no migration for existing
 *  installs); other engines get a suffixed file. */
function keyPath(engine: EngineId): string {
  const name = engine === 'claude' ? 'billing-key.enc' : `billing-key-${engine}.enc`
  return join(app.getPath('userData'), name)
}

/** Whether a stored API key is present AND decryptable for this engine. A file that won't decrypt reads as
 *  "no key" (the user re-enters it) rather than a half-broken API mode. */
export function hasApiKey(engine: EngineId = 'claude'): boolean {
  return getApiKey(engine) !== null
}

/** Decrypt the stored key for this engine, or null on any failure (missing file, encryption unavailable,
 *  corrupt blob). */
export function getApiKey(engine: EngineId = 'claude'): string | null {
  try {
    const p = keyPath(engine)
    if (!existsSync(p)) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    const plain = safeStorage.decryptString(Buffer.from(readFileSync(p, 'utf8'), 'base64'))
    return plain.trim() || null
  } catch (err) {
    log.warn('api-key', 'could not read stored key', err instanceof Error ? err.message : err)
    return null
  }
}

/** Encrypt + persist the key for this engine. Returns false (and stores nothing) if encryption is
 *  unavailable or the write fails — the caller surfaces that as a save failure rather than silently
 *  dropping to no-key. */
export function setApiKey(engine: EngineId, key: string): boolean {
  const trimmed = key.trim()
  if (!trimmed) return false
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn('api-key', 'encryption unavailable — refusing to store an unencrypted key')
      return false
    }
    writeFileSync(keyPath(engine), safeStorage.encryptString(trimmed).toString('base64'), { mode: 0o600 })
    return true
  } catch (err) {
    log.warn('api-key', 'could not store key', err instanceof Error ? err.message : err)
    return false
  }
}

/** Remove the stored key for this engine (switching back to subscription billing). Fail-soft. */
export function clearApiKey(engine: EngineId = 'claude'): void {
  try {
    rmSync(keyPath(engine), { force: true })
  } catch (err) {
    log.warn('api-key', 'could not clear key', err instanceof Error ? err.message : err)
  }
}
