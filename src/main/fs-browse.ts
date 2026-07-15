/**
 * The Project Files browser's read-only filesystem service. Lets Koda stand alone — the user
 * browses + opens their project's files without a separate editor open beside it.
 *
 * The load-bearing rule: EVERY access is contained to the project root. Both the requested path
 * and the root are realpath-resolved (defeating `..` and symlink escapes), and a resolved target
 * outside root is refused — the renderer can never read elsewhere on disk. Read-only by design;
 * Claude edits files through the engine (gated + safety-git-checkpointed), never this surface.
 *
 * The project root is passed in by the caller (ipc.ts resolves it per-window from the window
 * registry — one-project-per-window). This module just enforces containment within whatever root
 * it's given; it has no notion of "the" project.
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { cp, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import type {
  DiffFileResult,
  ProjectDoc,
  ReadDirResult,
  ReadFileResult,
  ReplaceResult,
  SearchResult,
  SearchScope,
  SearchFileResult,
  SearchLineMatch,
} from '@shared/ipc'
import { runGit } from './safety-git/repo'

/** Cap a single file read so a giant/log file can't blow up the IPC payload or the editor. */
const MAX_FILE_BYTES = 1_000_000

/** Directories never worth showing a non-engineer (noise / huge / our own internals). */
const HIDDEN_DIRS = new Set(['.git', 'node_modules', '.koda'])

/**
 * The doc-first sidebar's flat Documents list excludes the tree's hidden noise PLUS the engine's
 * project-knowledge dirs — those hold the agent's operating context (rules, memory-bank notes), not
 * the user's deliverable documents. They stay reachable in the "all files" tree, just not in the
 * Documents list. (Two-tier doc model: deliverables → Documents/ here; project-knowledge → the agent.)
 */
const DOCS_EXCLUDE_DIRS = new Set([
  ...HIDDEN_DIRS, // .git, node_modules, .koda
  '.claude',
  'memory-bank',
  // Dependency / build / virtualenv trees: their bundled LICENSE/README/AUTHORS files are noise, never
  // the user's writing. `site-packages` + `__pycache__` catch Python venvs whatever the venv is named.
  '.venv',
  'venv',
  'site-packages',
  '__pycache__',
  'dist',
  'build',
  'out',
  'vendor',
  '.next',
  'target',
  '.tox',
])

/**
 * Files that carry a doc extension but are never the USER's writing, so the flat Documents list skips
 * them by NAME (an excluded-*dir* rule can't catch them when they sit in a content dir like
 * `resources/…/fonts/` or a skill bundle). Two families:
 *   • Legal boilerplate a project vendors — dependency LICENSE/COPYING/NOTICE, THIRD_PARTY_NOTICES,
 *     font OFL files (`Inter-OFL.txt`).
 *   • Agent operating-context — CLAUDE.md / AGENTS.md (instructions) and SKILL.md (a skill definition);
 *     project-knowledge, not a deliverable (same reason the `.claude` / `memory-bank` dirs are excluded).
 * All stay reachable in the full Files tree — just not read as "documents."
 */
const LICENSE_STEMS = new Set([
  'license',
  'licence',
  'licenses',
  'licences',
  'copying',
  'copyright',
  'notice',
  'notices',
  'third_party_notices',
  'third-party-notices',
  'authors',
  'patents',
  'unlicense',
  'ofl', // a bare SIL Open Font License file
])
const AGENT_DOC_NAMES = new Set(['claude.md', 'agents.md', 'skill.md'])
function isNonUserDoc(name: string): boolean {
  const lower = name.toLowerCase()
  if (AGENT_DOC_NAMES.has(lower)) return true
  const dot = lower.lastIndexOf('.')
  const stem = dot > 0 ? lower.slice(0, dot) : lower
  // exact legal filenames (LICENSE, COPYING.md, NOTICE…) or a font license (ArsenalSC-OFL.txt)
  return LICENSE_STEMS.has(stem) || stem.endsWith('-ofl') || lower.endsWith('.license')
}

/** Koda's home folder for the user's deliverable documents — where "New document" lands. */
export const DOCS_HOME = 'Documents'

/** Bounds for the flat doc list — keep the walk + payload finite on any tree. */
const DOCS = { maxFilesScanned: 8000, maxDocs: 300 } as const

/** Bounds for project-wide search — keep it snappy + the IPC payload finite on any tree. */
const SEARCH = {
  maxFilesScanned: 5000, // hard walk ceiling (a pathological tree can't hang the search)
  maxFileResults: 200, // distinct files reported
  maxTotalMatches: 1000, // content-line hits across all files
  maxMatchesPerFile: 50, // hits within one file (the rest collapse into the cap)
  maxPreviewChars: 200, // a long line is windowed around its first match
  previewLead: 30, // chars shown before the match when windowing
} as const

/** Prose-doc extensions — the "Docs" scope. "Code" is every other text file; "All" is both. */
const DOC_EXTS = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.org'])

/** Does this filename fall in the chosen scope? (Docs = a doc extension; Code = anything else.) */
function inScope(name: string, scope: SearchScope): boolean {
  if (scope === 'all') return true
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
  const isDoc = DOC_EXTS.has(ext)
  return scope === 'docs' ? isDoc : !isDoc
}

/**
 * Fuzzy SUBSEQUENCE match of `needle` (already lowercased) against `hay` — returns a score (higher =
 * better) or null when the chars don't appear in order. Rewards contiguous runs, a match at the start,
 * and matches right after a word boundary (/ _ - .), so "srchovl" ranks SearchOverlay.tsx highly and a
 * plain substring like "pricing" scores very high. Tiny + allocation-free — fine to run per filename.
 */
function fuzzyScore(needle: string, hay: string): number | null {
  if (!needle) return 0
  const h = hay.toLowerCase()
  let score = 0
  let hi = 0
  let run = 0
  for (let ni = 0; ni < needle.length; ni++) {
    const c = needle[ni]
    let found = -1
    for (let j = hi; j < h.length; j++) {
      if (h[j] === c) {
        found = j
        break
      }
    }
    if (found === -1) return null
    score += 1
    // Contiguous with the previous matched char? (hi is the previous match's index + 1.)
    if (ni > 0 && found === hi) {
      run += 1
      score += run * 3 // reward longer contiguous runs
    } else {
      run = 0
    }
    if (found === 0) score += 8 // match at the very start of the name
    else if (/[\s/_\-.]/.test(h[found - 1])) score += 4 // match right after a boundary
    hi = found + 1
  }
  // Prefer shorter haystacks (a tight match in a short name beats a loose one in a long path).
  return score - h.length * 0.05
}

/**
 * Resolve a requested path against root and REFUSE anything that escapes it. realpath collapses
 * `..` and follows symlinks before the check, so neither can smuggle the target outside root.
 * Throws if the path doesn't exist (caller surfaces it) — intentional: you can't browse a ghost.
 */
export function containedReal(root: string, requested?: string): string {
  // Realpath the root too: a symlinked project root (macOS loves these — /tmp, /var, sometimes
  // ~/Documents) would otherwise never prefix-match the realpath'd target, so every contained path
  // looked like an escape — and a just-created doc (returned as its realpath) failed to reopen.
  const realRoot = realpathSync(root)
  const real = realpathSync(requested ? resolve(realRoot, requested) : realRoot)
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error('path escapes the project root')
  }
  return real
}

/**
 * Resolve a NOT-yet-existing path (a rename/move destination, or a new folder) and refuse escapes.
 * realpath can't run on the leaf (it doesn't exist), so we realpath its PARENT dir — which must
 * exist — and rejoin the basename, defeating a symlinked parent that could smuggle the target outside
 * root. The parent itself is then range-checked against the realpath'd root.
 */
function containedNewPath(root: string, requested: string): string {
  const realRoot = realpathSync(root)
  const abs = resolve(realRoot, requested)
  const realParent = realpathSync(dirname(abs))
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    throw new Error('path escapes the project root')
  }
  return join(realParent, basename(abs))
}

/** List a directory: dirs first then files, alphabetical, hidden noise filtered. */
export async function browseDir(root: string, requested?: string): Promise<ReadDirResult> {
  const dir = containedReal(root, requested)
  const dirents = await readdir(dir, { withFileTypes: true })
  const entries = dirents
    .filter((d) => !(d.isDirectory() && HIDDEN_DIRS.has(d.name)))
    .map((d) => ({ name: d.name, kind: d.isDirectory() ? ('dir' as const) : ('file' as const) }))
    .sort((a, b) =>
      a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name),
    )
  return { root, path: dir, entries }
}

/** Read a text file. Caps the byte length and refuses binary (a NUL byte in the leading slice). */
export async function readProjectFile(root: string, requested: string): Promise<ReadFileResult> {
  const file = containedReal(root, requested)
  const st = await stat(file)
  if (!st.isFile()) throw new Error('not a file')
  const truncated = st.size > MAX_FILE_BYTES
  const buf = await readFile(file)
  const slice = buf.subarray(0, MAX_FILE_BYTES)
  if (slice.includes(0)) return { path: file, content: '', truncated, binary: true }
  return { path: file, content: slice.toString('utf8'), truncated, binary: false }
}

/** Image extensions the phone's live doc viewer can inline as a `data:` URL, with their media types.
 *  A doc's local images (`![](assets/pic.png)`) can't be reached from the phone otherwise — the live
 *  reader fetches these over the connection and inlines them, the online sibling of the offline
 *  replica's webp inlining. SVG is inlined verbatim (text), the rest as their raw bytes. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
}
/** Cap on a single inlined image — big enough for a normal doc picture, bounded so a huge asset can't
 *  bloat one doc read (over the wire the base64 costs ~1.33×). Oversized/non-image → null (the phone
 *  keeps the original ref → a broken image, never a crash). */
const MAX_IMAGE_BYTES = 8_000_000

/** One image file for the live doc viewer: contained + size-capped raw bytes + media type. Returns null
 *  for a non-image extension or an oversized file. The phone-serving layer (sessions.remoteReadImage)
 *  webp-downscales these for the wire, the same as the offline replica. */
export async function readProjectImage(
  root: string,
  requested: string,
): Promise<{ mediaType: string; buf: Buffer } | null> {
  const ext = extname(requested).replace(/^\./, '').toLowerCase()
  const mediaType = IMAGE_MIME[ext]
  if (!mediaType) return null
  const file = containedReal(root, requested)
  const st = await stat(file)
  if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null
  return { mediaType, buf: await readFile(file) }
}

/**
 * The before/after pair for the live-edits diff (ui-workspace.md §4). `after` is the current file
 * (same read path as readProjectFile). `before` is its contents at `baseSha` — the safety-git SHA
 * pinned at the turn's start (sessions.getDiffBaseline) — so each edited file shows its CUMULATIVE
 * change this turn. Pinning matters: safety checkpoints are whole-tree (`add -A`) and land before
 * every tool, so reading live HEAD would drift the baseline forward and collapse the diff to just the
 * latest edit. Without a baseSha (manual File→Diff toggle, or before the first turn) it falls back to
 * HEAD. A file with no blob at the ref (created this turn) → before is '' (an all-additions diff).
 */
export async function diffProjectFile(
  root: string,
  requested: string,
  baseSha?: string,
): Promise<DiffFileResult> {
  const after = await readProjectFile(root, requested)
  if (after.binary) return { path: after.path, before: '', after: '', truncated: after.truncated, binary: true }

  let before = ''
  let truncated = after.truncated
  try {
    // POSIX-relative path into the tree; `git show <ref>:<rel>` reads the blob without touching the
    // working tree. runGit targets the safety store, never the user's .git.
    const ref = baseSha || 'HEAD'
    const rel = relative(root, after.path).split(sep).join('/')
    const { stdout } = await runGit(root, ['show', `${ref}:${rel}`])
    const slice = stdout.length > MAX_FILE_BYTES ? stdout.slice(0, MAX_FILE_BYTES) : stdout
    if (slice.length !== stdout.length) truncated = true
    before = slice
  } catch {
    // No blob for this path at the ref (new file / no checkpoints yet) — treat as empty before.
  }
  return { path: after.path, before, after: after.content, truncated, binary: false }
}

/**
 * Save text back to a file. Contained to the project root, and the file must already exist (you can
 * only save a file you opened — no creating arbitrary paths from the renderer). The safety-git
 * checkpoint that makes the edit recoverable is taken by the caller (ipc.ts) BEFORE this write.
 */
export async function writeProjectFile(root: string, requested: string, content: string): Promise<string> {
  const file = containedReal(root, requested)
  const st = await stat(file)
  if (!st.isFile()) throw new Error('not a file')
  await writeFile(file, content, 'utf8')
  return file
}

/**
 * Create a new empty document and return its path. New docs land in Koda's `Documents/` home unless
 * the user selected one of its folders. We control the name (a sanitised basename, no traversal) and the `.md`
 * extension, deduping within the home; `wx` makes the write fail rather than clobber if something
 * raced in. No safety checkpoint here — an empty new file is trivially discardable; the first real
 * save checkpoints.
 */
export async function createProjectFile(root: string, name?: string, parent?: string): Promise<string> {
  const realRoot = realpathSync(root)
  await mkdir(join(realRoot, DOCS_HOME), { recursive: true })
  // realpath the home AFTER creating it and range-check against root: a pre-existing `Documents`
  // symlink pointing outside the project would otherwise pass a lexical check yet have writeFile follow
  // it out of bounds. (Same defense containedNewPath uses for the rest of the module.)
  const home = parent ? containedReal(root, parent) : realpathSync(join(realRoot, DOCS_HOME))
  if ((await stat(home)).isDirectory() === false) throw new Error('not a folder')
  if (home !== realRoot && !home.startsWith(realRoot + sep)) throw new Error('path escapes the project root')
  const base = (name ?? 'Untitled').replace(/[/\\]/g, '').replace(/\.(md|markdown)$/i, '').trim() || 'Untitled'
  let file = join(home, `${base}.md`)
  for (let n = 2; existsSync(file); n++) file = join(home, `${base} ${n}.md`)
  await writeFile(file, '', { encoding: 'utf8', flag: 'wx' })
  return realpathSync(file)
}

/**
 * The flat "Documents" list behind the doc-first sidebar: every prose doc under the project, recency-
 * sorted (newest first), so a non-engineer finds their writing by glancing — no tree-spelunking, no
 * knowing the filename. Walks like search (symlinks never followed, capped), but excludes project-
 * knowledge dirs (DOCS_EXCLUDE_DIRS) so the list reads as deliverables, not the agent's notes. Returns
 * docs WHEREVER they live (a `rel` breadcrumb orients the stray ones); the icon is layered on by the
 * caller from each doc's sidecar. Read-only + contained like the rest of this module.
 */
/** Per-project cache of the doc list. The walk is a full sequential tree traversal (~2s on a big repo),
 *  and it ran on every remote/local docs request — a session open would redo the same walk each time. The
 *  doc SET barely changes between opens, so a short TTL makes the walk run once and reuse; worst case a
 *  just-created doc shows up to TTL late (the phone revalidates on every sheet open anyway). */
const docsListCache = new Map<string, { at: number; docs: ProjectDoc[] }>()
const DOCS_CACHE_TTL_MS = 10_000

/** Drop the cached doc list for a root so the next `listProjectDocs` does a fresh walk. Called by the
 *  Documents/ watcher (`docs-watch.ts`) on an on-disk change — otherwise a change inside the TTL window
 *  would re-serve the stale list and the sidebar wouldn't update. */
export function invalidateDocsCache(root: string): void {
  try {
    docsListCache.delete(realpathSync(root))
  } catch {
    docsListCache.delete(root) // root vanished — clear the raw key just in case
  }
}

export async function listProjectDocs(root: string): Promise<ProjectDoc[]> {
  const realRoot = realpathSync(root)
  const hit = docsListCache.get(realRoot)
  if (hit && Date.now() - hit.at < DOCS_CACHE_TTL_MS) return hit.docs
  const docs: ProjectDoc[] = []
  let scanned = 0
  let truncated = false

  async function walk(dir: string): Promise<void> {
    if (truncated) return // a cap was hit in a sibling frame — stop the whole walk, not just this dir
    let dirents: import('node:fs').Dirent[]
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir (permissions) — skip, don't wedge the whole listing
    }
    // Skip agent-tooling bundles wholesale — their `.md` files are skill/agent/rule content, never the
    // user's writing. Two markers, both Claude Code conventions with no user-folder collision:
    //   • a SKILL.md → this dir is a skill bundle (catches a bundled/`.claude/skills` catalog).
    //   • a `.claude-plugin/` dir → this dir is a plugin root (its agents/, skills/, rules/ subtrees).
    if (
      dirents.some(
        (e) =>
          (e.isFile() && e.name === 'SKILL.md') || (e.isDirectory() && e.name === '.claude-plugin'),
      )
    )
      return
    for (const d of dirents) {
      if (truncated) return
      if (d.isSymbolicLink()) continue // never follow symlinks (escape / cycle risk)
      const full = join(dir, d.name)
      if (d.isDirectory()) {
        if (DOCS_EXCLUDE_DIRS.has(d.name)) continue
        await walk(full)
        continue
      }
      if (!d.isFile() || !inScope(d.name, 'docs') || isNonUserDoc(d.name)) continue
      if (++scanned > DOCS.maxFilesScanned) {
        truncated = true
        return
      }
      let mtimeMs: number
      try {
        mtimeMs = (await stat(full)).mtimeMs
      } catch {
        continue // vanished between readdir and stat — skip it
      }
      const rel = relative(realRoot, full).split(sep).join('/')
      docs.push({ path: full, rel, name: d.name, mtimeMs })
    }
  }

  await walk(realRoot)
  docs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const result = docs.slice(0, DOCS.maxDocs)
  docsListCache.set(realRoot, { at: Date.now(), docs: result })
  return result
}

/**
 * The first ~`maxChars` of a doc — the phone's page-preview cards render this miniature so the user
 * recognizes their document by its content, not its filename. Contained like every other access;
 * fail-soft (missing/unreadable → undefined) because a preview is decoration, never worth an error.
 * Partial read (never the whole file) so a huge doc costs one small disk hit per listing.
 */
export async function docExcerpt(root: string, rel: string, maxChars = 600): Promise<string | undefined> {
  try {
    const target = containedReal(root, rel)
    const fh = await open(target, 'r')
    try {
      // ×4: UTF-8 worst case, so maxChars of text survives the byte→string cut.
      const buf = Buffer.alloc(maxChars * 4)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      return buf.subarray(0, bytesRead).toString('utf8').slice(0, maxChars)
    } finally {
      await fh.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Rename or move a file/folder. `from` must exist; `to` is a new path whose parent exists, both
 * within the project root. Refuses to clobber an existing target (so a rename can't silently
 * overwrite another file). One `fs.rename` covers both rename (same dir) and move (different dir) —
 * including a non-empty folder. The caller (ipc.ts) checkpoints the pre-move tree first.
 */
export async function renameProjectPath(root: string, from: string, to: string): Promise<string> {
  const src = containedReal(root, from)
  if (src === realpathSync(root)) throw new Error('cannot move the project root')
  const dest = containedNewPath(root, to)
  if (src === dest) return src // no-op (renamed to the same name) — nothing to do
  if (existsSync(dest)) throw new Error('a file or folder with that name already exists')
  await rename(src, dest)
  return dest
}

/**
 * Delete a file or folder (recursive for a folder). Contained to the project root; the root itself
 * can't be deleted. The caller checkpoints first, so a delete is recoverable from the timeline.
 */
export async function deleteProjectPath(root: string, target: string): Promise<void> {
  const real = containedReal(root, target)
  if (real === realpathSync(root)) throw new Error('cannot delete the project root')
  await rm(real, { recursive: true, force: false })
}

/**
 * Create a new folder. `parent` (an existing dir within root) nests it; `home` lands it in the
 * user's `Documents/` (where New document goes — so a folder made from the doc-first view is where
 * they expect); omitted ⇒ the project root. Name defaults to "New folder", sanitised + deduped. No
 * checkpoint — an empty dir is trivially discardable and git wouldn't track it anyway.
 */
export async function createProjectDir(
  root: string,
  name?: string,
  parent?: string,
  home?: boolean,
): Promise<string> {
  const parentDir = parent ? containedReal(root, parent) : home ? docsHome(root) : realpathSync(root)
  const base = safeSegment(name, 'New folder')
  let dir = join(parentDir, base)
  for (let n = 2; existsSync(dir); n++) dir = join(parentDir, `${base} ${n}`)
  await mkdir(dir)
  return realpathSync(dir)
}

/** Sanitise a user/OS-supplied name into a single safe path segment: strip path separators, and
 *  never let `.`/`..` through (they'd resolve to the parent/self and confuse the dedup loop). Falls
 *  back to `dflt` when empty. Containment doesn't depend on this — dest is always range-checked — but
 *  it keeps a crafted name from producing a `.. 2` folder or an EEXIST-on-parent error. */
function safeSegment(name: string | undefined, dflt: string): string {
  const clean = (name ?? '').replace(/[/\\]/g, '').trim()
  return !clean || clean === '.' || clean === '..' ? dflt : clean
}

/** The user's `Documents/` home, created if missing and range-checked against root (a pre-existing
 *  `Documents` symlink pointing outside must not smuggle writes out of bounds — same defense as
 *  createProjectFile). Shared by every "lands in Documents/" action. */
function docsHome(root: string): string {
  const realRoot = realpathSync(root)
  const home = join(realRoot, DOCS_HOME)
  if (!existsSync(home)) mkdirSync(home, { recursive: true })
  const real = realpathSync(home)
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error('path escapes the project root')
  return real
}

/**
 * Duplicate a file or folder alongside itself as "<name> copy" (deduped, extension preserved).
 * Contained to root; the root itself can't be duplicated. The caller checkpoints first, so the new
 * copy is recoverable from the timeline.
 */
export async function duplicateProjectPath(root: string, target: string): Promise<string> {
  const src = containedReal(root, target)
  if (src === realpathSync(root)) throw new Error('cannot duplicate the project root')
  const dir = dirname(src)
  const ext = extname(src)
  const stem = basename(src, ext)
  let dest = join(dir, `${stem} copy${ext}`)
  for (let n = 2; existsSync(dest); n++) dest = join(dir, `${stem} copy ${n}${ext}`)
  await cp(src, dest, { recursive: true })
  return realpathSync(dest)
}

/**
 * Import files dragged in from Finder: write each into `destDir` (an existing dir within root) or,
 * omitted, the user's `Documents/` home. Filenames are sanitised + deduped so a drop never clobbers
 * an existing file. The caller checkpoints first, so an import is recoverable from the timeline.
 */
export async function importFilesIntoProject(
  root: string,
  destDir: string | undefined,
  files: { name: string; data: Uint8Array }[],
): Promise<string[]> {
  const target = destDir ? containedReal(root, destDir) : docsHome(root)
  const out: string[] = []
  for (const f of files) {
    const clean = safeSegment(basename(f.name), 'file')
    const ext = extname(clean)
    const stem = clean.slice(0, clean.length - ext.length) || clean
    let dest = join(target, clean)
    for (let n = 2; existsSync(dest); n++) dest = join(target, `${stem} ${n}${ext}`)
    await writeFile(dest, f.data, { flag: 'wx' })
    out.push(realpathSync(dest))
  }
  return out
}

/**
 * Project-wide find (the Find overlay). FILENAMES match FUZZY (subsequence, ranked by `fuzzyScore`);
 * file CONTENTS match plain case-insensitive substring (no regex — friendliest for a non-engineer).
 * `scope` narrows to all / docs / code by extension. Same containment as the rest of this module:
 * HIDDEN_DIRS skipped, SYMLINKED dirs NOT followed (escape/cycle risk). Capped (see SEARCH) so the walk
 * stays snappy + the payload finite; `truncated` tells the renderer a cap was hit. Files are returned
 * in tree order (the renderer ranks the FILES section by `score`; the IN FILES list stays tree order).
 */
export async function searchProject(
  root: string,
  query: string,
  scope: SearchScope = 'all',
): Promise<SearchResult> {
  const realRoot = realpathSync(root)
  const raw = query.trim()
  const needle = raw.toLowerCase()
  if (!needle) return { query, truncated: false, files: [] }

  const files: SearchFileResult[] = []
  let scanned = 0
  let totalMatches = 0
  let truncated = false

  async function walk(dir: string): Promise<void> {
    if (truncated) return
    let dirents: import('node:fs').Dirent[]
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir (permissions) — skip, don't wedge the whole search
    }
    // Dirs first, alphabetical — a stable, tree-shaped result order.
    dirents.sort((a, b) =>
      a.isDirectory() !== b.isDirectory() ? (a.isDirectory() ? -1 : 1) : a.name.localeCompare(b.name),
    )
    for (const d of dirents) {
      if (truncated) return
      if (d.isSymbolicLink()) continue // never follow symlinks (escape / cycle risk)
      const full = join(dir, d.name)
      if (d.isDirectory()) {
        if (HIDDEN_DIRS.has(d.name)) continue
        await walk(full)
        continue
      }
      if (!d.isFile() || !inScope(d.name, scope)) continue
      if (++scanned > SEARCH.maxFilesScanned || files.length >= SEARCH.maxFileResults) {
        truncated = true
        return
      }
      const rel = relative(realRoot, full).split(sep).join('/')
      const nameScore = fuzzyScore(needle, d.name)
      const nameMatch = nameScore !== null
      const matches = await scanFileContents(full, needle)
      if (matches === 'binary') {
        // Binary file: still report it on a filename match (you can open it), just no line hits.
        if (nameMatch) files.push({ path: full, rel, name: d.name, nameMatch, score: nameScore, matches: [] })
        continue
      }
      totalMatches += matches.length
      if (totalMatches >= SEARCH.maxTotalMatches) truncated = true
      if (nameMatch || matches.length)
        files.push({ path: full, rel, name: d.name, nameMatch, score: nameScore ?? 0, matches })
    }
  }

  await walk(realRoot)
  return { query, truncated, files }
}

/**
 * Project-wide replace: rewrite every case-insensitive occurrence of `query` with `replacement`, using
 * the SAME substring semantics + scope as content search (so the change count matches what Find shows).
 * Containment + symlink/HIDDEN_DIRS rules are identical to the search walk. The CALLER (ipc.ts) takes a
 * safety-git checkpoint of the whole tree BEFORE this runs, so the entire replace is one undoable step.
 * Skips binary + truncated (>cap) files — a partial rewrite of a giant file would corrupt it.
 */
export async function replaceInProject(
  root: string,
  query: string,
  replacement: string,
  scope: SearchScope = 'all',
): Promise<ReplaceResult> {
  const realRoot = realpathSync(root)
  const raw = query.trim()
  if (!raw) return { files: 0, replacements: 0 }
  const needle = raw.toLowerCase()

  let filesChanged = 0
  let replacements = 0
  let scanned = 0

  async function walk(dir: string): Promise<void> {
    let dirents: import('node:fs').Dirent[]
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue
      const full = join(dir, d.name)
      if (d.isDirectory()) {
        if (HIDDEN_DIRS.has(d.name)) continue
        await walk(full)
        continue
      }
      if (!d.isFile() || !inScope(d.name, scope)) continue
      if (++scanned > SEARCH.maxFilesScanned) return
      let buf: Buffer
      try {
        buf = await readFile(full)
      } catch {
        continue
      }
      if (buf.length > MAX_FILE_BYTES) continue // don't risk a partial rewrite of a huge file
      if (buf.includes(0)) continue // binary
      const text = buf.toString('utf8')
      // UTF-8-only: if the bytes don't round-trip (latin-1 / other non-UTF-8 "text"), skip it — decoding
      // would turn invalid sequences into U+FFFD and the write-back would corrupt bytes far from the match.
      if (!Buffer.from(text, 'utf8').equals(buf)) continue
      const count = countOccurrences(text.toLowerCase(), needle)
      if (count === 0) continue
      await writeFile(full, replaceCaseInsensitive(text, needle, replacement), 'utf8')
      filesChanged += 1
      replacements += count
    }
  }

  await walk(realRoot)
  return { files: filesChanged, replacements }
}

/** Count non-overlapping occurrences of `needle` in an already-lowercased `hay`. */
function countOccurrences(hay: string, needle: string): number {
  let n = 0
  let i = hay.indexOf(needle)
  while (i !== -1) {
    n += 1
    i = hay.indexOf(needle, i + needle.length)
  }
  return n
}

/** Replace every case-insensitive occurrence of `needle` in `text` with `replacement` (literal). */
function replaceCaseInsensitive(text: string, needle: string, replacement: string): string {
  let out = ''
  const lower = text.toLowerCase()
  let i = 0
  for (;;) {
    const at = lower.indexOf(needle, i)
    if (at === -1) {
      out += text.slice(i)
      return out
    }
    out += text.slice(i, at) + replacement
    i = at + needle.length
  }
}

/** Scan one file's contents for the needle. Returns `'binary'` (NUL in the leading slice) or the
 *  line hits (windowed preview, capped per file). Reads at most MAX_FILE_BYTES, like readProjectFile. */
async function scanFileContents(full: string, needle: string): Promise<SearchLineMatch[] | 'binary'> {
  let buf: Buffer
  try {
    buf = await readFile(full)
  } catch {
    return []
  }
  const slice = buf.subarray(0, MAX_FILE_BYTES)
  if (slice.includes(0)) return 'binary'
  const text = slice.toString('utf8')
  const matches: SearchLineMatch[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const idx = line.toLowerCase().indexOf(needle)
    if (idx === -1) continue
    matches.push({ line: i + 1, preview: previewLine(line, idx) })
    if (matches.length >= SEARCH.maxMatchesPerFile) break
  }
  return matches
}

/** Trim + window a matched line for display: drop leading whitespace, and if it's still long, slice a
 *  window around the first match (ellipses mark each truncated end). The renderer re-finds + highlights
 *  the query within this preview, so the exact match position needn't survive the trim. */
function previewLine(line: string, matchIdx: number): string {
  const trimmedLead = line.length - line.trimStart().length
  const trimmed = line.trim()
  if (trimmed.length <= SEARCH.maxPreviewChars) return trimmed
  const rel = matchIdx - trimmedLead // match offset within the trimmed line
  const start = Math.max(0, rel - SEARCH.previewLead)
  const end = start + SEARCH.maxPreviewChars
  return (start > 0 ? '…' : '') + trimmed.slice(start, end) + (end < trimmed.length ? '…' : '')
}
