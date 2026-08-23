/**
 * The document rules every Koda surface has to agree on.
 *
 * This module is deliberately browser-safe: main, the desktop renderer, and the phone all import it.
 * Filesystem walking and YAML metadata parsing stay with their owners; filename eligibility and the
 * leading-frontmatter split are pure string contracts, so keeping copies beside each consumer only
 * gives one file three different meanings.
 */

import type { DocFormat, DocFormatCapabilities } from './ipc'

/** The authored prose formats the Library, Ask, and the kept-document shelf all recognize. */
const LIBRARY_DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.rst', '.org'])

/** True when a filename/path belongs to the Library document corpus. */
export function isLibraryDocumentPath(path: string): boolean {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot >= 0 && LIBRARY_DOCUMENT_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

/**
 * Extension → format. Admission and format are separate questions: `.mdx`, `.rst`, and `.org` stay in
 * the Library corpus above while resolving to `text` here, because being one of the user's documents
 * says nothing about which edit paths Koda can honor on the bytes.
 *
 * `.mdx` is deliberately NOT `markdown`. Its `import` lines and JSX elements are not CommonMark, so a
 * rich round-trip normalizes and escapes exactly the parts that make the file work; `markdown` would
 * claim a direct-edit and agent-apply path that silently corrupts. `text` withdraws only the rich
 * claim and keeps read plus plain direct edit, the same "err toward the smaller honest claim" posture
 * the Library takes with `.txt`. The repository already disagreed with itself here (the Stage's
 * markdown predicate includes `.mdx`, the Dock's excludes it), so there was no single behavior to
 * preserve.
 */
const DOC_FORMAT_BY_EXTENSION = new Map<string, DocFormat>([
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.html', 'html'],
  ['.htm', 'html'],
  ['.docx', 'docx'],
  ['.pdf', 'pdf'],
])

/**
 * The one place a path becomes a format. Total by design: anything unrecognized resolves to `text`,
 * the fallback file surface. That includes files that are not text at all — deciding "these bytes are
 * binary" needs the bytes, and the reader that has them already refuses to display them, so putting a
 * second extension taxonomy here would only be a copy that drifts.
 */
export function resolveDocFormat(path: string): DocFormat {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'text'
  return DOC_FORMAT_BY_EXTENSION.get(name.slice(dot).toLowerCase()) ?? 'text'
}

/**
 * Koda's document home, lowercased. Held as a literal here — the same choice `doc-frontmatter.ts`
 * already makes — so this browser-safe contract never imports main's filesystem module. `DOCS_HOME`
 * in `fs-browse.ts` is the same word, and the comparison is case-insensitive because the default
 * macOS volume is.
 */
const DOCUMENTS_HOME_SEGMENT = 'documents'

/** Does this project-relative path live inside the project's `Documents/` home? */
export function isUnderDocumentsHome(rel: string): boolean {
  const parts = rel.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.')
  return parts.length > 1 && parts[0].toLowerCase() === DOCUMENTS_HOME_SEGMENT
}

/**
 * Is this project-relative path one of the user's documents, as far as the Library is concerned?
 *
 * Two admission rules, deliberately unequal (typed-documents plan, Architecture §2 "Keep one Library
 * with deliberate admission"). Prose keeps the project-wide rule it has always had, unchanged. HTML is
 * admitted ONLY under `Documents/`, because `.html` is the most common non-document extension there
 * is: a project's build output, its email templates, its coverage reports and its vendored docs all
 * carry it, and a project-wide rule would bury the user's writing under machine output the first time
 * anyone ran a build. `Documents/` is the one folder whose contents the user put there on purpose, so
 * an `.html` file inside it is a deliberate artifact rather than a by-product.
 *
 * The format half comes from `resolveDocFormat`, not a second extension list, so "which formats may be
 * admitted" and "which surface opens this file" can never answer the same file differently.
 */
export function isLibraryAdmittedDocumentPath(rel: string): boolean {
  if (isLibraryDocumentPath(rel)) return true
  return resolveDocFormat(rel) === 'html' && isUnderDocumentsHome(rel)
}

/**
 * The product model's capability table, stated once.
 *
 * - `markdown` — the authoring default: every edit path, and the source of derived exports.
 * - `html` — a sandboxed viewer, not an editor. Koda has no rich HTML editing surface, so
 *   `canDirectEdit` is false; the agent's path is a whole-file rewrite with live refresh, which is a
 *   real apply handler. It is the only format whose own scripts run.
 * - `docx` — no direct edit at all. Word's model is not one Koda can partially write without lying
 *   about round-tripping, so the honest verbs are export and regenerate from a canonical source.
 * - `pdf` — read-only. A PDF is the end of an export chain, not the start of one, so `canExport` is
 *   false: edits go to the source that produced it.
 * - `text` — read and plain direct edit. No format-aware apply handler and no export pipeline exists
 *   for the fallback surface, which is exactly what makes it the fallback.
 */
const DOC_FORMAT_CAPABILITIES: Readonly<Record<DocFormat, DocFormatCapabilities>> = Object.freeze({
  markdown: Object.freeze({
    canRead: true,
    canSelect: true,
    canDirectEdit: true,
    canAgentApply: true,
    canExport: true,
    canRunScripts: false,
  }),
  html: Object.freeze({
    canRead: true,
    canSelect: true,
    canDirectEdit: false,
    canAgentApply: true,
    canExport: true,
    canRunScripts: true,
  }),
  docx: Object.freeze({
    canRead: true,
    canSelect: true,
    canDirectEdit: false,
    canAgentApply: false,
    canExport: true,
    canRunScripts: false,
  }),
  pdf: Object.freeze({
    canRead: true,
    canSelect: true,
    canDirectEdit: false,
    canAgentApply: false,
    canExport: false,
    canRunScripts: false,
  }),
  text: Object.freeze({
    canRead: true,
    canSelect: true,
    canDirectEdit: true,
    canAgentApply: false,
    canExport: false,
    canRunScripts: false,
  }),
})

/** What this format can honestly support. Static truth — a live surface still has to prove it. */
export function docFormatCapabilities(format: DocFormat): DocFormatCapabilities {
  return DOC_FORMAT_CAPABILITIES[format]
}

/** The keys written and understood by Koda's document metadata layer. */
export const KODA_DOCUMENT_FRONTMATTER_KEYS = new Set([
  'title',
  'description',
  'kind',
  'date',
  'source',
])

export type LeadingFrontmatterKind = 'none' | 'koda' | 'yaml' | 'prose'

export interface DocumentFrontmatterSplit {
  /** `koda` = Koda metadata, `yaml` = other authored YAML, `prose` = thematic-break passage. */
  kind: LeadingFrontmatterKind
  /** Text between candidate fences, even for a prose candidate. */
  block: string
  /** Exact leading bytes held outside a rich editor. Empty for `none` and `prose`. */
  frontmatter: string
  /** What the rich editor may edit. A prose candidate remains here byte-for-byte. */
  body: string
}

/** A leading `---\n…\n---` candidate, including its trailing newline for exact reconstruction. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * Split a document's leading fenced candidate without confusing a Markdown thematic-break passage
 * for hidden YAML. Koda metadata and other unambiguous YAML are held aside byte-for-byte; prose stays
 * in the editable body. A single capitalized natural-language key such as `Note: …` is intentionally
 * treated as prose because the syntax is ambiguous and hiding a person's words is the destructive
 * answer. Conventional lowercase YAML keys, multiple mappings, and structured mappings are YAML.
 */
export function splitDocumentFrontmatter(raw: string): DocumentFrontmatterSplit {
  const match = FRONTMATTER_RE.exec(raw)
  if (!match) return { kind: 'none', block: '', frontmatter: '', body: raw }

  const block = match[1]
  const fields = topLevelFrontmatterScalars(block)
  const keys = [...fields.keys()]
  const kind: LeadingFrontmatterKind = keys.some((key) => KODA_DOCUMENT_FRONTMATTER_KEYS.has(key))
    ? 'koda'
    : looksLikeOtherYaml(block, keys)
      ? 'yaml'
      : 'prose'

  if (kind === 'prose') return { kind, block, frontmatter: '', body: raw }
  return { kind, block, frontmatter: match[0], body: raw.slice(match[0].length) }
}

/** Top-level scalar key/value pairs, lowercased keys. Shared with main's metadata parser. */
export function topLevelFrontmatterScalars(block: string): Map<string, string> {
  const out = new Map<string, string>()
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.startsWith('#')) continue
    if (/^\s/.test(line)) continue
    const match = /^([A-Za-z_][\w-]*)\s*:\s?(.*)$/.exec(line)
    if (!match) continue
    let value = match[2]
    if (/^[|>][+-]?$/.test(value.trim())) {
      const parts: string[] = []
      while (i + 1 < lines.length && (!lines[i + 1].trim() || /^\s/.test(lines[i + 1]))) {
        i++
        parts.push(lines[i].trim())
      }
      value = parts.join(' ')
    }
    out.set(match[1].toLowerCase(), unquote(value))
  }
  return out
}

function looksLikeOtherYaml(block: string, keys: string[]): boolean {
  if (keys.length > 1) return true
  if (keys.length !== 1) return false
  const sourceKey = /^([A-Za-z_][\w-]*)\s*:/.exec(
    block.split(/\r?\n/).find((line) => !/^\s|^\s*(?:#|$)/.test(line)) ?? '',
  )?.[1]
  if (!sourceKey) return false
  if (sourceKey === sourceKey.toLowerCase()) return true
  // A structured value is unambiguously YAML even when its key happens to be capitalized.
  return block.split(/\r?\n/).some((line) => /^\s+(?:[-?]\s+|[A-Za-z_][\w-]*\s*:)/.test(line))
}

function unquote(value: string): string {
  const text = value.trim()
  if (text.length >= 2 && text[0] === '"' && text.endsWith('"'))
    return text.slice(1, -1).replace(/\\(["\\])/g, '$1')
  if (text.length >= 2 && text[0] === "'" && text.endsWith("'"))
    return text.slice(1, -1).replace(/''/g, "'")
  return text
}
