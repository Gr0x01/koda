import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Platform bucket — only darwin matters (macOS Speech is macOS-only). */
export const VOICE_PLATFORM = `${process.platform}-${process.arch}`

/**
 * Resolve the compiled voice (Speech) Swift helper, or null when there's no usable backend (non-mac,
 * or the binary hasn't been built). Null is a normal answer — the mic button just stays unavailable;
 * it must NEVER throw the way the engine resolver does (voice is optional, fail-soft like assist).
 *
 * @param opts.resourcesPath  process.resourcesPath in the packaged app (omit in dev/tests).
 */
export function resolveVoiceHelperPath(opts: { resourcesPath?: string } = {}): string | null {
  if (process.platform !== 'darwin') return null // Speech is macOS-only

  const candidates: string[] = []
  // 1. Packaged: <Resources>/voice/<platform>/voice-helper (signed at build time).
  if (opts.resourcesPath) candidates.push(join(opts.resourcesPath, 'voice', VOICE_PLATFORM, 'voice-helper'))
  // 2. Dev: built by `npm run build-voice-helper`.
  candidates.push(join(process.cwd(), 'resources', 'voice', VOICE_PLATFORM, 'voice-helper'))
  // 3. Dev convenience: compiled next to the source (manual `swiftc`).
  candidates.push(join(process.cwd(), 'src', 'main', 'voice', 'native', 'voice-helper'))

  return candidates.find((p) => existsSync(p)) ?? null
}
