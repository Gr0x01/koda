/**
 * "Keep this as a document" — the USER-ASKED half of offer-and-keep (document-workspace.md, "The magic
 * layer" §1). The user says some version of "keep this", and the conversation that just happened lands
 * as a durable document under `Documents/`.
 *
 * The polarity is the feature, not a detail of it. Koda never decides on its own that a conversation was
 * worth keeping: nothing in this path has a timer, a hook or a background pass, and the only caller is
 * the broker tool the agent invokes after the user has asked for it. The one audience segment that owns
 * notes named the opposite build as its fear — "the feeling that my vault is slowly being rewritten
 * behind my back" — so a write nobody asked for is the defect here, not the capability.
 *
 * Creation routes through `createProjectFile` instead of writing the file directly, and three things ride
 * on that. The document is born with the same `title`/`date`/`kind` block every other Koda-made document
 * gets. The dedupe and `wx` no-clobber guarantees hold, so keeping twice can never overwrite the first
 * one. And the session id lands in `source:` — provenance the agent has no other way to supply, because
 * that id lives in main and never enters the transcript.
 *
 * What this module can and cannot police: it cannot judge whether a conversation was worth keeping, so
 * the editorial bar ("an empty result is a valid result; manufacturing content to fill it is the
 * failure") is carried by the tool description and the shipped playbook. What it CAN enforce is the one
 * mechanical half of that bar the design writes down — a `description` that merely restates the title is
 * worse than none, because it fills the slot the Library would otherwise use to say something.
 */
import { mkdir } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { DocKindSchema, type DocKind } from '@shared/ipc'
import { isDocFrontmatterBlock, splitFrontmatter } from './doc-frontmatter'
import { containedReal, createProjectFile, DOCS_HOME } from './fs-browse'

/** What the agent supplies. Raw strings: this is an MCP boundary, so everything is validated here
 *  rather than trusted, and every failure comes back as a sentence that teaches the rule. */
export interface KeepDocumentArgs {
  title: string
  description: string
  kind: string
  body: string
  /** Project-relative topic folder, e.g. `Documents/decisions`. Absent ⇒ the `Documents/` root. */
  folder?: string
}

/** What the agent gets back, so it can tell the user where the document went in their own terms. */
export interface KeptDocument {
  kept: true
  /** Project-relative, POSIX-separated — the form every other Koda surface names a document by. */
  path: string
  title: string
  kind: DocKind
}

/** Long enough for a real document title, short of the 255-byte filename ceiling once `.md` and a
 *  dedupe suffix are added — and short enough that a Library row stays one readable line. */
const MAX_TITLE_CHARS = 120

export async function keepDocument(
  root: string,
  args: KeepDocumentArgs,
  sessionId: string,
): Promise<KeptDocument> {
  const title = requireText(args.title, 'title', "the document's name, e.g. \"Branch management notes\"")
  if (title.length > MAX_TITLE_CHARS) {
    throw new Error(`title is too long (${title.length} characters, max ${MAX_TITLE_CHARS}) — name the document, don't summarize it`)
  }
  const description = requireText(
    args.description,
    'description',
    'one honest sentence saying what this document is for — it is the line the Library shows under the title',
  )
  if (restates(title, description)) {
    throw new Error(
      'description just restates the title, which is worse than leaving it out — it fills the one line the Library has to tell a reader what this is for. Say what the document is FOR, or what it settles.',
    )
  }
  const kind = readKind(args.kind)
  const body = readBody(args.body)

  const realRoot = realpathSync(root)
  const parent = await resolveFolder(realRoot, args.folder)
  // Born through the one creation path: title/date/kind/source, dedupe, and the no-clobber write.
  // The authored kind wins over the destination folder's fallback, and all authored content rides the
  // same exclusive write as the metadata. There is no metadata-only intermediate file to strand.
  const file = await createProjectFile(realRoot, title, parent, sessionId, { description, kind, body })

  return {
    kept: true,
    path: relative(realRoot, file).split(sep).join('/'),
    // The title the document actually GOT, which is the requested one unless a document of that name
    // already existed and it was deduped. Reporting the asked-for title there would have the agent tell
    // the user a name that is not on the page.
    title: basename(file, extname(file)),
    kind,
  }
}

/** A required free-text field, with the reason it exists in the failure the agent reads. */
function requireText(value: unknown, field: string, wants: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${field} is required — ${wants}`)
  return text
}

/**
 * Does the description say anything the title did not? Compared on letters and digits only, so
 * "Branch management notes" and "branch-management notes." are the same non-answer. Deliberately an
 * EXACT normalized comparison rather than a similarity score: a fuzzy threshold would start rejecting
 * legitimately short descriptions, and this check only has to catch the copy-paste case the design
 * warns about by name.
 */
function restates(title: string, description: string): boolean {
  const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return normalize(title) === normalize(description)
}

/** The closed six-kind vocabulary (document-workspace.md, settled decisions). Authored, not guessed:
 *  the folder-derived fallback exists for documents nobody classified, and a kept conversation has an
 *  author right there. */
function readKind(value: unknown): DocKind {
  const parsed = DocKindSchema.safeParse(typeof value === 'string' ? value.trim().toLowerCase() : value)
  if (!parsed.success) {
    throw new Error(`kind is required, and must be one of: ${DocKindSchema.options.join(', ')}`)
  }
  return parsed.data
}

/**
 * The document's own words. A frontmatter block the agent wrote into the body is dropped rather than
 * kept: the block this document carries is the one Koda just gave it, and two stacked blocks render as
 * a stray table at the top of the page.
 *
 * Dropped only when the leading block IS metadata, though. `---` is also markdown's thematic break, so
 * a body that opens with a rule-delimited pull quote is fence-identical to frontmatter, and stripping
 * on the fences alone deleted the first thing the user wrote with nothing on screen saying so.
 */
function readBody(value: unknown): string {
  const raw = typeof value === 'string' ? value : ''
  const trimmed = raw.trim()
  const text = (isDocFrontmatterBlock(trimmed) ? splitFrontmatter(trimmed).body : trimmed).trim()
  if (!text) {
    throw new Error(
      "body is required — the document's own words. If the conversation produced nothing durable, don't write a document: say so instead.",
    )
  }
  return `${text}\n`
}

/**
 * Resolve the topic subfolder, creating it when the topic is genuinely new (the routed playbook allows
 * exactly that). Two containment layers, because this argument crosses an MCP boundary: a lexical pass
 * that refuses traversal and forces the destination under `Documents/`, then `containedReal`, which
 * realpaths the created directory and refuses anything that landed outside the project — the defense a
 * lexical check alone cannot make when `Documents` is itself a symlink.
 *
 * Scoping to `Documents/` is load-bearing rather than tidy. Without it this tool writes agent-supplied
 * text to any path in the project while classifying as neither Write nor Edit to the approval gate.
 */
async function resolveFolder(realRoot: string, requested: string | undefined): Promise<string | undefined> {
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
