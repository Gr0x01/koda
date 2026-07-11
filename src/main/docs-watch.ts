import { watch, existsSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { IpcChannels } from '@shared/channels'
import { DOCS_HOME, invalidateDocsCache } from './fs-browse'

/**
 * Per-window watcher on the project's `Documents/` folder so the doc-first sidebar reflects docs the
 * AGENT (or any external tool) creates, moves, or deletes — not just ones made through Koda's own UI.
 * Without it the list only refreshes on UI-initiated ops (`filesRev`) or when the 10s list cache expires,
 * so an agent-written doc lags. Since the agent is a constant writer to `Documents/`, that lag is the
 * common case, not the edge.
 *
 * Koda otherwise scopes filesystem watching tightly (see `file-watch.ts` — open editor files only). This
 * adds exactly one recursive watch on the one folder the doc list is about. On any change it invalidates
 * the cached listing and pings the renderer, which re-fetches.
 *
 * If `Documents/` doesn't exist yet, we watch the project root NON-recursively purely to notice the folder
 * appearing, then swap onto it. A non-recursive root watch fires only on top-level churn — never on deep
 * writes like `node_modules/**` or `.koda/safety.git/**` (the per-turn checkpoints), so it stays cheap.
 */
type Entry = { watcher: FSWatcher | null; timer?: NodeJS.Timeout; root: string; onHome: boolean }
const perWc = new Map<WebContents, Entry>()

export function watchProjectDocs(wc: WebContents, root: string): void {
  if (perWc.has(wc)) return // one logical watcher per window; remount unwatches first
  const entry: Entry = { watcher: null, root, onHome: false }
  perWc.set(wc, entry)
  wc.once('destroyed', () => unwatchProjectDocs(wc))
  arm(wc, entry)
}

export function unwatchProjectDocs(wc: WebContents): void {
  const entry = perWc.get(wc)
  if (!entry) return
  clearTimeout(entry.timer)
  try {
    entry.watcher?.close()
  } catch {
    /* already gone */
  }
  perWc.delete(wc)
}

function arm(wc: WebContents, entry: Entry): void {
  const home = join(entry.root, DOCS_HOME)
  try {
    // Preferred: recursive watch on Documents/. The directory inode is stable across file writes inside
    // it, so unlike a per-file watch this needs no re-arm on each event.
    entry.watcher = watch(home, { recursive: true }, () => onEvent(wc, entry))
    entry.onHome = true
    return
  } catch {
    /* Documents/ missing — fall back to the root watch below */
  }
  try {
    entry.onHome = false
    entry.watcher = watch(entry.root, () => {
      if (!existsSync(join(entry.root, DOCS_HOME))) return // ignore unrelated top-level churn
      try {
        entry.watcher?.close()
      } catch {
        /* already gone */
      }
      arm(wc, entry) // upgrade to the recursive Documents/ watch
      onEvent(wc, entry) // surface the just-created folder's first doc
    })
  } catch {
    entry.watcher = null // no root either (shouldn't happen) — the 10s list TTL still eventually catches up
  }
}

function onEvent(wc: WebContents, entry: Entry): void {
  clearTimeout(entry.timer)
  // Debounced so a burst (a multi-file agent write) collapses into one refresh.
  entry.timer = setTimeout(() => {
    if (wc.isDestroyed()) return
    invalidateDocsCache(entry.root) // else the renderer's re-fetch hits the stale 10s cache
    wc.send(IpcChannels.fsDocsChanged)
  }, 120)
}
