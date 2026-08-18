/**
 * Scratch store for pasted/dropped images. Each attachment is also written (already compressed by the
 * renderer) to `<project>/.koda/scratch/` so it survives the conversation and the agent can re-reference
 * it by path later — solving the "I dropped a screenshot and now have to repeat myself" problem.
 *
 * The folder is excluded from BOTH the safety store (repo.ts EXCLUDE) and the user's git, so a binary
 * image never bloats a recovery checkpoint or shows up in the user's commits. Files auto-prune by age
 * (a user setting); everything here is best-effort — a failure means no durable copy, never a blocked
 * turn (the image still goes inline). Pruning runs before a save, before the first Recent images
 * page is listed, and when the retention setting changes for an open project.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ATTACHABLE_IMAGE_MIME, EXT_FOR_MEDIA_TYPE, extensionOf } from '@shared/attachments'
import { log } from './logger'

// Both maps come from the one accept-list (@shared/attachments) — written separately here, they
// drifted, and a type the composer accepted but this map lacked saved as `.img`. Docs (csv/pdf) are
// saved to this folder but only the IMAGE map lists back, so they never reach the Recent images strip.
const EXT = EXT_FOR_MEDIA_TYPE
const MIME = ATTACHABLE_IMAGE_MIME

function scratchDir(projectDir: string): string {
  return join(projectDir, '.koda', 'scratch')
}

/**
 * Persist an image to `<project>/.koda/scratch/` and return its project-relative path (the form the
 * agent reads). Prunes stale files first. The caller resolves `projectDir` from the window registry —
 * the renderer never names a path.
 */
export async function saveScratchImage(
  projectDir: string,
  mediaType: string,
  dataBase64: string,
  retentionDays: number,
  fileName?: string,
): Promise<string> {
  const dir = scratchDir(projectDir)
  await mkdir(dir, { recursive: true })
  await pruneScratch(projectDir, retentionDays)
  // Document attachments keep their original name (the agent and the user both recognize
  // `sales-2025` better than a bare timestamp); images stay on the `image-` scheme.
  const origExt = fileName ? extensionOf(fileName) : ''
  const ext = (origExt || EXT[mediaType]) ?? 'img'
  const stemRaw = fileName ? fileName.slice(0, fileName.length - (origExt ? origExt.length + 1 : 0)) : 'image'
  const stem = stemRaw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 40) || 'file'
  // Timestamp (human-sortable) + a UUID segment: collision-free even when a multi-image paste saves in
  // the same second, so the parallel writes never clobber each other. No need to read the dir first.
  const stamp = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19)
  const name = `${stem}-${stamp}-${randomUUID().slice(0, 8)}.${ext}`
  await writeFile(join(dir, name), Buffer.from(dataBase64, 'base64'))
  return `.koda/scratch/${name}`
}

export type ScratchImageFile = {
  name: string
  relPath: string
  mediaType: string
  dataBase64: string
  mtime: number
}

export type ScratchListPage = { images: ScratchImageFile[]; total: number }

/**
 * Page through the project's scratch images, newest-first, for the Recent images strip. We `stat` every
 * image to sort by recency + get the `total` (cheap — metadata only), but read the heavy base64 ONLY for
 * the `[offset, offset+limit)` slice. That's what lets the strip lazy-load "whatever amount" the user's
 * retention keeps without ever holding every image in memory at once. Fail-soft: an absent folder (or any
 * read error) yields an empty page. Non-image files are skipped.
 */
export async function listScratchImages(
  projectDir: string,
  offset = 0,
  limit = 30,
): Promise<ScratchListPage> {
  const dir = scratchDir(projectDir)
  // A settings-triggered prune can overlap a list that already collected metadata. If one of those
  // files vanishes before its bytes are read, rebuild the page once from the post-prune directory
  // instead of rejecting the whole Recent images strip. A second failure stays fail-soft.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return { images: [], total: 0 } // no folder yet (nothing saved) — normal
    }
    const entries = await Promise.all(
      names.map(async (name) => {
        const mediaType = MIME[extensionOf(name)]
        if (!mediaType) return null
        try {
          const s = await stat(join(dir, name))
          return s.isFile() ? { name, mtime: s.mtimeMs, mediaType } : null
        } catch {
          return null // vanished mid-list — ignore
        }
      }),
    )
    const sorted = entries
      .filter((e): e is { name: string; mtime: number; mediaType: string } => e !== null)
      .sort((a, b) => b.mtime - a.mtime)
    const page = sorted.slice(offset, offset + limit)
    try {
      const images = await Promise.all(
        page.map(async (f) => ({
          name: f.name,
          relPath: `.koda/scratch/${f.name}`,
          mediaType: f.mediaType,
          dataBase64: (await readFile(join(dir, f.name))).toString('base64'),
          mtime: f.mtime,
        })),
      )
      return { images, total: sorted.length }
    } catch (err) {
      if (attempt === 0 && (err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      return { images: [], total: offset }
    }
  }
  return { images: [], total: offset }
}

/**
 * Delete scratch files whose mtime is older than `retentionDays`. `retentionDays <= 0` means keep
 * forever (pruning off). Returns the number removed. Fail-soft: logged, never thrown — pruning must
 * not block a save.
 */
export async function pruneScratch(projectDir: string, retentionDays: number): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0
  const dir = scratchDir(projectDir)
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  let removed = 0
  try {
    const names = await readdir(dir)
    await Promise.all(
      names.map(async (name) => {
        const full = join(dir, name)
        try {
          const s = await stat(full)
          if (s.isFile() && s.mtimeMs < cutoff) {
            await unlink(full)
            removed += 1
          }
        } catch {
          /* file vanished mid-prune (a concurrent save/prune) — ignore */
        }
      }),
    )
  } catch (err) {
    // An absent dir is normal (nothing saved yet) — only a real error is worth a line.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('scratch', 'prune failed', err instanceof Error ? err.message : err)
    }
  }
  return removed
}
