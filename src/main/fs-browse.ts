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
import { constants, existsSync, mkdirSync, realpathSync, type BigIntStats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  cp,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  isLibraryAdmittedDocumentPath,
  resolveDocFormat,
  splitDocumentFrontmatter,
} from '@shared/document-contract'
import type {
  DiffFileResult,
  DocKind,
  LibraryDoc,
  LibraryQueryRequest,
  LibraryQueryResult,
  ProjectDoc,
  ReadDirResult,
  ReadFileResult,
  ReplaceResult,
  SearchResult,
  SearchScope,
  SearchFileResult,
  SearchLineMatch,
} from '@shared/ipc'
import {
  amendDocFrontmatter,
  docDateStamp,
  inferDocKind,
  readDocMetadata,
  writeDocFrontmatter,
  type DocFrontmatter,
} from './doc-frontmatter'
import { readHtmlDocumentMetadata } from './html-document'
import { readContainedRegularFile } from './contained-read'
import {
  sameRequiredFileFingerprint,
  type RequiredCheckpointFile,
} from './safety-git/checkpoint'
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
  // Apple/Swift build output. Measured, not speculative: before these landed, 78 of the 166 documents
  // this repository offered the Library were Xcode link-file lists, and querying "install" returned ten
  // `*-DebugDylibInstallName-normal-arm64.txt` rows above the first sentence RB actually wrote.
  // `DerivedData` is Xcode's build root; `SourcePackages` holds SwiftPM checkouts (other people's
  // READMEs); `.build` is SwiftPM's CLI equivalent; `Pods`/`Carthage` are vendored dependency trees.
  'DerivedData',
  'SourcePackages',
  '.build',
  'Pods',
  'Carthage',
  // The remaining mainstream generated trees, same reasoning as dist/build/out above.
  '.gradle',
  'coverage',
  'bower_components',
  '.svelte-kit',
])

/**
 * `.noindex` is Apple's own "this directory is derived, do not index it" marker — Spotlight honours it,
 * and Xcode stamps it on every intermediate tree (`Intermediates.noindex`, `ModuleCache.noindex`,
 * `Index.noindex`). It is the one marker that stays true when a project points derived data at a
 * custom folder, which the name list above cannot anticipate.
 *
 * Deliberately NOT here: pruning on `*.xcodeproj`, `Package.resolved` or `Podfile`. Those mark a
 * SOURCE root, not build output — the marker sits next to the user's own code, so `ios/App/` would
 * lose its README, and a Swift package repository (`Package.resolved` at the top) would show an empty
 * Library. That is the difference from the `SKILL.md` / `.claude-plugin/` markers below, which sit in
 * directories whose entire contents are agent context by definition.
 */
function isExcludedDocsDir(name: string): boolean {
  return DOCS_EXCLUDE_DIRS.has(name) || name.endsWith('.noindex')
}

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

/** A directory carrying either marker is an agent-tooling bundle, never part of the user's Library.
 *  Both discovery and exact resolution call this one predicate so a remembered path cannot regain
 *  eligibility merely by bypassing the walk. */
function hasLibraryBundleMarker(entries: import('node:fs').Dirent[]): boolean {
  return entries.some(
    (entry) =>
      (entry.isFile() && entry.name === 'SKILL.md') ||
      (entry.isDirectory() && entry.name === '.claude-plugin'),
  )
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

/** Prose-doc extensions — the Find overlay's "Docs" scope. "Code" is every other text file; "All" is
 *  both. Wider than the Library's set below on purpose: Find's job is "show me every place this string
 *  appears", so a `.txt` staying reachable there costs a user nothing. */
const DOC_EXTS = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.org'])

/**
 * What the LIBRARY is willing to call a document — `DOC_EXTS` minus `.txt`.
 *
 * `.txt` is the default extension for machine output (build link-file lists, daemon logs, captured
 * transcripts), and no directory rule can catch them all because a tool writes its dump wherever it
 * runs. Measured on this repository after the build-directory exclusions above: every remaining `.txt`
 * in the corpus was a `tailscaled.log*.txt` or a captured engine turn, and none was writing.
 *
 * The other half of the reasoning is that Koda's document substrate is markdown end to end — documents
 * are BORN `.md` (`createProjectFile`), kept as `.md` (`keep-document.ts`), and carry their
 * title/description/kind in markdown frontmatter. A `.txt` in the Library is permanently an untitled
 * `note` in a surface whose whole value is authored metadata.
 *
 * What this costs: a plain-text note the user dragged in is not in the Library. It stays fully visible
 * in the Files tree and fully findable in the Find overlay — only the claim "this is one of your
 * documents" is withdrawn. That is the right side to err on, because noise is unbounded (one build can
 * emit hundreds of rows) while the omission is one file the user can still reach two other ways.
 */
/**
 * Is this file — named by its PROJECT-RELATIVE path — one the Documents list and Library may treat as
 * one of the user's documents?
 *
 * The path rather than the bare filename, because admission stopped being a pure question about the
 * extension when HTML joined the corpus (typed-documents plan, Slice 1). Prose is admitted wherever it
 * sits, exactly as before; `.html` is admitted only under `Documents/`. The rule itself lives in
 * `shared/document-contract.ts` beside `resolveDocFormat`, so the renderer and the phone read the same
 * one sentence rather than a copy of it.
 */
function isLibraryDocRel(rel: string): boolean {
  return isLibraryAdmittedDocumentPath(rel)
}

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
 * and matches right after a word boundary (/ _ - .), so "libpnl" ranks LibraryPanel.tsx highly and a
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
  const { path, bytes, truncated } = await readContainedRegularFile(root, requested, MAX_FILE_BYTES)
  if (bytes.includes(0)) return { path, content: '', truncated, binary: true }
  return { path, content: bytes.toString('utf8'), truncated, binary: false }
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
/** Extensions Chromium can render directly in an `<img>` (served over `koda-preview://`). Drives the
 *  file surface's image preview. Narrower than IMAGE_MIME: tiff has no browser support, so it stays a
 *  "binary" notice rather than a broken image. */
const DISPLAYABLE_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'])

/** True when `path`'s extension is an image the file surface can render inline. */
export function isDisplayableImage(path: string): boolean {
  return DISPLAYABLE_IMAGE_EXTS.has(extname(path).replace(/^\./, '').toLowerCase())
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
  const { bytes, truncated } = await readContainedRegularFile(root, requested, MAX_IMAGE_BYTES)
  if (truncated) return null
  return { mediaType, buf: bytes }
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
  invalidateDocsCache(root)
  return file
}

/**
 * Create a new document and return its path. New docs land in Koda's `Documents/` home unless the
 * user selected one of its folders. We control the name (a sanitised basename, no traversal) and the `.md`
 * extension, deduping within the home; `wx` makes the write fail rather than clobber if something
 * raced in. No safety checkpoint here — a new file is trivially discardable; the first real save
 * checkpoints.
 *
 * The document is BORN with `title`, `date` and a `kind`, rather than empty. A rule that depends on
 * the agent reading a playbook first is a rule that gets skipped, and a Library where day-one
 * documents carry no metadata is the file tree it exists to replace. `description` is left for the
 * agent: it is the one field that cannot be derived. `source` (provenance) is passed by the caller
 * that knows which session asked.
 */
export async function createProjectFile(
  root: string,
  name?: string,
  parent?: string,
  source?: string,
  initial?: { description: string; kind: DocKind; body: string },
): Promise<string> {
  return createProjectDocument(root, name, parent, '.md', /\.(md|markdown)$/i, ({ title, rel }) => {
    const frontmatter = writeDocFrontmatter({
      title,
      date: docDateStamp(),
      kind: initial?.kind ?? inferDocKind(rel),
      source,
    })
    return initial
      ? `${amendDocFrontmatter(frontmatter, {
          description: initial.description,
          kind: initial.kind,
        }).trimEnd()}\n\n${initial.body}`
      : frontmatter
  })
}

/**
 * Create a new self-contained HTML document and return its path. The HTML twin of `createProjectFile`
 * and, deliberately, only that: identical home resolution, identical name sanitising, identical
 * dedupe, identical exclusive no-clobber write. `render` receives the DEDUPED title so the `<title>`
 * on the page matches the filename it actually got, exactly as the markdown frontmatter does.
 *
 * The bytes themselves belong to `html-document.ts`; this function owns only where the file may land.
 */
export async function createProjectHtmlFile(
  root: string,
  name: string | undefined,
  parent: string | undefined,
  render: (ctx: { title: string; rel: string }) => string,
): Promise<string> {
  return createProjectDocument(root, name, parent, '.html', /\.html?$/i, render)
}

/**
 * The containment, dedupe and no-clobber core every Koda-created document shares.
 *
 * It exists as one function because the three defenses in it are the ones that must never diverge by
 * format: the home is realpathed AFTER creation and range-checked (a pre-existing `Documents` symlink
 * out of the project would otherwise pass a lexical check and have `writeFile` follow it out of
 * bounds), the name is a sanitised basename with no traversal, and the write is exclusive so a race
 * fails rather than clobbers. A second creation path with its own copy of those is how one of them
 * quietly gets left out.
 *
 * No safety checkpoint here — a brand-new file is trivially discardable, and the first real save
 * checkpoints. The single exclusive write owns the whole creation transaction, so a failure cannot
 * strand a metadata-only skeleton that pushes the retry onto a deduped second filename.
 */
async function createProjectDocument(
  root: string,
  name: string | undefined,
  parent: string | undefined,
  extension: string,
  stripExtension: RegExp,
  render: (ctx: { title: string; rel: string }) => string,
): Promise<string> {
  const realRoot = realpathSync(root)
  await mkdir(join(realRoot, DOCS_HOME), { recursive: true })
  const home = parent ? containedReal(root, parent) : realpathSync(join(realRoot, DOCS_HOME))
  if ((await stat(home)).isDirectory() === false) throw new Error('not a folder')
  if (home !== realRoot && !home.startsWith(realRoot + sep)) throw new Error('path escapes the project root')
  const base = (name ?? 'Untitled').replace(/[/\\]/g, '').replace(stripExtension, '').trim() || 'Untitled'
  let file = join(home, `${base}${extension}`)
  // The title follows the DEDUPED name — a second "Untitled" is titled "Untitled 2", so the Library
  // never shows two rows reading the same thing.
  let title = base
  for (let n = 2; existsSync(file); n++) {
    title = `${base} ${n}`
    file = join(home, `${title}${extension}`)
  }
  const rel = relative(realRoot, file).split(sep).join('/')
  await writeFile(file, render({ title, rel }), { encoding: 'utf8', flag: 'wx' })
  invalidateDocsCache(root)
  return realpathSync(file)
}

/**
 * Resolve a project-relative topic folder under `Documents/`, creating it when the topic is genuinely
 * new. Returns the realpathed directory, or undefined for the `Documents/` root itself.
 *
 * Two containment layers, because every caller's argument crosses an agent boundary: a lexical pass
 * that refuses traversal and forces the destination under `Documents/`, then `containedReal`, which
 * realpaths the created directory and refuses anything that landed outside the project — the defense a
 * lexical check alone cannot make when `Documents` is itself a symlink.
 *
 * Scoping to `Documents/` is load-bearing rather than tidy. Without it a creation tool writes
 * agent-supplied text to any path in the project while classifying as neither Write nor Edit to the
 * approval gate.
 */
export async function resolveDocumentsFolder(
  root: string,
  requested: string | undefined,
): Promise<string | undefined> {
  const realRoot = realpathSync(root)
  const raw = (requested ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!raw) return undefined
  const segments = raw.split('/').filter((segment) => segment && segment !== '.')
  if (segments.some((segment) => segment === '..')) {
    throw new Error('folder must be a project-relative path inside Documents/, e.g. "Documents/decisions"')
  }
  // The home segment is recognized case-insensitively but REWRITTEN to Koda's spelling. Passing the
  // agent's `documents/decisions` through verbatim resolved to the same folder on macOS and to a second,
  // sibling home on any case-sensitive volume — where the Documents pane would then show one of them.
  const nested = segments[0]?.toLowerCase() === DOCS_HOME.toLowerCase() ? segments.slice(1) : segments
  const scoped = [DOCS_HOME, ...nested]
  const rel = scoped.join('/')
  const dir = join(realRoot, ...scoped)
  if (!dir.startsWith(realRoot + sep)) {
    throw new Error('folder must be a project-relative path inside Documents/, e.g. "Documents/decisions"')
  }
  // Range-check the deepest ancestor that already exists BEFORE creating anything. `Documents` (or a
  // topic folder inside it) may itself be a symlink out of the project, and `mkdir -p` follows one
  // happily — so without this, a refusal further down would still have left directories on the far side.
  let ancestor = dir
  while (ancestor !== realRoot && !existsSync(ancestor)) ancestor = dirname(ancestor)
  const realAncestor = realpathSync(ancestor)
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + sep)) {
    throw new Error('folder escapes the project root')
  }
  await mkdir(dir, { recursive: true })
  return containedReal(realRoot, rel)
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
const docsListCache = new Map<string, { at: number; detail: ProjectDocsDetail }>()
// Invalidation must also retire a walk that is already in flight. Deleting only the settled cache
// entry lets a pre-mutation traversal finish later and repopulate it with its stale snapshot.
const docsCacheGeneration = new Map<string, number>()
const DOCS_CACHE_TTL_MS = 10_000

/** What one walk produces. `docs` is the capped, recency-sorted list the sidebar shows; `excerpts` is
 *  the prose preview each one's head read already yielded (keyed by absolute path, absent when the
 *  file had no body), so the Library never re-reads the same files; `truncated` means a cap cut the
 *  set, so anything reading it is looking at a partial view of the project. */
interface ProjectDocsDetail {
  docs: ProjectDoc[]
  excerpts: Map<string, string>
  truncated: boolean
}

/** How many head-reads run at once when enriching the walk with frontmatter. Bounded so a 300-doc
 *  project can't open 300 descriptors at once (macOS's default soft limit is lower than that). */
const DOC_META_CONCURRENCY = 24

/** Drop the cached doc list for a root so the next `listProjectDocs` does a fresh walk. Called by the
 *  Documents/ watcher (`docs-watch.ts`) on an on-disk change — otherwise a change inside the TTL window
 *  would re-serve the stale list and the sidebar wouldn't update. */
export function invalidateDocsCache(root: string): void {
  let key = root
  try {
    key = realpathSync(root)
  } catch {} // root vanished — use the raw key just in case
  docsListCache.delete(key)
  docsCacheGeneration.set(key, (docsCacheGeneration.get(key) ?? 0) + 1)
}

export async function listProjectDocs(root: string): Promise<ProjectDoc[]> {
  return (await listProjectDocsDetailed(root)).docs
}

/**
 * The same walk, plus what the Library needs on top of the sidebar's list: each doc's prose excerpt
 * and whether a cap cut the set. One function so there is exactly ONE walk, ONE exclusion set and ONE
 * cache behind both surfaces — the Library's correctness rests on its universe being literally the
 * documents list, not a second traversal that has to be kept in agreement with it.
 */
async function listProjectDocsDetailed(root: string): Promise<ProjectDocsDetail> {
  const realRoot = realpathSync(root)
  const hit = docsListCache.get(realRoot)
  if (hit && Date.now() - hit.at < DOCS_CACHE_TTL_MS) return hit.detail
  const generation = docsCacheGeneration.get(realRoot) ?? 0
  const docs: ProjectDoc[] = []
  let scanned = 0
  // Two different facts. `truncated` reports that the RESULT is partial; `stop` is control flow for a
  // hard cap. One directory Koda cannot read, or one file that vanishes mid-walk, makes the result
  // partial without being a reason to abandon the rest of the tree — so a single flag serving both
  // silently drops every document after the first I/O hiccup, and caches the stump for 10s.
  let truncated = false
  let stop = false

  // `relDir` is carried down rather than recomputed with `relative()` per file: admission now depends
  // on WHERE a file sits (`.html` only under `Documents/`), and asking that question once per entry in
  // a tree this walk already caps at 8,000 files should not cost a path resolution each time.
  async function walk(dir: string, relDir: string): Promise<void> {
    if (stop) return // a cap was hit in a sibling frame — stop the whole walk, not just this dir
    let dirents: import('node:fs').Dirent[]
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      truncated = true
      return // unreadable dir (permissions) — keep readable rows, but mark the universe partial
    }
    // Skip agent-tooling bundles wholesale — their `.md` files are skill/agent/rule content, never the
    // user's writing. Two markers, both Claude Code conventions with no user-folder collision:
    //   • a SKILL.md → this dir is a skill bundle (catches a bundled/`.claude/skills` catalog).
    //   • a `.claude-plugin/` dir → this dir is a plugin root (its agents/, skills/, rules/ subtrees).
    if (hasLibraryBundleMarker(dirents)) return
    for (const d of dirents) {
      if (stop) return
      if (d.isSymbolicLink()) continue // never follow symlinks (escape / cycle risk)
      const full = join(dir, d.name)
      const rel = relDir ? `${relDir}/${d.name}` : d.name
      if (d.isDirectory()) {
        if (isExcludedDocsDir(d.name)) continue
        await walk(full, rel)
        continue
      }
      if (!d.isFile() || !isLibraryDocRel(rel) || isNonUserDoc(d.name)) continue
      if (++scanned > DOCS.maxFilesScanned) {
        truncated = true
        stop = true
        return
      }
      let mtimeMs: number
      try {
        const current = await lstat(full)
        if (!current.isFile()) {
          truncated = true // the file changed shape after readdir; do not follow it
          continue
        }
        mtimeMs = current.mtimeMs
      } catch {
        truncated = true
        continue // vanished between readdir and stat — skip it, but do not call the walk complete
      }
      docs.push({ path: full, rel, name: d.name, mtimeMs })
    }
  }

  await walk(realRoot, '')
  docs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const kept = docs.slice(0, DOCS.maxDocs)
  // Metadata is read AFTER the sort and the cap, so the added cost is bounded by what's returned
  // (≤ maxDocs head reads) rather than by how many docs the tree holds. The walk itself is untouched.
  const excerpts = new Map<string, string>()
  await mapConcurrent(kept, DOC_META_CONCURRENCY, async (doc) => {
    const { fm, excerpt } = await readAdmittedDocMetadata(doc.path, doc.rel, realRoot)
    if (fm.title) doc.title = fm.title
    if (fm.description) doc.description = fm.description
    if (fm.kind) doc.kind = fm.kind
    if (fm.source) doc.source = fm.source
    if (excerpt) excerpts.set(doc.path, excerpt)
  })
  const detail: ProjectDocsDetail = { docs: kept, excerpts, truncated: truncated || docs.length > kept.length }
  // A successful mutation may have invalidated this root while readdir/metadata I/O was pending.
  // Return this caller's coherent snapshot, but never let it become the next caller's cache hit.
  if ((docsCacheGeneration.get(realRoot) ?? 0) === generation)
    docsListCache.set(realRoot, { at: Date.now(), detail })
  return detail
}

/**
 * One admitted document's authored metadata and excerpt, read by the reader its FORMAT owns.
 *
 * The format decides, not the caller: `resolveDocFormat` is the single answer to "what are these
 * bytes", so a document reaches `doc-frontmatter` (YAML between `---` fences) or `html-document`
 * (`<title>` plus `koda:` metas) by the same rule that decides which Stage surface will open it. Both
 * readers are fail-soft and byte-bounded, so an unreadable artifact of either kind costs its own row
 * and nothing else.
 */
async function readAdmittedDocMetadata(
  file: string,
  rel: string,
  root: string,
): Promise<{ fm: DocFrontmatter; excerpt?: string }> {
  return resolveDocFormat(rel) === 'html'
    ? readHtmlDocumentMetadata(file, 600, root)
    : readDocMetadata(file, 600, root)
}

/** Run `fn` over `items` with at most `limit` in flight. `fn` must swallow its own failures — a
 *  rejection propagates and fails the whole listing, which is why `readDocMetadata` is fail-soft. */
async function mapConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * The Library's single read: the documents list, narrowed by kind and by a query that matches titles,
 * filenames and file contents.
 *
 * The load-bearing decision is the UNIVERSE. `searchProject` only skips `.git`, `node_modules` and
 * `.koda`, while the documents walk also skips DOCS_EXCLUDE_DIRS, prunes skill-bundle and plugin
 * directories by marker, and drops non-user files by name (CLAUDE.md, AGENTS.md, SKILL.md, vendored
 * licenses). A Library built on the search walk therefore surfaces `CLAUDE.md`, vendored skill files
 * and dependency READMEs that the Documents pane correctly hides, and reads as broken to exactly the
 * user this surface is for. Rather than filtering search results back down — a second copy of the
 * rules, free to drift — this searches WITHIN the documents list. The exclusions cannot disagree
 * because there is only one set of them, and the 10s-cached walk means typing costs no tree traversal.
 *
 * Content scanning uses the Find overlay's matcher (`scanFileContents`: case-insensitive substring,
 * line-numbered windowed previews) with one difference: the frontmatter block is not content. A
 * document's `title:` is the thing a user is MOST likely to type, so scanning the raw file made the
 * likeliest query answer itself with the plumbing — a match preview reading `title: Phone tiers`, and
 * an ask citation quoting it as if the document had said it. `readDocMetadata` already refuses to put
 * that block in an excerpt for the same reason; this closes the other door. The title still matches,
 * through `fuzzyScore` on the authored title below, which is where a title match belongs.
 */
export async function queryLibrary(root: string, req: LibraryQueryRequest = {}): Promise<LibraryQueryResult> {
  const realRoot = realpathSync(root)
  const { docs, excerpts, truncated: universeTruncated } = await listProjectDocsDetailed(realRoot)
  const query = req.query ?? ''
  const needle = query.trim().toLowerCase()
  const limit = Math.max(1, Math.min(req.limit ?? DOCS.maxDocs, DOCS.maxDocs))
  const kinds = req.kinds?.length ? new Set(req.kinds) : undefined
  let truncated = universeTruncated

  const rows: LibraryDoc[] = []
  let totalMatches = 0
  for (const doc of docs) {
    // resolvedKind is applied HERE, once, before filtering — a renderer re-deriving the folder
    // fallback becomes the second source of truth this design exists to remove.
    const resolvedKind = doc.kind ?? inferDocKind(doc.rel)
    if (kinds && !kinds.has(resolvedKind)) continue
    let nameMatch = false
    let score = 0
    let matches: SearchLineMatch[] = []
    if (needle) {
      // The filename AND the authored title, because the Library shows the title: a document titled
      // "Phone tiers" in `notes-3.md` has to be findable by what it says it is.
      const byName = fuzzyScore(needle, doc.name)
      const byTitle = doc.title ? fuzzyScore(needle, doc.title) : null
      const best = byName === null ? byTitle : byTitle === null ? byName : Math.max(byName, byTitle)
      nameMatch = best !== null
      score = best ?? 0
      if (totalMatches < SEARCH.maxTotalMatches) {
        const scan = await scanFileContents(doc.path, needle, { skipFrontmatter: true, root: realRoot })
        matches = scan.binary ? [] : scan.matches
        if (scan.truncated) truncated = true
        totalMatches += matches.length
        if (totalMatches >= SEARCH.maxTotalMatches) truncated = true
      } else {
        truncated = true
      }
      if (!nameMatch && matches.length === 0) continue
    }
    rows.push({ ...doc, resolvedKind, excerpt: excerpts.get(doc.path), nameMatch, score, matches })
  }

  // Ranked in main because `limit` cuts the list here: a name match first (best score wins), then
  // everything found by its contents, in the recency order the unfiltered library already uses.
  rows.sort((a, b) => {
    if (a.nameMatch !== b.nameMatch) return a.nameMatch ? -1 : 1
    if (a.nameMatch && a.score !== b.score) return b.score - a.score
    return b.mtimeMs - a.mtimeMs
  })
  if (rows.length > limit) truncated = true
  return { root: realRoot, query, truncated, docs: rows.slice(0, limit) }
}

/**
 * The first ~`maxChars` of a doc's PROSE — the phone's page-preview cards render this miniature so the
 * user recognizes their document by its content, not its filename. Frontmatter is skipped: once
 * documents carry `title`/`description`/`kind`, a preview that started at byte 0 would open with the
 * metadata block on every card. Contained like every other access; fail-soft (missing/unreadable →
 * undefined) because a preview is decoration, never worth an error. Partial read (never the whole
 * file) so a huge doc costs one small disk hit per listing.
 */
export async function docExcerpt(root: string, rel: string, maxChars = 600): Promise<string | undefined> {
  try {
    return (await readDocMetadata(containedReal(root, rel), maxChars, root)).excerpt
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
  invalidateDocsCache(root)
  return dest
}

export type ProjectDocumentDeleteTarget = RequiredCheckpointFile

/** Exact shortcut refreshes are intentionally independent of the recency discovery cap (300), but
 *  still bounded when this service is called outside its validated IPC handler. */
const LIBRARY_RESOLVE_MAX = 1000

/** Resolve a file lexically: parents may resolve, but the leaf is lstat'd and never followed. */
async function resolveLexicalRegularProjectFile(
  root: string,
  requested: string,
): Promise<RequiredCheckpointFile> {
  const realRoot = realpathSync(root)
  const candidate = resolve(realRoot, requested)
  const realParent = realpathSync(dirname(candidate))
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep))
    throw new Error('path escapes the project root')
  const path = join(realParent, basename(candidate))
  const nativeRel = relative(realRoot, path)
  if (!nativeRel || nativeRel === '..' || nativeRel.startsWith(`..${sep}`) || isAbsolute(nativeRel))
    throw new Error('path escapes the project root')

  const current = await lstat(path, { bigint: true })
  if (!current.isFile()) throw new Error('not a regular file')
  return {
    path,
    rel: nativeRel.split(sep).join('/'),
    fingerprint: {
      dev: current.dev,
      ino: current.ino,
      type: 'regular-file',
      size: current.size,
      mtimeNs: current.mtimeNs,
      ctimeNs: current.ctimeNs,
    },
  }
}

/** The exact resolver and document-only destructive path share this eligibility gate. Otherwise a
 *  remembered shortcut could expose actions for a path the Library walk correctly prunes. */
async function assertLibraryDocumentTarget(
  root: string,
  target: RequiredCheckpointFile,
): Promise<void> {
  const parts = target.rel.split('/')
  const name = parts.pop() ?? ''
  if (!isLibraryDocRel(target.rel) || isNonUserDoc(name) || parts.some(isExcludedDocsDir))
    throw new Error('not a Library document')

  // Match the Library walk's bundle pruning too: a Markdown sibling inside a skill/plugin bundle is
  // agent context, not a user document, even when its extension and directory names look ordinary.
  let dir = realpathSync(root)
  for (let depth = 0; depth <= parts.length; depth++) {
    const entries = await readdir(dir, { withFileTypes: true })
    if (hasLibraryBundleMarker(entries)) throw new Error('not a Library document')
    if (depth < parts.length) dir = join(dir, parts[depth])
  }
}

/**
 * Resolve remembered project-relative document identities without doing a tree walk. Results stay in
 * request order, duplicate identities collapse to their first occurrence, and stale/ineligible paths
 * are omitted. That omission is deliberate: the renderer owns the remembered shortcut and can render
 * it as stale, while main owns whether any current filesystem object is eligible for file actions.
 */
export async function resolveProjectDocs(root: string, rels: string[]): Promise<ProjectDoc[]> {
  if (rels.length > LIBRARY_RESOLVE_MAX)
    throw new Error(`too many document paths (maximum ${LIBRARY_RESOLVE_MAX})`)
  const realRoot = realpathSync(root)
  const docs: Array<ProjectDoc | undefined> = new Array(rels.length)

  await mapConcurrent(rels, DOC_META_CONCURRENCY, async (requested, index) => {
    if (!requested) return
    try {
      const target = await resolveLexicalRegularProjectFile(realRoot, requested)
      await assertLibraryDocumentTarget(realRoot, target)
      const { fm } = await readAdmittedDocMetadata(target.path, target.rel, realRoot)
      // Metadata reads are fail-soft by design, but an exact resolver must not return a path that was
      // swapped while its row was being enriched. A later refresh may pick up the replacement if it is
      // independently eligible.
      const after = await resolveLexicalRegularProjectFile(realRoot, target.path)
      if (!sameRequiredFileFingerprint(after.fingerprint, target.fingerprint)) return
      docs[index] = {
        path: target.path,
        rel: target.rel,
        name: basename(target.path),
        mtimeMs: Number(target.fingerprint.mtimeNs) / 1_000_000,
        ...(fm.title ? { title: fm.title } : {}),
        ...(fm.description ? { description: fm.description } : {}),
        ...(fm.kind ? { kind: fm.kind } : {}),
        ...(fm.source ? { source: fm.source } : {}),
      }
    } catch {
      // Missing, escaping, symlinked, unreadable and excluded rows are all stale from the shortcut's
      // perspective. One bad remembered path must not blank the rest of the shelf.
    }
  })

  const seen = new Set<string>()
  return docs.filter((doc): doc is ProjectDoc => {
    if (!doc || seen.has(doc.path)) return false
    seen.add(doc.path)
    return true
  })
}

/** Validate the one sidebar-document file before its recovery checkpoint is taken. */
export async function prepareProjectDocumentDelete(
  root: string,
  requested: string,
): Promise<ProjectDocumentDeleteTarget> {
  const target = await resolveLexicalRegularProjectFile(root, requested)
  await assertLibraryDocumentTarget(root, target)
  return target
}

/**
 * `rename` may update ctime even when the file's bytes and inode did not change, so the post-rename
 * comparison deliberately uses the stable identity facts and mtime rather than the prepared ctime.
 */
function samePreparedFileAfterRename(
  current: RequiredCheckpointFile['fingerprint'],
  prepared: RequiredCheckpointFile['fingerprint'],
): boolean {
  return (
    current.dev === prepared.dev &&
    current.ino === prepared.ino &&
    current.type === prepared.type &&
    current.size === prepared.size &&
    current.mtimeNs === prepared.mtimeNs
  )
}

function fingerprintOf(current: BigIntStats): RequiredCheckpointFile['fingerprint'] {
  return {
    dev: current.dev,
    ino: current.ino,
    type: 'regular-file',
    size: current.size,
    mtimeNs: current.mtimeNs,
    ctimeNs: current.ctimeNs,
  }
}

async function removeEmptyQuarantine(dir: string): Promise<void> {
  try {
    await rmdir(dir)
  } catch {
    // Never recursively clean an exclusive quarantine: an outside writer could have placed an
    // unverified entry there. An empty-dir cleanup miss is safer than deleting something we did not
    // prepare.
  }
}

async function createDocumentQuarantine(parent: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    // `.noindex` routes a preserved quarantine through the Library's existing derived-directory
    // exclusion, so a refused delete never makes the guarded replacement appear as a second document.
    const dir = join(parent, `.koda-delete-${randomUUID()}.noindex`)
    try {
      await mkdir(dir, { mode: 0o700 })
      return dir
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('could not create an exclusive document quarantine')
}

/** Restore a regular quarantined entry without ever overwriting a newly-created original path. A
 *  same-directory hard link is an atomic create-if-absent; once it lands, removing the quarantine
 *  name cannot lose the object. Non-regular or contended entries stay preserved at the returned path. */
async function restoreQuarantinedEntry(
  original: string,
  quarantined: string,
  quarantineDir: string,
): Promise<'restored' | 'preserved'> {
  try {
    const current = await lstat(quarantined)
    if (!current.isFile()) return 'preserved'
    await link(quarantined, original)
  } catch {
    return 'preserved'
  }
  try {
    await unlink(quarantined)
  } catch {
    // The object is already restored under `original`; retaining an extra quarantine link is safe.
  }
  await removeEmptyQuarantine(quarantineDir)
  return 'restored'
}

export interface ProjectDocumentDeleteTestHooks {
  /** Deterministic race seam: production never supplies this. */
  afterFinalPrecheck?: () => void | Promise<void>
}

/**
 * Delete exactly the prepared, checkpointed document. The candidate is first moved atomically into an
 * exclusive same-directory quarantine, then its inode is compared with the still-open prechecked file
 * before anything is unlinked. A last-moment replacement is restored without clobbering, or preserved
 * under the quarantine path when an atomic restore is not safe.
 */
export async function deleteProjectDocument(
  root: string,
  prepared: ProjectDocumentDeleteTarget,
  testHooks: ProjectDocumentDeleteTestHooks = {},
): Promise<void> {
  const current = await resolveLexicalRegularProjectFile(root, prepared.path)
  if (
    current.path !== prepared.path ||
    current.rel !== prepared.rel ||
    !sameRequiredFileFingerprint(current.fingerprint, prepared.fingerprint)
  )
    throw new Error('document changed before it could be deleted')

  const handle = await open(current.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new Error('document changed before it could be deleted')
  })
  let quarantineDir: string | undefined
  let quarantined: string | undefined
  try {
    const heldBefore = await handle.stat({ bigint: true })
    if (!heldBefore.isFile()) throw new Error('document changed before it could be deleted')
    const heldBeforeFingerprint = fingerprintOf(heldBefore)
    if (!sameRequiredFileFingerprint(heldBeforeFingerprint, prepared.fingerprint))
      throw new Error('document changed before it could be deleted')

    await testHooks.afterFinalPrecheck?.()

    quarantineDir = await createDocumentQuarantine(dirname(current.path))
    quarantined = join(quarantineDir, basename(current.path))
    try {
      await rename(current.path, quarantined)
    } catch {
      await removeEmptyQuarantine(quarantineDir)
      throw new Error('document changed before it could be deleted')
    }

    let verified = false
    try {
      const [moved, heldAfter] = await Promise.all([
        lstat(quarantined, { bigint: true }),
        handle.stat({ bigint: true }),
      ])
      if (moved.isFile() && heldAfter.isFile()) {
        const movedFingerprint = fingerprintOf(moved)
        const heldFingerprint = fingerprintOf(heldAfter)
        verified =
          sameRequiredFileFingerprint(movedFingerprint, heldFingerprint) &&
          samePreparedFileAfterRename(movedFingerprint, prepared.fingerprint)
      }
    } catch {
      verified = false
    }

    if (!verified) {
      const restoration = await restoreQuarantinedEntry(current.path, quarantined, quarantineDir)
      if (restoration === 'restored')
        throw new Error('document changed before it could be deleted; the replacement was restored')
      throw new Error(
        `document changed before it could be deleted; the replacement was preserved at ${quarantined}`,
      )
    }

    try {
      await unlink(quarantined)
    } catch {
      const restoration = await restoreQuarantinedEntry(current.path, quarantined, quarantineDir)
      if (restoration === 'restored')
        throw new Error('document could not be deleted; the checkpointed file was restored')
      throw new Error(`document could not be deleted; the checkpointed file remains at ${quarantined}`)
    }
    await removeEmptyQuarantine(quarantineDir)
    invalidateDocsCache(root)
  } finally {
    await handle.close()
  }
}

/**
 * Delete a file or folder (recursive for a folder). Contained to the project root; the root itself
 * can't be deleted. The caller checkpoints first, so a delete is recoverable from the timeline.
 */
export async function deleteProjectPath(root: string, target: string): Promise<void> {
  const real = containedReal(root, target)
  if (real === realpathSync(root)) throw new Error('cannot delete the project root')
  await rm(real, { recursive: true, force: false })
  invalidateDocsCache(root)
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
  invalidateDocsCache(root)
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
  invalidateDocsCache(root)
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
  if (out.length) invalidateDocsCache(root)
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
  // `truncated` reports a partial RESULT; `stop` ends the walk. Only the three real ceilings below stop
  // it. A per-file signal (an unreadable file, hits beyond the per-file cap) makes the answer partial
  // and must not abandon the tree: files with a long matching line are ordinary, so one flag serving
  // both ends the search a few files in and reports "No matches" for a project full of them.
  let truncated = false
  let stop = false

  async function walk(dir: string): Promise<void> {
    if (stop) return
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
      if (stop) return
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
        stop = true
        return
      }
      const rel = relative(realRoot, full).split(sep).join('/')
      const nameScore = fuzzyScore(needle, d.name)
      const nameMatch = nameScore !== null
      const scan = await scanFileContents(full, needle, { root: realRoot })
      if (scan.truncated) truncated = true
      if (scan.binary) {
        // Binary file: still report it on a filename match (you can open it), just no line hits.
        if (nameMatch) files.push({ path: full, rel, name: d.name, nameMatch, score: nameScore, matches: [] })
        continue
      }
      const matches = scan.matches
      totalMatches += matches.length
      if (totalMatches >= SEARCH.maxTotalMatches) {
        truncated = true
        stop = true
      }
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
  if (filesChanged) invalidateDocsCache(root)
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
 *  line hits (windowed preview, capped per file). Reads at most MAX_FILE_BYTES, like readProjectFile.
 *
 *  `skipFrontmatter` (the Library) scans the BODY only, so a document's metadata block is never
 *  reported as something the document says. Reported line numbers stay absolute — the skipped block's
 *  line count is added back — because a caller uses them to open the file at the hit. */
async function scanFileContents(
  full: string,
  needle: string,
  opts: { skipFrontmatter?: boolean; root: string },
): Promise<{ matches: SearchLineMatch[]; binary: boolean; truncated: boolean }> {
  let buf: Buffer
  let truncated: boolean
  try {
    const safe = await readContainedRegularFile(opts.root, full, MAX_FILE_BYTES)
    buf = safe.bytes
    truncated = safe.truncated
  } catch {
    return { matches: [], binary: false, truncated: true }
  }
  if (buf.includes(0)) return { matches: [], binary: true, truncated }
  const raw = buf.toString('utf8')
  // The SAME split and the SAME is-this-metadata test the doc reader uses, rather than a second regex
  // free to disagree with them. `isDocFrontmatterBlock` is what keeps a body that opens with a
  // rule-delimited pull quote — fence-identical to frontmatter — from having its first lines skipped.
  const split = splitDocumentFrontmatter(raw)
  const skipBlock = Boolean(opts.skipFrontmatter) && (split.kind === 'koda' || split.kind === 'yaml')
  const text = skipBlock ? split.body : raw
  const lineOffset = skipBlock ? countNewlines(raw.slice(0, raw.length - text.length)) : 0
  const matches: SearchLineMatch[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const idx = line.toLowerCase().indexOf(needle)
    if (idx === -1) continue
    // A long line is windowed around its match by `previewLine`, not dropped, so the hit IS reported —
    // that is a display window, not a partial result, and marking it truncated made almost every file
    // in an ordinary project claim the search had given up.
    if (matches.length < SEARCH.maxMatchesPerFile)
      matches.push({ line: lineOffset + i + 1, preview: previewLine(line, idx) })
    else truncated = true
  }
  return { matches, binary: false, truncated }
}

/** How many lines a skipped prefix occupied, so a reported line number still opens the right line. */
function countNewlines(text: string): number {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
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
