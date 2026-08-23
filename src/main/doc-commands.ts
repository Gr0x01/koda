/**
 * Project-document commands — the one owner of what happens to a document as a *thing the user keeps*,
 * as opposed to bytes on disk (`fs-browse.ts`) or a document being born (`keep-document.ts`).
 *
 * It exists because Koda is conversation-first. A meaningful document action that only a button can
 * perform is half a feature: the user can star a document from the Library but cannot ask for it, and
 * the agent has no honest way to help. The alternative — letting the agent reach into renderer state —
 * is worse, because durable project truth would then live in whichever window happened to be open. So
 * every document command lands here, and the visible control and the broker tool are both thin adapters
 * over it (typed-documents plan, "Agent operability is part of the surface contract").
 *
 * The first command is star/unstar, and moving it exposed the second reason this module exists: the
 * shelf used to live in the renderer-owned sessions blob under Koda's `userData`, in a file named by a
 * hash of the project's ABSOLUTE path. Move the project folder and every star silently disappeared —
 * the documents were fine, the record of which ones mattered was addressed by where the folder used to
 * be. The shelf now lives at `<project>/.koda/doc-shelf.json`, so it travels with the work, and it is
 * deliberately NOT excluded from the safety store: rewinding a checkpoint should take the shelf back
 * with the documents it describes, not leave shortcuts pointing at files that no longer exist.
 *
 * Reads are fail-open (a missing or corrupt shelf is an empty shelf, never an error the user meets),
 * writes are serialized read-merge-write per project — the same shape as `docmeta.ts`, for the same
 * reason: several independent writers (two windows, the agent, a rename repair) patch one file.
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { IpcChannels } from '@shared/channels'
import { isUnderDocumentsHome } from '@shared/document-contract'
import {
  DocKindSchema,
  DocShelfSchema,
  type CreateInteractiveRequest,
  type CreateInteractiveResult,
  type DocFormat,
  type DocKind,
  type DocShelf,
  type DocStarRequest,
  type LegacyDocStarsRequest,
} from '@shared/ipc'
import { writeFileAtomic } from './atomic-write'
import { docDateStamp, inferDocKind } from './doc-frontmatter'
import {
  containedReal,
  createProjectFile,
  createProjectHtmlFile,
  DOCS_HOME,
  resolveDocumentsFolder,
} from './fs-browse'
import { renderKodaHtmlDocument, escapeHtml } from './html-document'
import { log } from './logger'
import { openProjectPaths, windowForProject } from './window-registry'

/** What the agent gets back, in its own terms: which path is on the shelf now, and in which state. */
export interface StarredDocument {
  path: string
  starred: boolean
}

const EMPTY_SHELF: DocShelf = { version: 1, starred: [], settled: [] }

function shelfPath(projectDir: string): string {
  return join(projectDir, '.koda', 'doc-shelf.json')
}

/** Read the project's shelf for DISPLAY. Fail-open: absent, unreadable, or malformed all mean
 *  "nothing starred yet", because a shelf we cannot parse must never become an error in front of a
 *  document. Never use this as the read half of a write — see `readForWrite`. */
export async function readDocShelf(projectDir: string): Promise<DocShelf> {
  try {
    return await readForWrite(projectDir)
  } catch {
    return EMPTY_SHELF
  }
}

/**
 * The read half of a read-merge-write, which is a different question from the display read above.
 *
 * Here "I could not read it" must NOT collapse into "there is nothing there". A transient EACCES or
 * EMFILE, or a half-written file, would otherwise merge the user's whole shelf down to the one path
 * they just clicked — the write would then make that guess permanent. Only a genuinely absent file
 * means an empty shelf; everything else throws, and every caller is built for that: the renderer rolls
 * its optimistic change back, and adoption keeps its legacy copy and runs again next launch.
 */
async function readForWrite(projectDir: string): Promise<DocShelf> {
  let raw: string
  try {
    raw = await readFile(shelfPath(projectDir), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return EMPTY_SHELF
    throw new Error(
      `the document shelf could not be read (${(err as NodeJS.ErrnoException)?.code ?? 'unknown'})`,
      { cause: err },
    )
  }
  let parsed: ReturnType<typeof DocShelfSchema.safeParse>
  try {
    parsed = DocShelfSchema.safeParse(JSON.parse(raw))
  } catch (err) {
    throw new Error('the document shelf on disk is not readable, so it was left alone', { cause: err })
  }
  if (!parsed.success) throw new Error('the document shelf on disk is not readable, so it was left alone')
  return { ...parsed.data }
}

/**
 * Star or unstar one document.
 *
 * Starring requires a real file inside the project: a shelf entry is a promise that the shortcut opens
 * something, and this is the boundary the agent crosses, so a typo has to come back as a sentence
 * rather than as a dead row the user discovers later. Unstarring deliberately does NOT, because the
 * paths most worth removing are the ones whose file is already gone.
 */
export async function setDocStar(projectDir: string, request: DocStarRequest): Promise<DocShelf> {
  const rel = request.starred
    ? existingDocumentPath(projectDir, request.path)
    : relativeInsideProject(projectDir, request.path)
  return mutate(projectDir, (shelf) => {
    const starred = request.starred
      ? shelf.starred.includes(rel)
        ? shelf.starred
        : [...shelf.starred, rel]
      : shelf.starred.filter((path) => path !== rel)
    // A decision, either way, settles the path: an old archived chat or a stale local key that still
    // carries it can no longer vote it back on.
    return { ...shelf, starred, settled: mergePaths(shelf.settled, [rel]) }
  })
}

/**
 * Adopt star sources that predate this shelf, and answer with the durable result.
 *
 * `starred` is what the caller currently holds and has already filtered through its own ledger;
 * `settled` is that ledger, inherited here so the tombstones survive the deletion of the legacy copy.
 * The SHELF's ledger is what filters this call: a path this project already decided about cannot be
 * re-adopted, which is what stops a stale legacy copy from resurrecting a document the user unstarred
 * afterwards. The resolved shelf is the acknowledgement — only after it lands may the caller delete
 * its legacy copy, so a failure leaves the old copy intact and the migration simply runs again.
 */
export async function adoptLegacyDocStars(
  projectDir: string,
  legacy: LegacyDocStarsRequest,
): Promise<DocShelf> {
  const candidates = legacy.starred
    .map((path) => safeRelative(projectDir, path))
    .filter((path): path is string => !!path)
  const settled = legacy.settled
    .map((path) => safeRelative(projectDir, path))
    .filter((path): path is string => !!path)
  return mutate(projectDir, (shelf) => {
    const decided = new Set(shelf.settled)
    const adopted = candidates.filter((path) => !decided.has(path))
    return {
      ...shelf,
      starred: mergePaths(shelf.starred, adopted),
      // Every offered path is settled afterwards, including the ones the ledger refused — that is the
      // record which makes the deletion of the legacy copy safe.
      settled: mergePaths(shelf.settled, settled, candidates),
    }
  })
}

/**
 * Carry the shelf through a Koda rename, move, or delete. `to: null` is a delete.
 *
 * This is main-side because the repair used to depend on a live renderer noticing the change: an
 * agent-run `mv` left the shelf pointing at a path that no longer existed, and a window that was closed
 * during the rename never learned. Folder moves carry their descendants, and both the old and the new
 * path are settled so a legacy source cannot reintroduce the pre-rename path.
 */
export async function rebaseDocStars(
  projectDir: string,
  from: string,
  to: string | null,
): Promise<DocShelf> {
  const fromRel = safeRelative(projectDir, from)
  const toRel = to === null ? null : safeRelative(projectDir, to)
  if (!fromRel || (to !== null && !toRel)) return readDocShelf(projectDir)
  return mutate(projectDir, (shelf) => {
    const touched: string[] = []
    const starred: string[] = []
    for (const path of shelf.starred) {
      const moved = rebase(path, fromRel, toRel)
      if (moved === null) {
        touched.push(path)
        continue
      }
      starred.push(moved)
      if (moved !== path) touched.push(path, moved)
    }
    if (!touched.length) return shelf
    return { ...shelf, starred: mergePaths(starred), settled: mergePaths(shelf.settled, touched) }
  })
}

/**
 * What the shelf holds right before a recovery rewinds the tree. Returns null when the file cannot be
 * read at all, which is the honest answer: recovery must not treat an unreadable shelf as an empty one
 * and then write that guess back.
 */
export async function readDocShelfForRecovery(projectDir: string): Promise<DocShelf | null> {
  try {
    return await readForWrite(projectDir)
  } catch {
    return null
  }
}

/**
 * Put the shelf back on its feet after a recovery, and tell the window what it now says.
 *
 * Restoring rewinds `.koda/doc-shelf.json` with the documents it describes, which is the behavior we
 * want: the shortcut comes back with the file. But a checkpoint taken before the shelf existed — or
 * before the user starred anything — simply has no shelf in it, and the restore deletes the file. That
 * silence is not a claim that the user had no stars, so the pre-restore shelf is written back rather
 * than lost. A target that DOES carry a shelf speaks for itself and is left exactly as restored.
 */
export async function reconcileDocShelfAfterRestore(
  projectDir: string,
  before: DocShelf | null,
): Promise<void> {
  const restored = await readDocShelfForRecovery(projectDir)
  const carriedNothing = !existsSync(shelfPath(projectDir))
  if (carriedNothing && before && (before.starred.length || before.settled.length)) {
    // Straight through the serialized writer, so it cannot interleave with a star made in the meantime.
    await mutate(projectDir, (shelf) => (shelf.starred.length || shelf.settled.length ? shelf : before))
    return
  }
  publish(projectDir, restored ?? before ?? EMPTY_SHELF)
}

/** The broker adapter's shape: run the same command and answer in the agent's terms. */
export async function starDocument(projectDir: string, request: DocStarRequest): Promise<StarredDocument> {
  const shelf = await setDocStar(projectDir, request)
  const rel = request.starred
    ? existingDocumentPath(projectDir, request.path)
    : relativeInsideProject(projectDir, request.path)
  return { path: rel, starred: shelf.starred.includes(rel) }
}

// ── Creating a document ───────────────────────────────────────────────────────
//
// The second command to land here, and the one that closes the ledger's oldest gap: until now a
// document the AGENT made was born by raw `Write`, so it arrived with no title block, no kind, and no
// provenance, while every document the Library's own "New document" button made carried all three
// (Documents/architecture/document-command-ledger.md, note 1). One command, two formats, and the
// routing between them stated in the tool description the agent reads on every turn.

/** What a caller asks for. Raw strings on the format/kind fields: this crosses an agent boundary, so
 *  everything is validated here and every refusal comes back as a sentence that teaches the rule. */
export interface CreateDocumentArgs {
  /** `markdown` | `html`. Validated here — the other three formats are read-only or unbuilt. */
  format: string
  title: string
  kind?: string
  description?: string
  /** Markdown source, or HTML body markup, depending on `format`. Absent ⇒ an empty document. */
  body?: string
  /** Project-relative topic folder under `Documents/`, e.g. `Documents/decisions`. Created if new. */
  folder?: string
}

/** Where the document landed, in the terms every other Koda surface names a document by. */
export interface CreatedDocument {
  created: true
  /** Project-relative, POSIX-separated. */
  path: string
  /** The title the document actually GOT — the requested one unless a file of that name existed. */
  title: string
  format: DocFormat
  kind: DocKind
}

/** The two formats Koda can author. `docx` and `pdf` are export targets that arrive with Slice 3+,
 *  and `text` is the fallback surface for files Koda did not create; none of them is a thing to make.
 *  Exported as the routing assay's source of truth for which of the four branches resolve to a document
 *  Koda can create versus one it deliberately cannot (routing-contract.test.ts). */
export const CREATABLE_DOCUMENT_FORMATS: ReadonlySet<DocFormat> = new Set<DocFormat>(['markdown', 'html'])

/** Long enough for a real document title, short of the 255-byte filename ceiling once an extension and
 *  a dedupe suffix are added — and short enough that a Library row stays one readable line. */
const MAX_TITLE_CHARS = 120

/**
 * Create a document in the format the ask actually needs.
 *
 * Both formats go through the same creation core in `fs-browse.ts` (home resolution, name sanitising,
 * dedupe, exclusive no-clobber write) and are born carrying the same four facts. Only their spelling
 * differs: markdown writes YAML frontmatter, HTML writes `<title>` plus `koda:` meta tags. That is the
 * whole reason this is one command rather than two — a second creation path is how one format ends up
 * without provenance, which is exactly the state this command was written to end.
 *
 * `sessionId` becomes the document's `source`. It is the one field a caller on the far side of an MCP
 * boundary could never supply, because the id lives in main and never enters the transcript.
 */
export async function createDocument(
  root: string,
  args: CreateDocumentArgs,
  sessionId?: string,
): Promise<CreatedDocument> {
  const format = readFormat(args.format)
  const title = readTitle(args.title)
  const realRoot = realpathSync(root)
  const parent = await resolveDocumentsFolder(realRoot, args.folder)
  const folderRel = parent ? toRelative(realRoot, parent) : DOCS_HOME
  // An authored kind always wins; the folder fallback is for documents nobody classified, and it is
  // computed from the DESTINATION rather than the filename, which is what `inferDocKind` reads anyway.
  const kind = args.kind === undefined || args.kind === '' ? inferDocKind(`${folderRel}/x.md`) : readKind(args.kind)
  const description = (args.description ?? '').trim()
  const body = (args.body ?? '').trim()

  const file =
    format === 'markdown'
      ? await createProjectFile(realRoot, title, parent, sessionId, {
          description,
          kind,
          body: body ? `${body}\n` : '',
        })
      : await createProjectHtmlFile(realRoot, title, parent, (ctx) =>
          renderKodaHtmlDocument({
            title: ctx.title,
            kind,
            date: docDateStamp(),
            ...(description ? { description } : {}),
            ...(sessionId ? { source: sessionId } : {}),
            ...(body ? { body } : {}),
          }),
        )

  const rel = toRelative(realRoot, file)
  return { created: true, path: rel, title: titleOf(rel), format, kind }
}

/**
 * Turn a passage of an existing document into a self-contained HTML view beside it.
 *
 * The Slice 2 seam, built now so the renderer's selected-passage action and the agent's tool call are
 * one command from the first day rather than two paths later reconciled. What it deliberately does NOT
 * do is touch the source: the link back into the narrative is the caller's to insert, and an artifact
 * command that also edits the user's prose is two responsibilities with one failure mode — a half-done
 * write that leaves a link pointing at a file that was never created.
 *
 * Answers with a result union rather than throwing, because the refusals here are ordinary (a path
 * that moved, an empty selection) and both adapters have to render them as a sentence rather than as
 * an exception the surface has to survive.
 */
export async function createInteractiveDocument(
  root: string,
  request: CreateInteractiveRequest,
): Promise<CreateInteractiveResult> {
  try {
    const title = readTitle(request.title)
    const selection = (request.selection ?? '').trim()
    if (!selection) {
      return { ok: false, reason: 'selection is required — the passage the interactive view is built from' }
    }
    const realRoot = realpathSync(root)
    const sourceRel = existingSourcePath(realRoot, request.sourcePath)
    // Beside the source when the source is already one of the user's documents, and at the top of
    // `Documents/` otherwise. The artifact is admitted to the Library only under `Documents/`, so
    // filing it next to a source that lives elsewhere would create a document nothing can find.
    const folder = isUnderDocumentsHome(sourceRel) ? dirname(sourceRel) : DOCS_HOME
    const parent = await resolveDocumentsFolder(realRoot, folder)
    const file = await createProjectHtmlFile(realRoot, title, parent, (ctx) =>
      renderKodaHtmlDocument({
        title: ctx.title,
        kind: inferDocKind(ctx.rel),
        date: docDateStamp(),
        // The one record of where this came from, and deliberately only one: a second copy in a meta
        // tag or a data attribute is a second thing a later rename repair would have to find.
        leadingComment: `${INTERACTIVE_SOURCE_MARKER} ${sourceRel}`,
        body: `<section class="koda-seed">\n      <pre>${escapeHtml(selection)}</pre>\n    </section>`,
      }),
    )
    return { ok: true, htmlPath: toRelative(realRoot, file) }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** The comment a Koda-created interactive view carries, naming the document its seed came from. */
export const INTERACTIVE_SOURCE_MARKER = 'koda:source-document'

function readFormat(value: unknown): DocFormat {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!CREATABLE_DOCUMENT_FORMATS.has(raw as DocFormat)) {
    throw new Error(
      'format is required, and must be "markdown" (writing, revising, citing) or "html" (comparing, inspecting, navigating, interacting)',
    )
  }
  return raw as DocFormat
}

function readTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : ''
  if (!title) throw new Error('title is required — the document\'s name, e.g. "Frost date explorer"')
  if (title.length > MAX_TITLE_CHARS) {
    throw new Error(
      `title is too long (${title.length} characters, max ${MAX_TITLE_CHARS}) — name the document, don't summarize it`,
    )
  }
  return title
}

function readKind(value: unknown): DocKind {
  const parsed = DocKindSchema.safeParse(typeof value === 'string' ? value.trim().toLowerCase() : value)
  if (!parsed.success) throw new Error(`kind must be one of: ${DocKindSchema.options.join(', ')}`)
  return parsed.data
}

/** The source a view is built from: a real file inside the project, realpathed on both sides so a
 *  symlink out of the project cannot pose as a document. */
function existingSourcePath(realRoot: string, requested: string): string {
  const cleaned = clean(requested)
  if (!cleaned) throw new Error('sourcePath is required — the project-relative path of the document the passage came from')
  let real: string
  try {
    real = containedReal(realRoot, cleaned)
  } catch {
    throw new Error(`no document at "${cleaned}" — pass a path inside this project`)
  }
  if (!statSync(real).isFile()) throw new Error(`"${cleaned}" is a folder — pass the document the passage came from`)
  return toRelative(realRoot, real)
}

/** The filename without its extension — the title the document actually got after any dedupe. */
function titleOf(rel: string): string {
  const name = rel.split('/').pop() ?? rel
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** `from`/`to` are project-relative. Returns the path's new home, or null when it is gone. */
function rebase(path: string, from: string, to: string | null): string | null {
  const underFrom = path === from || path.startsWith(`${from}/`)
  if (!underFrom) return path
  if (to === null) return null
  return path === from ? to : `${to}${path.slice(from.length)}`
}

/** Stable, first-seen ordering; the shelf's order is the user's order, so a merge never reshuffles. */
function mergePaths(...lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const list of lists) {
    for (const path of list) {
      if (!path || seen.has(path)) continue
      seen.add(path)
      merged.push(path)
    }
  }
  return merged
}

/**
 * A path that must resolve to a real file inside the project. Two layers, because the agent's argument
 * crosses an MCP boundary: `containedReal` realpaths both sides (a symlink out of the project cannot
 * pose as a document), then the target has to actually be a file rather than a folder.
 */
function existingDocumentPath(projectDir: string, requested: string): string {
  const cleaned = clean(requested)
  if (!cleaned) throw new Error('path is required — the project-relative path of the document, e.g. "Documents/brief.md"')
  let real: string
  try {
    real = containedReal(projectDir, cleaned)
  } catch {
    throw new Error(`no document at "${cleaned}" — pass a path inside this project, e.g. "Documents/brief.md"`)
  }
  if (!statSync(real).isFile()) throw new Error(`"${cleaned}" is a folder — star a document, not a folder`)
  return toRelative(projectDir, real)
}

/** A path that only has to BE inside the project. Lexical: nothing is read, so an unstar still works
 *  for a document that has already been renamed or deleted out from under the shelf. */
function relativeInsideProject(projectDir: string, requested: string): string {
  const rel = safeRelative(projectDir, requested)
  if (!rel) throw new Error(`"${clean(requested)}" is not a path inside this project`)
  return rel
}

function safeRelative(projectDir: string, requested: string): string | null {
  const cleaned = clean(requested)
  if (!cleaned) return null
  const root = realRoot(projectDir)
  const abs = resolve(root, cleaned)
  if (abs === root || !abs.startsWith(root + sep)) return null
  return toRelative(root, abs)
}

function toRelative(projectDir: string, absolute: string): string {
  return relative(realRoot(projectDir), absolute).split(sep).join('/')
}

function realRoot(projectDir: string): string {
  try {
    return realpathSync(projectDir)
  } catch {
    return projectDir // an unreadable root fails later, at the write, with a real error
  }
}

function clean(requested: string): string {
  return (typeof requested === 'string' ? requested : '').trim().replace(/\\/g, '/')
}

// Serialize read-merge-write per project. Two windows, the agent, and a rename repair all patch the
// same small file, and an un-serialized RMW drops whichever star lost the race. A per-project promise
// tail is enough because every writer is in this one main process.
const writeQueue = new Map<string, Promise<DocShelf>>()

async function mutate(projectDir: string, patch: (shelf: DocShelf) => DocShelf): Promise<DocShelf> {
  const key = realRoot(projectDir)
  const run = async (): Promise<DocShelf> => {
    // Deliberately the strict read: merging into a fail-open empty shelf and then writing it is how a
    // moment's unreadable file becomes a permanently lost shelf.
    const current = await readForWrite(projectDir)
    const next = patch(current)
    if (same(current, next)) return current
    await mkdir(join(projectDir, '.koda'), { recursive: true })
    writeFileAtomic(shelfPath(projectDir), JSON.stringify(next, null, 2))
    publish(projectDir, next)
    return next
  }
  const tail = (writeQueue.get(key) ?? Promise.resolve(EMPTY_SHELF)).then(run, run)
  writeQueue.set(key, tail)
  void tail.catch(() => undefined).finally(() => {
    if (writeQueue.get(key) === tail) writeQueue.delete(key)
  })
  return tail
}

function same(a: DocShelf, b: DocShelf): boolean {
  const equal = (x: readonly string[], y: readonly string[]): boolean =>
    x.length === y.length && x.every((value, index) => value === y[index])
  return equal(a.starred, b.starred) && equal(a.settled, b.settled)
}

/** Tell the project's window what the shelf now says. The renderer keeps a projection, never its own
 *  copy of the truth, so an agent star and a rename repair reach the shelf the user is looking at. */
function publish(projectDir: string, shelf: DocShelf): void {
  const root = realRoot(projectDir)
  const openPath = openProjectPaths().find((path) => path === projectDir || realRoot(path) === root)
  const win = openPath ? windowForProject(openPath) : undefined
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(IpcChannels.docShelfChanged, shelf)
  } catch (err) {
    log.warn('doc-commands', 'shelf refresh failed', err instanceof Error ? err.message : err)
  }
}
