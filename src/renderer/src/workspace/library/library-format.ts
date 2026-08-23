import { engineCapabilities } from '@shared/engine-capabilities'
import type { DocKind, EngineId, LibraryDoc } from '@shared/ipc'

/**
 * Display language for the Library. Everything here turns a `LibraryDoc` into the three things a
 * reader actually knows a document by: what it is for, roughly when they worked on it, and what it
 * came out of. Nothing here filters or ranks — main owns both (`queryLibrary`), and a second opinion
 * in the renderer would fork the exclusion rule that makes `CLAUDE.md` and vendored skill files
 * unrepresentable in the first place.
 */

const DOC_EXT = /\.(md|markdown|mdx|txt|rst|org)$/i
const DAY_MS = 86_400_000

/** Whether rows rendered from a prior stable query may perform any document action. The Library keeps
 * that list visible during a debounce/slow replacement scan to avoid flashing empty, but Enter,
 * double-click, Open, and Keep must all stand down until the words in the box own the result again. */
export function libraryResultActionable(
  loading: boolean,
  resultQuery: string | undefined,
  currentQuery: string,
): boolean {
  return !loading && resultQuery?.trim() === currentQuery.trim()
}

/** The filter row's order: the four kinds a reader goes looking for, then the two catch-alls. */
export const KIND_ORDER: readonly DocKind[] = ['plan', 'decision', 'research', 'guide', 'reference', 'note']

const KIND_ONE: Record<DocKind, string> = {
  plan: 'Plan',
  decision: 'Decision',
  research: 'Research',
  guide: 'Guide',
  reference: 'Reference',
  note: 'Note',
}

/** The filter row reads as shelves rather than tags, so the kinds are plural there. */
const KIND_MANY: Record<DocKind, string> = {
  plan: 'Plans',
  decision: 'Decisions',
  research: 'Research',
  guide: 'Guides',
  reference: 'Reference',
  note: 'Notes',
}

export function kindLabel(kind: DocKind): string {
  return KIND_ONE[kind]
}

export function kindFilterLabel(kind: DocKind): string {
  return KIND_MANY[kind]
}

/**
 * What the row is called. The authored `title` wins; without one, the filename is cleaned up the way
 * the Documents pane already cleans it (extension gone, slug separators read as spaces) so an
 * un-frontmattered file still reads as a document rather than as `ls` output.
 */
export function docTitle(doc: Pick<LibraryDoc, 'title' | 'name'>): string {
  const authored = doc.title?.trim()
  if (authored) return authored
  return doc.name.replace(DOC_EXT, '').replace(/[-_]+/g, ' ').trim() || doc.name
}

/**
 * The topic shelf a document sits on, as a label instead of a path. Folders under `Documents/` are
 * topics by shipped instruction, so the containing folder is the honest answer to "what did this come
 * out of" until authored `source:` provenance is written at creation. Only the innermost folder is
 * shown, because that is the most specific thing it says; the home folder itself is not a topic.
 */
export function docTopic(rel: string, kind?: DocKind): string {
  const parts = rel.split('/')
  parts.pop()
  const dir = parts[parts.length - 1]
  if (!dir || dir === 'Documents') return ''
  const words = dir.replace(/[-_]+/g, ' ').trim()
  if (!words) return ''
  const label = words.charAt(0).toUpperCase() + words.slice(1)
  // "Decision · Decisions" says one thing twice. When a topic folder is named after the kind it
  // holds, the kind already covers it.
  if (kind && [KIND_ONE[kind], KIND_MANY[kind]].some((k) => k.toLowerCase() === label.toLowerCase()))
    return ''
  return label
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Whole calendar days between two stamps, so 11pm to 1am reads as "yesterday" and not as "2 hours". */
function calendarDaysApart(ms: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS)
}

/**
 * When the reader last worked on it. Minutes and hours while that is the useful cue, then calendar
 * language, then a date. Deliberately coarse: "roughly when" is the thing being recalled, and a
 * precise timestamp would invite reading it as a fact about the document rather than a memory aid.
 */
export function whenLabel(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms)
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} min ago`
  const days = calendarDaysApart(ms, now)
  if (days <= 0) {
    const hours = Math.max(1, Math.floor(diff / 3_600_000))
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  }
  if (days === 1) return 'Yesterday'
  const then = new Date(ms)
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: 'long' })
  const sameYear = then.getFullYear() === new Date(now).getFullYear()
  return then.toLocaleDateString(
    undefined,
    sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' },
  )
}

/**
 * The heading a browse row falls under. The unfiltered library arrives from main in recency order, so
 * these buckets are pure grouping over that order: they insert headings at boundaries and never move,
 * drop or re-sort a row.
 */
export function timeBucket(ms: number, now: number = Date.now()): string {
  const days = calendarDaysApart(ms, now)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'This week'
  if (days < 31) return 'This month'
  return 'Earlier'
}

/**
 * One line of a document's own prose for the row subtitle, used only when nobody authored a
 * `description`. Collapsed to a single line and cut on a word boundary: an excerpt that wraps mid
 * sentence in a list makes the whole column read as scraped text, which is exactly the tell that
 * makes a document surface look like a file listing.
 */
export function excerptLine(excerpt: string | undefined, maxChars = 150): string {
  if (!excerpt) return ''
  const flat = excerpt.replace(/[#>*`_]/g, ' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  const cut = flat.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** "12 documents" / "1 match" for the footer count. */
export function countLabel(n: number, searching: boolean, truncated: boolean): string {
  const noun = searching ? (n === 1 ? 'match' : 'matches') : n === 1 ? 'document' : 'documents'
  return `${n}${truncated ? '+' : ''} ${noun}`
}

/**
 * The header subtitle for the merged search. Browsing promises the files are in here too, so the user
 * who assumed a filename would work never has to guess a second box. A search states the split with the
 * documents count first, because documents ranking above files is a guarantee of this surface, not a
 * scoring accident — the count reads that promise back. `fileCount` is null while the file scan is
 * still running or does not apply (a kind filter, or a query too short to walk the tree), so the
 * subtitle names only what it can currently stand behind.
 */
export function librarySubtitle(
  searching: boolean,
  docCount: number,
  docTruncated: boolean,
  fileCount: number | null,
  fileTruncated: boolean,
): string {
  const docs = `${docCount}${docTruncated ? '+' : ''} ${docCount === 1 ? 'document' : 'documents'}`
  if (!searching) return `${docs}, and every file in this project`
  if (fileCount === null) return docs
  const files = `${fileCount}${fileTruncated ? '+' : ''} ${fileCount === 1 ? 'file' : 'files'}`
  return `${docs} · ${files}`
}

/**
 * Where a project file sits, as a phrase rather than a path fragment — the parent folders when it is
 * nested, or a plain sentence when it sits at the root. A file row and its preview say the file's
 * location this way so the files section never reads as `ls` output beside the documents above it.
 */
export function fileContext(rel: string): string {
  const cut = rel.lastIndexOf('/')
  return cut > 0 ? rel.slice(0, cut) : 'at the top of this project'
}

/**
 * What the ask says when the engine this chat runs on REFUSES it (`ASK_ENGINE_REFUSAL`, thrown by
 * `engineAskRunner` before anything spawns). Main names the engine and this owns the sentence, the
 * same split `followRefusalCopy` uses.
 *
 * Three things, because a refusal that leaves any of them out sends the reader back to the input to
 * retry something that can never work: what happened (nothing ran, nothing was billed), WHY the
 * answer is permanent rather than transient, and what still gets them to the same document. The
 * reason is worth stating plainly instead of hiding behind "not available". The isolation contract is
 * the promise being kept, which is something the user is owed rather than an implementation detail.
 *
 * The brand comes from the capability table, so this reads the same word the engine picker offered
 * ("OpenAI") and a third engine needs no edit here.
 */
export function askRefusalCopy(engine: EngineId): string {
  const label = engineCapabilities(engine).accountLabel
  return (
    `Asking cannot run on ${label} yet, so nothing was sent and nothing was billed. It needs an ` +
    'engine that can answer in Koda’s isolated background mode, which keeps the turn outside your ' +
    'project and unable to change it. Search still finds anything by ' +
    'its title or by a phrase inside it.'
  )
}
