import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Platform bucket — only darwin-arm64 matters (Apple Foundation Models is macOS-only). */
export const ASSIST_PLATFORM = `${process.platform}-${process.arch}`

/**
 * Resolve the compiled Apple-FM Swift helper, or null when there's no usable backend (non-mac, or
 * the binary hasn't been built). Null is a normal answer — the assist seam falls through to its
 * deterministic floor; it must NEVER throw the way the engine resolver does (assist is optional QoL).
 *
 * @param opts.resourcesPath  process.resourcesPath in the packaged app (omit in dev/tests).
 */
export function resolveAssistHelperPath(opts: { resourcesPath?: string } = {}): string | null {
  if (process.platform !== 'darwin') return null // FoundationModels is macOS-only

  const candidates: string[] = []
  // 1. Packaged: <Resources>/assist/<platform>/assist-helper (signed at build time).
  if (opts.resourcesPath) candidates.push(join(opts.resourcesPath, 'assist', ASSIST_PLATFORM, 'assist-helper'))
  // 2. Dev: built by `npm run build-assist-helper`.
  candidates.push(join(process.cwd(), 'resources', 'assist', ASSIST_PLATFORM, 'assist-helper'))
  // 3. Dev convenience: compiled next to the source (spike/manual `swiftc`).
  candidates.push(join(process.cwd(), 'src', 'main', 'assist', 'native', 'assist-helper'))

  return candidates.find((p) => existsSync(p)) ?? null
}
