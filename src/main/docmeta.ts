/**
 * Per-document presentation sidecar, stored under `<project>/.koda/docmeta/`.
 *
 * The doc file on disk stays canonical, plain markdown (the agent reads/writes it unchanged). Layout
 * state that markdown can't express — first up, table column widths — lives HERE instead, the same way
 * an editor keeps cursor/fold state outside the file. This is how the doc surface gets Notion-grade
 * polish (resize a column, reopen, it holds) WITHOUT smuggling presentation into the markdown or
 * switching to a block-JSON format. See [[notion-replacement-no-jank]], [[doc-surface-milkdown]].
 *
 * The folder is already inside `.koda/`, excluded from both the safety store and the user's git, so this
 * presentation noise never bloats a recovery checkpoint or a commit. Everything is best-effort: a read
 * failure yields empty meta (the doc just opens auto-width), a write failure is logged, never thrown.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DocMetaSchema, type DocMeta } from '@shared/ipc'
import { log } from './logger'

function metaPath(projectDir: string, relPath: string): string {
  // Hash the project-relative path → a flat, filesystem-safe filename (doc paths contain slashes/spaces).
  // Collision-resistant enough at a project's doc count; the relPath is the logical key, the hash is just
  // the storage name.
  const hash = createHash('sha1').update(relPath).digest('hex').slice(0, 16)
  return join(projectDir, '.koda', 'docmeta', `${hash}.json`)
}

/** Read a doc's sidecar. Fail-open: no file / unreadable / malformed all yield `{}` (the doc opens at
 *  auto-width, never an error). */
export async function readDocMeta(projectDir: string, relPath: string): Promise<DocMeta> {
  try {
    const raw = await readFile(metaPath(projectDir, relPath), 'utf8')
    const parsed = DocMetaSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : {}
  } catch {
    return {} // no sidecar yet, or corrupt — both mean "no saved layout"
  }
}

// Serialize read-merge-write per sidecar file: both renderer writers (table-resize, page chrome) patch
// the same file independently, and an un-serialized RMW could interleave and drop one patch. A per-path
// promise tail (same main process, so an in-memory map suffices) makes the merges strictly sequential.
const writeQueue = new Map<string, Promise<void>>()

/** Patch a doc's sidecar (shallow top-level MERGE, not overwrite). Each writer sends only its own keys,
 *  so the merge composes them instead of clobbering. Best-effort: a failure is logged, never thrown
 *  (losing a column width must never break a save or a turn). */
export async function writeDocMeta(projectDir: string, relPath: string, patch: DocMeta): Promise<void> {
  const file = metaPath(projectDir, relPath)
  const run = async (): Promise<void> => {
    try {
      await mkdir(join(projectDir, '.koda', 'docmeta'), { recursive: true })
      const current = await readDocMeta(projectDir, relPath)
      const merged = DocMetaSchema.parse({ ...current, ...patch })
      await writeFile(file, JSON.stringify(merged))
    } catch (err) {
      log.warn('docmeta', 'write failed', err instanceof Error ? err.message : err)
    }
  }
  // Chain after any in-flight write to the same file; clean up the map tail when we're the last.
  const tail = (writeQueue.get(file) ?? Promise.resolve()).then(run)
  writeQueue.set(file, tail)
  void tail.finally(() => {
    if (writeQueue.get(file) === tail) writeQueue.delete(file)
  })
  return tail
}
