import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  escapeHtml,
  htmlPlainText,
  parseHtmlDocumentMetadata,
  readHtmlDocumentMetadata,
  renderKodaHtmlDocument,
} from './html-document'

/**
 * HTML is the first format Koda admits that can fight back. A markdown file is inert; an `.html` file
 * is a program, and the two fixtures below are the two shapes it comes in — one a well-behaved report,
 * one written specifically to attack whatever opens it.
 *
 * So these pin two different promises. That a real artifact yields a real Library row (its own title,
 * its authored description, and an excerpt of its PROSE rather than of its stylesheet). And that a
 * hostile or broken one degrades to a safe row instead of leaking source code into the Library or
 * failing the listing it appears in.
 */

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../e2e/fixtures/documents/${name}`, import.meta.url))

const INTERACTIVE = fixture('interactive-report.html')
const HOSTILE = fixture('hostile.html')

describe('reading a real interactive artifact', () => {
  it('takes its name from <title> and its excerpt from the prose, not the stylesheet', async () => {
    const { fm, excerpt } = await readHtmlDocumentMetadata(INTERACTIVE)

    expect(fm.title).toBe('Frost date explorer')
    // The head of this file is ~4 KB of inline CSS before the first sentence. An excerpt that started
    // at byte 0, or that stopped at doc-frontmatter's 8 KB, would be a preview of `--accent: #2f5fd0`.
    expect(excerpt).toBeTruthy()
    expect(excerpt).not.toContain('--accent')
    expect(excerpt).not.toContain('box-sizing')
    expect(excerpt).not.toContain('function')
    expect(excerpt).not.toContain('<')
  })

  it('never previews the provenance comment a generated artifact opens with', async () => {
    const { excerpt } = await readHtmlDocumentMetadata(INTERACTIVE)

    expect(excerpt).not.toContain('Koda test fixture')
  })
})

describe('a hostile artifact degrades to a safe row', () => {
  it('reads its title and prose without running, resolving, or quoting anything it tried', async () => {
    const { fm, excerpt } = await readHtmlDocumentMetadata(HOSTILE)

    expect(fm.title).toBe('Hostile artifact (security fixture)')
    // Its <script> is the bulk of the file and is where every probe lives. None of it is prose.
    expect(excerpt).not.toContain('invalid.example')
    expect(excerpt).not.toContain('__kodaHostileResults')
    expect(excerpt).not.toContain('ipcRenderer')
    expect(excerpt).not.toContain('require')
    // What it SHOULD read as: the one visible heading.
    expect(excerpt).toContain('every row below must read')
  })

  it('reports no Koda metadata for a file that never authored any', async () => {
    const { fm } = await readHtmlDocumentMetadata(HOSTILE)

    expect(fm.description).toBeUndefined()
    expect(fm.kind).toBeUndefined()
    expect(fm.date).toBeUndefined()
    expect(fm.source).toBeUndefined()
  })

  /**
   * The scan is byte-bounded, so a big artifact is always read mid-file. If a cut lands inside a
   * `<script>` or a comment, the paired-tag regex stops matching and the tail — source code, or a
   * banner nobody sees — becomes the excerpt. Both fixtures are small enough to be read whole, so this
   * proves the truncation guards directly on the shapes that would leak.
   */
  it('never leaks the tail of an unterminated script, style, or comment', () => {
    const source = readFileSync(HOSTILE, 'utf8')
    const cutInsideScript = source.slice(0, source.indexOf('__kodaHostileResults') + 40)

    const text = htmlPlainText(cutInsideScript, 600)

    expect(text).not.toContain('__kodaHostileResults')
    expect(htmlPlainText('<p>seen</p><!-- unterminated banner', 600)).toBe('seen')
    expect(htmlPlainText('<p>seen</p><style>body { color: red', 600)).toBe('seen')
  })
})

describe('what the extractor refuses to be confused by', () => {
  it('falls back to the first <h1> when there is no usable <title>', () => {
    expect(parseHtmlDocumentMetadata('<html><head></head><body><h1>Q3 spend</h1></body></html>').title).toBe(
      'Q3 spend',
    )
    expect(parseHtmlDocumentMetadata('<head><title>   </title></head><h1>Fallback</h1>').title).toBe('Fallback')
  })

  it('reads Koda meta tags in either attribute order and either quoting style', () => {
    const fm = parseHtmlDocumentMetadata(
      `<head><title>T</title>
       <meta content='A comparison of three routes' name="koda:description">
       <meta name=koda:kind content=research>
       <meta name="koda:date" content="2026-08-20" />
       <meta name="koda:source" content="3c48313e" /></head>`,
    )

    expect(fm).toEqual({
      title: 'T',
      description: 'A comparison of three routes',
      kind: 'research',
      date: '2026-08-20',
      source: '3c48313e',
    })
  })

  it('ignores a koda: meta written into the body, and an unrecognized kind', () => {
    // The head window is the boundary: a page that carries `<meta name="koda:kind">` in its body is
    // either a template or something dressing itself up as a Koda document.
    const smuggled = parseHtmlDocumentMetadata(
      '<head><title>T</title></head><body><meta name="koda:kind" content="plan"></body>',
    )
    expect(smuggled.kind).toBeUndefined()

    expect(parseHtmlDocumentMetadata('<head><title>T</title><meta name="koda:kind" content="memo"></head>').kind)
      .toBeUndefined()
  })

  it('gives up on a malformed file instead of inventing fields', () => {
    expect(parseHtmlDocumentMetadata('')).toEqual({
      title: undefined,
      description: undefined,
      kind: undefined,
      date: undefined,
      source: undefined,
    })
    expect(parseHtmlDocumentMetadata('<html><head><title>Never closed').title).toBeUndefined()
    // An entity outside the small guaranteed set stays exactly as written. The alternative is a
    // 2,000-entry table maintained here so a Library row can say "café" instead of "caf&eacute;".
    expect(htmlPlainText('<p>&notarealentity; plain</p>', 600)).toBe('&notarealentity; plain')
    // Unbalanced angle brackets degrade to something harmless rather than throwing or leaking markup.
    expect(htmlPlainText('<<<>>> text', 600)).not.toContain('<')
  })

  it('answers empty metadata rather than throwing for a file that is not there', async () => {
    expect(await readHtmlDocumentMetadata(fixture('nothing-here.html'))).toEqual({ fm: {} })
  })

  it('separates adjacent cells instead of running them together', () => {
    expect(htmlPlainText('<table><tr><td>Mar 12</td><td>Apr 2</td></tr></table>', 600)).toBe('Mar 12 Apr 2')
  })

  it('decodes the entities a document actually uses', () => {
    expect(htmlPlainText('<p>Tom &amp; Jerry &#8212; 5 &lt; 6&nbsp;m&#x00B2;</p>', 600)).toBe(
      'Tom & Jerry — 5 < 6 m²',
    )
  })
})

describe('the document a Koda-created artifact is born as', () => {
  it('round-trips its authored facts through Koda’s own reader', () => {
    const html = renderKodaHtmlDocument({
      title: 'Frost & thaw "explorer"',
      kind: 'research',
      date: '2026-08-20',
      description: 'Which planting window survives a late freeze <in three counties>.',
      source: 'session-9',
      body: '<p>Body content.</p>',
    })

    // The whole point of writing metadata into the file: the reader that lists the Library has to get
    // the same facts back out, including the ones that need escaping to survive the trip.
    expect(parseHtmlDocumentMetadata(html)).toEqual({
      title: 'Frost & thaw "explorer"',
      kind: 'research',
      date: '2026-08-20',
      description: 'Which planting window survives a late freeze <in three counties>.',
      source: 'session-9',
    })
    expect(htmlPlainText(html, 600)).toContain('Body content.')
  })

  it('is self-contained: no external font, stylesheet, script, or request', () => {
    const html = renderKodaHtmlDocument({ title: 'T', kind: 'note', date: '2026-08-20' })

    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/<script\b/i)
    expect(html.trimStart().startsWith('<!doctype html>')).toBe(true)
  })

  it('unwraps a whole document the caller pasted into the body', () => {
    const html = renderKodaHtmlDocument({
      title: 'Wrapped',
      kind: 'note',
      date: '2026-08-20',
      body: '<!doctype html><html><head><title>Theirs</title></head><body><p>Just this.</p></body></html>',
    })

    // Koda writes the head. A second doctype/head pasted through would leave a file with two of each,
    // which browsers paper over and every later reader of the bytes trips on.
    expect(html.match(/<!doctype/gi)).toHaveLength(1)
    expect(html.match(/<title\b/gi)).toHaveLength(1)
    expect(parseHtmlDocumentMetadata(html).title).toBe('Wrapped')
    expect(html).toContain('<p>Just this.</p>')
  })

  it('cannot have its leading comment closed early by the text inside it', () => {
    const html = renderKodaHtmlDocument({
      title: 'T',
      kind: 'note',
      date: '2026-08-20',
      leadingComment: 'koda:source-document Documents/a--> <script>alert(1)</script>.md',
    })

    // A comment cannot be escaped, only made unable to close early. `-->` inside it is the one
    // sequence that would end it and let the rest of the source path become live markup, so the
    // document must carry exactly one comment terminator — the one Koda wrote.
    expect(html.match(/-->/g)).toHaveLength(1)
    // Everything after that terminator is Koda's own markup, with nothing of the caller's in it.
    expect(html.slice(html.indexOf('-->') + 3)).not.toMatch(/<script\b/i)
  })

  it('escapes text and attribute values', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })
})
