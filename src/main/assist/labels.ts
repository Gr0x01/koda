/**
 * Humanized safety-git labels. A checkpoint's commit subject is the user's verbatim prompt, and its
 * id is the commit SHA — so the subject can't be rewritten after the fact. This computes a clean,
 * calm label (on-device model) right when the checkpoint is created, in the background, and stores it
 * by SHA so the recovery timeline reads well whenever it's opened — and after a restart.
 *
 * Computed at creation (not lazily on view) so it's always ready; non-blocking so it never slows a
 * checkpoint or a turn; raw prompt is the fallback whenever the model is unavailable.
 */
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assistLabel } from './index'
import { log } from '../logger'

function cachePath(): string {
  return join(app.getPath('userData'), 'koda-assist-labels.json')
}

function readCache(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {} // missing/corrupt → none yet
  }
}

function writeCache(cache: Record<string, string>): void {
  try {
    writeFileSync(cachePath(), JSON.stringify(cache, null, 2))
  } catch (err) {
    log.warn('assist', 'failed to persist humanized labels', err instanceof Error ? err.message : err)
  }
}

/** SHAs currently being humanized — don't spawn the same one twice (e.g. repeated turn-boundary sha). */
const inFlight = new Set<string>()

/**
 * Serialize ALL cache writes through one promise chain. Humanizations run concurrently (turn-boundary
 * + per-tool checkpoints in a single turn) and each does a read/modify/write — without serialization
 * two callbacks can both read the old cache and the second write drops the first's entry.
 */
let writeChain: Promise<void> = Promise.resolve()
function commitLabel(sha: string, humanized: string): void {
  writeChain = writeChain.then(() => {
    const cache = readCache()
    if (cache[sha] === humanized) return
    cache[sha] = humanized
    writeCache(cache)
  })
}

/**
 * Humanize a freshly-created checkpoint's label in the background and persist it by SHA. Fire-and-
 * forget — callers never await it. No-ops if already cached or in flight.
 */
export function humanizeCheckpointLabel(sha: string, rawLabel: string): void {
  if (inFlight.has(sha) || sha in readCache()) return
  inFlight.add(sha)
  void assistLabel(rawLabel)
    .then((humanized) => {
      // Only store a REAL humanization (differs from the raw prompt). When the model is unavailable
      // assistLabel returns the raw label — don't cache that, so it self-heals on a later run.
      if (humanized && humanized !== rawLabel) commitLabel(sha, humanized)
    })
    .finally(() => inFlight.delete(sha))
}

/**
 * Remap the label cache after a history rewrite (prune/migration): a rewrite re-SHAs every kept
 * checkpoint, so carry each label from its old SHA to its new one and drop everything else (labels of
 * pruned checkpoints, and any pre-rewrite key). `oldToNew` covers every retained checkpoint (replay
 * visits them all), so anything not remapped is genuinely stale. Serialized through the same write
 * chain as humanization so a concurrent write can't clobber the reconciled cache.
 */
export function reconcileLabels(oldToNew: Map<string, string>, retained: Set<string>): void {
  writeChain = writeChain.then(() => {
    const cache = readCache()
    const next: Record<string, string> = {}
    for (const [oldSha, newSha] of oldToNew) {
      if (retained.has(newSha) && cache[oldSha] !== undefined) next[newSha] = cache[oldSha]
    }
    writeCache(next)
  })
}

/**
 * Overlay stored humanized labels onto a checkpoint list. A hit REPLACES the raw `Before "…"`
 * placeholder with the model's final standalone phrase and flags it so the renderer shows it
 * verbatim (no re-wrapping); a miss keeps the raw label as the placeholder.
 */
export function applyHumanizedLabels<T extends { id: string; label: string }>(
  checkpoints: T[],
): (T & { humanized?: boolean })[] {
  const cache = readCache()
  return checkpoints.map((cp) => (cache[cp.id] ? { ...cp, label: cache[cp.id], humanized: true } : cp))
}
