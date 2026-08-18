/**
 * The document rules every Koda surface has to agree on.
 *
 * This module is deliberately browser-safe: main, the desktop renderer, and the phone all import it.
 * Filesystem walking and YAML metadata parsing stay with their owners; filename eligibility and the
 * leading-frontmatter split are pure string contracts, so keeping copies beside each consumer only
 * gives one file three different meanings.
 */

/** The authored prose formats the Library, Ask, and the kept-document shelf all recognize. */
const LIBRARY_DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.rst', '.org'])

/** True when a filename/path belongs to the Library document corpus. */
export function isLibraryDocumentPath(path: string): boolean {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot >= 0 && LIBRARY_DOCUMENT_EXTENSIONS.has(name.slice(dot).toLowerCase())
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
