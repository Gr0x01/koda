import { watch, type FSWatcher } from 'node:fs'
import type { WebContents } from 'electron'
import { IpcChannels } from '@shared/channels'
import { containedReal } from './fs-browse'

/**
 * Per-window watchers for the files the renderer currently has OPEN in an editor surface. Koda has no
 * other filesystem watching by design; this is scoped to exactly the handful of paths the user is
 * looking at, so an open file reflects on-disk edits — from Koda's own agent, another Koda session,
 * this-session tooling, or an external editor — instead of showing stale content until it's reopened.
 *
 * The renderer registers a `file` surface's path on mount and unregisters on unmount, then re-reads
 * when the `fs:fileChanged` push names its path. Keyed by the exact path string the renderer passed so
 * the echo back matches without the renderer having to know main's resolved absolute path.
 */
type Entry = { watcher: FSWatcher | null; timer?: NodeJS.Timeout }
const perWc = new Map<WebContents, Map<string, Entry>>()

export function watchProjectFile(wc: WebContents, root: string, requested: string): void {
  const real = containedReal(root, requested) // throws if the path escapes the project root
  let map = perWc.get(wc)
  if (!map) {
    map = new Map()
    perWc.set(wc, map)
    wc.once('destroyed', () => disposeAll(wc))
  }
  if (map.has(requested)) return

  const entry: Entry = { watcher: null }
  const arm = (): FSWatcher =>
    // Re-armed after every event: an atomic save (write-temp + rename) swaps the inode, which would
    // silently orphan a path-based watcher. Debounced so a burst of writes pings the renderer once.
    watch(real, () => {
      clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        if (wc.isDestroyed()) return
        wc.send(IpcChannels.fsFileChanged, requested)
        try {
          entry.watcher?.close()
        } catch {
          /* already gone */
        }
        try {
          entry.watcher = arm()
        } catch {
          // File briefly absent mid-rename — a later open won't re-fire, but in-place edits (the common
          // case) and completed atomic saves re-arm fine. Not worth a poll for the rename-then-deleted edge.
          entry.watcher = null
        }
      }, 80)
    })

  try {
    entry.watcher = arm()
    map.set(requested, entry)
  } catch {
    // ENOENT / permission — nothing to watch; the surface's initial read already surfaced any error.
  }
}

export function unwatchProjectFile(wc: WebContents, requested: string): void {
  const map = perWc.get(wc)
  const entry = map?.get(requested)
  if (!entry || !map) return
  clearTimeout(entry.timer)
  try {
    entry.watcher?.close()
  } catch {
    /* already gone */
  }
  map.delete(requested)
}

function disposeAll(wc: WebContents): void {
  const map = perWc.get(wc)
  if (!map) return
  for (const entry of map.values()) {
    clearTimeout(entry.timer)
    try {
      entry.watcher?.close()
    } catch {
      /* already gone */
    }
  }
  perWc.delete(wc)
}
