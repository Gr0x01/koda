/**
 * The HTML document substrate: reading a self-contained `.html` artifact's authored metadata and a
 * safe plain-text excerpt off disk, and rendering the document a Koda-created HTML artifact is born as.
 *
 * Sibling to `doc-frontmatter.ts`, which does the same two jobs for markdown, and it keeps that
 * module's two rules for the same reasons:
 *
 *   • NOTHING here throws. A truncated, malformed, or deliberately hostile file degrades every field
 *     to undefined and the excerpt to empty. One unreadable artifact must never blank the Library —
 *     and an `.html` file is far likelier to be hostile than a `.md` one, because the format's whole
 *     point is that it carries executable content.
 *   • Reads are PARTIAL and byte-bounded. The Library walk enriches up to 300 rows per listing; a
 *     format that can legitimately be a megabyte of inlined base64 must not be read whole to answer
 *     "what is this called".
 *
 * Nothing in this module parses HTML as a document tree, and that is deliberate rather than lazy. A
 * real parser would have to decide what to do with a fixture like `e2e/fixtures/documents/hostile.html`,
 * whose entire purpose is to attack whatever opens it; string extraction has no DOM to attack, executes
 * nothing, resolves nothing, and fetches nothing. The cost is that exotic markup extracts imperfectly,
 * which shows up as a slightly worse Library row — the correct place to lose.
 *
 * Where the metadata lives is the same argument frontmatter won for markdown (see
 * `Documents/architecture/document-workspace.md`): in the file, so it survives a rename or a move,
 * rather than in the path-hashed `.koda/docmeta` sidecar that dies on both. HTML's native shape for
 * that is `<title>` plus `<meta name="koda:*">`.
 */
import { open } from 'node:fs/promises'
import { DocKindSchema, type DocKind } from '@shared/ipc'
import { readContainedRegularFile } from './contained-read'

/** The same four authored fields markdown carries, plus the birth `date` HTML can hold natively.
 *  Every one optional and every one stays optional: an artifact the user wrote by hand, or one that
 *  arrived from somewhere else, has a `<title>` at best. */
export interface HtmlDocumentMetadata {
  title?: string
  description?: string
  kind?: DocKind
  /** `YYYY-MM-DD`, written at birth. Carried for parity with markdown's `date:`; no surface reads it
   *  back yet, and markdown's is not read back either — both exist so the file states its own age. */
  date?: string
  /** The id of the session that created this artifact — the same provenance markdown's `source:` holds. */
  source?: string
}

/** The `<meta name="…">` names Koda writes and understands. Namespaced so they cannot collide with
 *  the ordinary `description`/`author`/`viewport` metas a hand-written page already has, and so a
 *  reader can tell "Koda wrote this fact" from "the page happened to say something similar". */
const KODA_META_PREFIX = 'koda:'

/** How much of a file one metadata/excerpt read touches. Generous next to `doc-frontmatter`'s 8 KB
 *  head read because HTML pays for its own markup: a page with 4 KB of inline CSS in its head has not
 *  reached its first sentence yet, and an excerpt taken from the first 8 KB would be empty for most
 *  real documents. Still a fixed ceiling, so a 5 MB artifact costs the same as a 60 KB one. */
const HTML_SCAN_BYTES = 65_536

/** The fallback metadata window when a file has no `</head>` inside the scan — `doc-frontmatter`'s
 *  8 KB convention, applied to the one place it holds for HTML: a `<title>` lives in the head, and a
 *  head that has not closed after 8 KB is not going to yield document metadata worth trusting. */
const HTML_HEAD_BYTES = 8_192

/**
 * Read one HTML artifact's head: its authored metadata plus the first `excerptChars` of visible text.
 *
 * The shape mirrors `readDocMetadata` exactly so the Library walk can pick a reader by format and
 * consume the result identically. Fail-soft in every direction — an unreadable, vanished, binary, or
 * hostile file comes back as empty metadata, never as an error the listing has to survive.
 */
export async function readHtmlDocumentMetadata(
  file: string,
  excerptChars = 600,
  root?: string,
): Promise<{ fm: HtmlDocumentMetadata; excerpt?: string }> {
  // ×8 rather than markdown's ×4: tags, attributes and entities all sit between the reader and the
  // text, so a given number of visible characters costs materially more bytes here.
  const bytes = Math.max(HTML_SCAN_BYTES, excerptChars * 8 + HTML_HEAD_BYTES)
  let scan: string
  try {
    if (root) {
      scan = (await readContainedRegularFile(root, file, bytes)).bytes.toString('utf8')
    } else {
      const fh = await open(file, 'r')
      try {
        const buf = Buffer.alloc(bytes)
        const { bytesRead } = await fh.read(buf, 0, bytes, 0)
        scan = buf.subarray(0, bytesRead).toString('utf8')
      } finally {
        await fh.close()
      }
    }
  } catch {
    return { fm: {} }
  }
  try {
    const fm = parseHtmlDocumentMetadata(scan)
    const excerpt = htmlPlainText(scan, excerptChars)
    return { fm, excerpt: excerpt || undefined }
  } catch {
    // Structurally unreachable — everything below is bounded string work — and the guarantee that one
    // artifact cannot blank the Library is worth more than the branch.
    return { fm: {} }
  }
}

/**
 * Pull Koda's authored facts out of a scanned prefix of an HTML file.
 *
 * `<title>` is the primary name and `<h1>` is the fallback, in that order, because a generated page
 * routinely carries a generic `<title>` and a specific heading but almost never the reverse. Both are
 * read as text: markup inside them is stripped rather than rendered, so a `<title>` carrying a stray
 * `<span>` reads as words instead of as tags.
 */
export function parseHtmlDocumentMetadata(scan: string): HtmlDocumentMetadata {
  const head = metadataWindow(scan)
  const meta = kodaMetaTags(head)
  const kind = DocKindSchema.safeParse(meta.get('kind')?.toLowerCase())
  return {
    title: nonEmpty(titleFrom(scan, head)),
    description: nonEmpty(meta.get('description')),
    kind: kind.success ? kind.data : undefined,
    date: nonEmpty(meta.get('date')),
    source: nonEmpty(meta.get('source')),
  }
}

/**
 * The visible text of an HTML document, tags stripped and the invisible subtrees excluded, clipped to
 * `maxChars`.
 *
 * What is excluded is the whole point. Comments come out first because a generated artifact often
 * opens with a block of provenance the reader never sees — and because both of this repository's HTML
 * fixtures do. `<script>` and `<style>` are dropped whole, so a Library row can never preview a page's
 * CSS variables or its JavaScript. `<head>` goes with them: its `<title>` is already the row's name,
 * and repeating it as the excerpt says nothing twice.
 */
export function htmlPlainText(html: string, maxChars: number): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, ' ')
  // A comment left open by the scan's byte ceiling would otherwise dump the rest of the window into
  // the excerpt, which for a file that opens with a long provenance banner is the whole excerpt.
  text = text.replace(/<!--[\s\S]*$/, ' ')
  for (const tag of ['script', 'style', 'head', 'noscript', 'template', 'svg']) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ')
    // Same hazard as the comment above: the scan can end mid-block, and the tail of an unterminated
    // <script> is source code, not prose.
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'i'), ' ')
  }
  // Tags become a SPACE, never nothing: `<td>Mar 12</td><td>Apr 2</td>` is two cells, and joining them
  // into one word is how a table's excerpt turns into gibberish.
  text = text.replace(/<[^>]*>/g, ' ').replace(/<[^>]*$/, ' ')
  text = decodeEntities(text)
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= maxChars ? collapsed : collapsed.slice(0, maxChars)
}

/** What a Koda-created HTML document is born carrying. `body` is the artifact's own markup, which the
 *  agent authors; everything else is the metadata block Koda writes, exactly as it does for markdown. */
export interface HtmlDocumentFields {
  title: string
  kind: DocKind
  date: string
  description?: string
  source?: string
  /** Raw HTML for the document's body. Absent ⇒ a bare starter page. */
  body?: string
  /** Emitted as an HTML comment immediately inside `<body>`, before the body markup. */
  leadingComment?: string
}

/**
 * Render a complete, self-contained HTML document.
 *
 * Self-contained is a security contract, not a style preference (typed-documents plan, Architecture
 * §4): the sandbox that opens these files allows no external network resources, so a document born
 * with a linked font or stylesheet would render wrong in the only surface that will ever show it. Every
 * style here is inline, and the sheet is deliberately small — enough that an artifact reads as a
 * document rather than as raw markup, and not so much that it fights whatever the agent writes.
 */
export function renderKodaHtmlDocument(fields: HtmlDocumentFields): string {
  const metas = [
    ['kind', fields.kind],
    ['date', fields.date],
    ['description', fields.description],
    ['source', fields.source],
  ]
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
    .map(([name, value]) => `    <meta name="${KODA_META_PREFIX}${name}" content="${escapeHtml(value)}" />`)
  const body = unwrapDocumentBody(fields.body ?? '').trim()
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `    <title>${escapeHtml(fields.title)}</title>`,
    ...metas,
    '    <style>',
    HTML_DOCUMENT_STYLE,
    '    </style>',
    '  </head>',
    '  <body>',
    ...(fields.leadingComment ? [`    <!-- ${escapeHtmlComment(fields.leadingComment)} -->`] : []),
    `    <h1>${escapeHtml(fields.title)}</h1>`,
    ...(fields.description ? [`    <p class="lede">${escapeHtml(fields.description)}</p>`] : []),
    ...(body ? [body] : []),
    '  </body>',
    '</html>',
    '',
  ].join('\n')
}

/** Escape text for an HTML text node or a double-quoted attribute value. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A comment cannot be escaped, only made unable to close early — `--` is the one sequence that ends
 *  one, so it is neutralized rather than encoded. */
function escapeHtmlComment(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/--+/g, '-').trim()
}

/**
 * Take an agent-supplied body that is already a whole document down to its body markup.
 *
 * The same shape of defense `keep-document.ts` applies to a stray frontmatter block: Koda writes the
 * document's head, so a second `<!doctype>` and `<html>` pasted into the body produce a file with two
 * of each, which browsers silently paper over and every later reader of the file trips on.
 */
function unwrapDocumentBody(raw: string): string {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(raw)
  if (body) return body[1]
  if (!/^\s*(?:<!doctype\b|<html\b)/i.test(raw)) return raw
  return raw
    .replace(/^\s*<!doctype\b[^>]*>/i, '')
    .replace(/<\/?html\b[^>]*>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')
}

/** A modest inline sheet. Matches Koda's ink-blue-on-warm-paper posture, honours the OS colour scheme,
 *  and uses only system font stacks — a webfont would be an external resource the sandbox blocks. */
const HTML_DOCUMENT_STYLE = `      :root { color-scheme: light dark; --ink: #131a24; --muted: #5d6b7f; --line: #dfe4ec; --accent: #2f5fd0; }
      @media (prefers-color-scheme: dark) {
        :root { --ink: #e7ecf5; --muted: #93a1b6; --line: #2a3444; --accent: #7ba1ff; }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0 auto;
        padding: 40px 28px 64px;
        max-width: 760px;
        font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        color: var(--ink);
      }
      h1 { font-size: 24px; margin: 0 0 6px; letter-spacing: -0.01em; }
      h2 { font-size: 18px; margin: 32px 0 8px; }
      p.lede { margin: 0 0 28px; color: var(--muted); }
      a { color: var(--accent); }
      table { width: 100%; border-collapse: collapse; margin: 12px 0; }
      th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
      th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
      pre { white-space: pre-wrap; word-wrap: break-word; background: color-mix(in srgb, var(--line) 40%, transparent); padding: 14px 16px; border-radius: 8px; }
      code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
      .koda-seed { border-left: 3px solid var(--line); padding-left: 16px; margin: 24px 0; }`

/**
 * The slice of the file Koda's `<meta>` facts may come from. `</head>` when the scan reached it —
 * which is the honest boundary, and survives a head carrying kilobytes of inline CSS — else the 8 KB
 * convention. Bounding this at all is what stops a `<meta name="koda:kind">` written into the body of
 * a page (by a template, or by something trying to dress itself up as a Koda document) from counting.
 */
function metadataWindow(scan: string): string {
  const end = scan.search(/<\/head\s*>/i)
  return end >= 0 ? scan.slice(0, end) : scan.slice(0, HTML_HEAD_BYTES)
}

/** Every `<meta name="koda:x" content="y">` in the head, as `x → y`. Attributes are read in either
 *  order and in either quoting style, because this reads files Koda did not necessarily write. */
function kodaMetaTags(head: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = readAttributes(tag)
    const name = attrs.get('name')?.toLowerCase()
    if (!name || !name.startsWith(KODA_META_PREFIX)) continue
    const content = attrs.get('content')
    if (content === undefined) continue
    const key = name.slice(KODA_META_PREFIX.length)
    if (!out.has(key)) out.set(key, decodeEntities(content).trim())
  }
  return out
}

const ATTRIBUTE_RE = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+))/g

function readAttributes(tag: string): Map<string, string> {
  const out = new Map<string, string>()
  ATTRIBUTE_RE.lastIndex = 0
  for (let m = ATTRIBUTE_RE.exec(tag); m; m = ATTRIBUTE_RE.exec(tag)) {
    const key = m[1].toLowerCase()
    if (!out.has(key)) out.set(key, m[2] ?? m[3] ?? m[4] ?? '')
  }
  return out
}

/** `<title>` first, then the first `<h1>` anywhere in the scan. The title is searched in the head
 *  window so a `<title>` inside an inlined SVG in the body cannot outrank the document's own. */
function titleFrom(scan: string, head: string): string | undefined {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1]
  const text = title === undefined ? undefined : tagStrippedText(title)
  if (text) return text
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(scan)?.[1]
  return h1 === undefined ? undefined : tagStrippedText(h1) || undefined
}

function tagStrippedText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/**
 * The five named entities the spec guarantees plus `&nbsp;` and numeric references. Deliberately not a
 * full entity table: an unrecognized `&foo;` stays as written, which reads as slightly wrong text in a
 * preview and is the right failure — the alternative is a 2,000-entry table maintained here so a
 * Library row can say "café" instead of "caf&eacute;".
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase()
    if (key === 'amp') return '&'
    if (key === 'lt') return '<'
    if (key === 'gt') return '>'
    if (key === 'quot') return '"'
    if (key === 'apos' || key === '#39') return "'"
    if (key === 'nbsp') return ' '
    if (key.startsWith('#')) {
      const code = key.startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10)
      // Surrogates and out-of-range values are not characters; leaving the reference as written beats
      // emitting a replacement glyph into the user's Library row.
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff))
        return String.fromCodePoint(code)
    }
    return whole
  })
}

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v ? v : undefined
}
