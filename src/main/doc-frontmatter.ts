/**
 * The document metadata substrate: reading the four authored frontmatter fields off a markdown file,
 * and writing the block a new document is born with.
 *
 * Why the file owns its own metadata, rather than the folder or the `.koda/docmeta` sidecar: folders
 * under `Documents/` are TOPICS by shipped instruction, and topic and kind are two taxonomies that
 * already disagree in this repository (`Documents/site/` holds research, a plan, a reference list and
 * a design brief). The sidecar is keyed by a hash of the relative path, so anything stored there dies
 * on a rename or a move. Frontmatter survives both, and both editors already round-trip it
 * byte-for-byte. See Documents/architecture/document-workspace.md.
 *
 * Two rules this module exists to keep:
 *   • NOTHING here throws. A malformed, truncated or exotic YAML block degrades every field to
 *     undefined. One bad file must never blank the user's Documents list.
 *   • Reads are PARTIAL. The doc walk it feeds already costs ~2s on a big repo; it must not also read
 *     hundreds of whole files. Only the head of each file is ever touched.
 *
 * This is deliberately a scalar reader for four known keys, not a YAML implementation. Nested maps,
 * sequences and anchors are ignored rather than parsed — `Documents/design/DESIGN.md` carries design
 * tokens in its frontmatter and must read as "no document metadata", not as a half-parsed document.
 */
import { open } from 'node:fs/promises'
import { DocKindSchema, type DocKind } from '@shared/ipc'
import {
  splitDocumentFrontmatter,
  topLevelFrontmatterScalars,
} from '@shared/document-contract'
import { readContainedRegularFile } from './contained-read'

/** How much of a file's head one read takes. Comfortably over a normal frontmatter block plus the
 *  600-char excerpt that follows it, and small enough that 300 of them cost one disk seek each. A
 *  frontmatter block longer than this reads as absent, which is the correct degradation: a block that
 *  big is not document metadata. */
const DOC_HEAD_BYTES = 8192

/** The four authored fields. Every one optional and every one stays optional — most documents in an
 *  existing project predate the convention. */
export interface DocFrontmatter {
  title?: string
  description?: string
  kind?: DocKind
  /** The id of the session this document came out of, written once at creation. Read back through
   *  `workspace/session-href.ts`, which decides whether that chat is still live, archived, or gone. */
  source?: string
}

/** Split the leading frontmatter off raw text. `block` is the YAML between the fences (empty when
 *  there is none); `body` is everything after, which is what a preview should show. */
export function splitFrontmatter(raw: string): { block: string; body: string } {
  const split = splitDocumentFrontmatter(raw)
  return split.kind === 'koda' || split.kind === 'yaml'
    ? { block: split.block, body: split.body }
    : { block: '', body: raw }
}

/**
 * The keys a Koda frontmatter block is made of — the four authored fields plus the `date` every
 * document is born with. Used to tell a metadata block apart from a `---`-fenced piece of prose,
 * because `---` is also markdown's thematic break: a pull quote written as a rule-delimited block is
 * indistinguishable from frontmatter by fences alone, and treating it as metadata silently deletes it.
 */
/**
 * Is this leading `---` block actually document metadata, rather than a thematic-break-delimited
 * passage of the user's writing? True when the block carries at least one recognized key. Deliberately
 * recognized keys and not merely "looks like `key: value`" — a pull quote opening `Note: the only way
 * out is through.` parses as a key/value pair and is prose.
 *
 * Runs the SAME scalar reader `parseDocFrontmatter` uses, so the question "is this frontmatter?" can
 * never be answered differently from "what does this frontmatter say?".
 */
export function isDocFrontmatterBlock(raw: string): boolean {
  return splitDocumentFrontmatter(raw).kind === 'koda'
}

/**
 * Read the four fields out of raw file text. Top-level `key: value` scalars only: an indented line is
 * a nested structure we do not model, and a line that is not a key is skipped rather than treated as
 * an error. `>` and `|` block scalars fold, because a long `description:` is exactly the field an
 * author or an agent wraps. An unrecognized `kind:` degrades to undefined instead of failing the file.
 */
export function parseDocFrontmatter(raw: string): DocFrontmatter {
  try {
    const { block } = splitFrontmatter(raw)
    if (!block.trim()) return {}
    const fields = topLevelFrontmatterScalars(block)
    const kind = DocKindSchema.safeParse(fields.get('kind')?.toLowerCase())
    return {
      title: nonEmpty(fields.get('title')),
      description: nonEmpty(fields.get('description')),
      kind: kind.success ? kind.data : undefined,
      source: nonEmpty(fields.get('source')),
    }
  } catch {
    return {} // structurally unreachable, and the guarantee is worth more than the branch
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v ? v : undefined
}

/**
 * Read one document's head: its authored frontmatter plus the first `excerptChars` of PROSE. The
 * excerpt starts after the frontmatter deliberately — a preview that opens with `---\ntitle: …` shows
 * the user the plumbing instead of their writing, and once documents carry metadata that would be
 * every preview in the product. Fail-soft: an unreadable or vanished file is empty metadata, never an
 * error, because a listing must not fail over a preview.
 */
export async function readDocMetadata(
  file: string,
  excerptChars = 600,
  root?: string,
): Promise<{ fm: DocFrontmatter; excerpt?: string }> {
  // ×4 covers UTF-8's worst case so `excerptChars` of text survives the byte→string cut, plus room
  // for the frontmatter block that precedes it.
  const bytes = Math.max(DOC_HEAD_BYTES, excerptChars * 4 + DOC_HEAD_BYTES)
  let head: string
  try {
    if (root) {
      head = (await readContainedRegularFile(root, file, bytes)).bytes.toString('utf8')
    } else {
      const fh = await open(file, 'r')
      try {
        const buf = Buffer.alloc(bytes)
        const { bytesRead } = await fh.read(buf, 0, bytes, 0)
        head = buf.subarray(0, bytesRead).toString('utf8')
      } finally {
        await fh.close()
      }
    }
  } catch {
    return { fm: {} }
  }
  // A leading thematic-break passage is prose, not plumbing. The content scanner already asks this
  // same predicate before skipping a block; previews must make the identical decision or the first
  // paragraph disappears from one surface while remaining searchable in another.
  const split = splitDocumentFrontmatter(head)
  const hasFrontmatter = split.kind === 'koda' || split.kind === 'yaml'
  const body = hasFrontmatter ? split.body : head
  const fm = split.kind === 'koda' ? parseDocFrontmatter(head) : {}
  const excerpt = body.slice(0, excerptChars)
  return { fm, excerpt }
}

/**
 * `Documents/` is the home folder, not a topic — a document's first MEANINGFUL path segment is the
 * one after it. Compared case-insensitively against `DOCS_HOME` in fs-browse.ts, kept as a literal
 * here so the metadata reader doesn't import the filesystem module that imports it.
 */
const DOCS_HOME_SEGMENT = 'documents'

/**
 * Folder segments that literally NAME a kind. Deliberately nothing else: mapping `architecture/` or
 * `site/` to a kind would invent a second taxonomy to disagree with the authored one, which is the
 * exact failure that killed folder-derived kind in the design. Everything unrecognized is `note`, the
 * honest catch-all, and the backfill is what makes kinds real.
 */
const KIND_FOLDERS = new Map<string, DocKind>([
  ['plan', 'plan'],
  ['plans', 'plan'],
  ['decision', 'decision'],
  ['decisions', 'decision'],
  ['research', 'research'],
  ['guide', 'guide'],
  ['guides', 'guide'],
  ['reference', 'reference'],
  ['references', 'reference'],
  ['note', 'note'],
  ['notes', 'note'],
])

/** The kind a document gets when nobody authored one: its containing folder if that folder names a
 *  kind, else `note`. The fallback, and nothing more — an authored `kind:` always wins. */
export function inferDocKind(rel: string): DocKind {
  const dirs = rel.split('/').slice(0, -1)
  if (dirs[0]?.toLowerCase() === DOCS_HOME_SEGMENT) dirs.shift()
  const first = dirs[0]?.toLowerCase()
  return (first && KIND_FOLDERS.get(first)) || 'note'
}

/**
 * The frontmatter block a new document is born with. `description` is deliberately absent: it is the
 * one field that cannot be derived (a scraped first paragraph is an excerpt, not a description), so
 * the agent authors it. Writing this at creation rather than instructing the agent to is the whole
 * point — the fix for a skipped read is a deterministic load, not louder prose.
 */
export function writeDocFrontmatter(fields: {
  title: string
  date: string
  kind: DocKind
  source?: string
}): string {
  const lines = [
    '---',
    `title: ${yamlScalar(fields.title)}`,
    `date: ${fields.date}`,
    `kind: ${fields.kind}`,
    ...(fields.source ? [`source: ${yamlScalar(fields.source)}`] : []),
    '---',
    '',
    '',
  ]
  return lines.join('\n')
}

/**
 * Set fields on an existing frontmatter block, leaving every other line and the whole body exactly as
 * they were. A known key is REPLACED in place rather than appended, so a block can be amended twice
 * without growing a second `description:` for a reader to pick between.
 *
 * This is what lets a document still be BORN by `createProjectFile` (the one creation path, with the
 * title/date/kind/source it derives) and then carry the one field only its author can supply. A caller
 * that instead wrote the whole block itself would be a second creation path, which is the thing the
 * substrate design exists to prevent.
 *
 * A file with no block gets one — unreachable for a just-born document, and better than silently
 * dropping the field it was asked to write.
 */
export function amendDocFrontmatter(raw: string, fields: { description?: string; kind?: DocKind }): string {
  const entries = Object.entries(fields).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '',
  )
  if (!entries.length) return raw
  const { block, body } = splitFrontmatter(raw)
  const lines = block ? block.split(/\r?\n/) : []
  for (const [key, value] of entries) {
    const line = `${key}: ${yamlScalar(value)}`
    const at = lines.findIndex((existing) => new RegExp(`^${key}\\s*:`, 'i').test(existing))
    if (at >= 0) lines[at] = line
    else lines.push(line)
  }
  return `---\n${lines.join('\n')}\n---\n${body}`
}

/** A local `YYYY-MM-DD` date. Local, not UTC: a document made at 9pm Central is dated today. */
export function docDateStamp(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Emit a string as YAML, quoting only when a bare scalar would change its meaning. A filename is
 *  user-supplied, so `My notes: draft.md` or `#2.md` must not produce a block another reader chokes
 *  on — including this module's own reader. */
function yamlScalar(value: string): string {
  const v = value.replace(/\s+/g, ' ').trim()
  const needsQuotes =
    !v ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(v) ||
    /: | #/.test(v) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(v) ||
    /^[+-]?[\d.]+$/.test(v)
  return needsQuotes ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v
}
