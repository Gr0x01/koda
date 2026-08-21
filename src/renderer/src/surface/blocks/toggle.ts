/*
 * Toggle block — a Notion-style collapsible, stored on disk as canonical markdown HTML passthrough:
 * `<details><summary>Title</summary>\n\nBody\n\n</details>`. Degrades gracefully (GitHub and most
 * renderers collapse native `<details>`).
 *
 * The crux: commonmark parses raw HTML as opaque, SEPARATE flow `html` nodes — the open
 * `<details><summary>…</summary>`, the body blocks, and the close `</details>` arrive as siblings,
 * NOT nested. So a remark transformer (runs on PARSE — Milkdown calls remark.runSync) GROUPS the
 * `[open … close]` sibling range (depth-aware for nesting) into one `details` mdast node; on serialize
 * the node schema writes those exact `html` markers back out, in order, as siblings — which is how
 * nesting is expressed in HTML passthrough anyway (linear open/close).
 *
 * The summary is a real child node (`details_summary`, plain text) — fully ProseMirror-managed, so
 * IME / undo / selection are native (no contenteditable side-channel). The NodeView does ONE thing:
 * a caret that toggles a presentation-only `data-open` class. Open/closed is NOT persisted (it's view
 * state, not content) — no sidecar, default open.
 */
import type { Ctx } from '@milkdown/kit/ctx'
import type { NodeViewConstructor } from '@milkdown/kit/prose/view'
import type { Root } from 'mdast'
import {
  $nodeSchema,
  $remark,
  $view,
  addBlockTypeCommand,
  clearTextInCurrentBlockCommand,
  commandsCtx,
  editorViewCtx,
  selectTextNearPosCommand,
} from '../milkdown-runtime'

/** A single opaque `html` flow node opening a toggle, optionally carrying the inline `<summary>`. */
const OPEN = /^<details(?:\s[^>]*)?>\s*(?:<summary>([\s\S]*?)<\/summary>)?\s*$/i
const CLOSE = /^<\/details>\s*$/i

/** Loosely-typed mdast node — we add a non-standard `details` type the rest of mdast doesn't know. */
interface MdNode {
  type: string
  value?: string
  summary?: string
  children?: MdNode[]
}

const isOpen = (n: MdNode): boolean => n.type === 'html' && OPEN.test((n.value ?? '').trim())
const isClose = (n: MdNode): boolean => n.type === 'html' && CLOSE.test((n.value ?? '').trim())

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unescapeHtml = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * Rebuild a parent's children, folding each `[<details…> … </details>]` run into one `details` node.
 * Depth-aware so nested toggles group correctly; an unmatched open is left as raw HTML (fail-soft).
 */
function groupDetails(parent: MdNode): void {
  const children = parent.children
  if (!children) return
  const out: MdNode[] = []
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (isOpen(node)) {
      let depth = 1
      let j = i + 1
      for (; j < children.length; j++) {
        if (isOpen(children[j])) depth++
        else if (isClose(children[j])) {
          depth--
          if (depth === 0) break
        }
      }
      if (j < children.length) {
        const summary = (OPEN.exec((node.value ?? '').trim())?.[1] ?? '').trim()
        const det: MdNode = { type: 'details', summary, children: children.slice(i + 1, j) }
        groupDetails(det)
        out.push(det)
        i = j
        continue
      }
      // No matching close → leave the raw html node untouched.
    }
    if (node.children) groupDetails(node)
    out.push(node)
  }
  parent.children = out
}

/** PARSE transformer: group `<details>` html-node runs into `details` mdast nodes. */
export const toggleRemark = $remark(
  'kodaToggle',
  () => () => (tree: Root) => groupDetails(tree as unknown as MdNode),
)

/** The toggle title: a single line of plain text (no marks — it lives inside a raw `<summary>`). */
export const detailsSummarySchema = $nodeSchema('details_summary', () => ({
  content: 'text*',
  marks: '',
  defining: true,
  parseDOM: [{ tag: 'div[data-toggle-summary]' }],
  toDOM: () => ['div', { 'data-toggle-summary': '', class: 'koda-toggle-summary' }, 0],
  // Never parsed/serialized directly — the parent `details` builds and reads it.
  parseMarkdown: { match: () => false, runner: () => {} },
  toMarkdown: { match: () => false, runner: () => {} },
}))

/** The toggle container: summary first, then a collapsible body. */
export const detailsSchema = $nodeSchema('details', (ctx) => ({
  content: 'details_summary block+',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'div[data-toggle]' }],
  toDOM: () => ['div', { 'data-toggle': '', class: 'koda-toggle' }, 0],
  parseMarkdown: {
    match: ({ type }) => type === 'details',
    runner: (state, node, type) => {
      state.openNode(type)
      state.openNode(detailsSummarySchema.type(ctx))
      const title = unescapeHtml(String(node.summary ?? '')).trim()
      if (title) state.addText(title)
      state.closeNode()
      state.next(node.children ?? [])
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'details',
    runner: (state, node) => {
      const title = node.firstChild ? node.firstChild.textContent : ''
      // Markers as raw `html` nodes (remark-stringify emits them verbatim, no escaping); the body
      // blocks serialize as normal siblings between them — the same linear form we parsed.
      state.addNode('html', undefined, `<details><summary>${escapeHtml(title)}</summary>`)
      node.forEach((child, _offset, index) => {
        if (index === 0) return // skip the summary
        state.next(child)
      })
      state.addNode('html', undefined, '</details>')
    },
  },
}))

const caretIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'

/** Slash-menu icon (lucide `chevron-right`). */
export const toggleIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'

/**
 * NodeView: presentation-only. The summary + body are ProseMirror content (in `contentDOM`); the
 * caret is a non-editable sibling that flips a `data-open` class. No transactions, no IME surface.
 */
export const detailsView = $view(
  detailsSchema.node,
  (): NodeViewConstructor =>
    () => {
      const dom = document.createElement('div')
      dom.className = 'koda-toggle'
      dom.setAttribute('data-toggle', '')
      dom.setAttribute('data-open', 'true')

      const caret = document.createElement('button')
      caret.type = 'button'
      caret.className = 'koda-toggle-caret'
      caret.contentEditable = 'false'
      caret.setAttribute('aria-label', 'Collapse toggle')
      caret.setAttribute('aria-expanded', 'true')
      caret.innerHTML = caretIcon

      const body = document.createElement('div')
      body.className = 'koda-toggle-body'

      caret.addEventListener('mousedown', (e) => e.preventDefault())
      caret.addEventListener('click', (e) => {
        e.preventDefault()
        const open = dom.getAttribute('data-open') !== 'true'
        dom.setAttribute('data-open', String(open))
        caret.setAttribute('aria-expanded', String(open))
      })

      dom.append(caret, body)
      return {
        dom,
        contentDOM: body,
        ignoreMutation: (m) => caret === m.target || caret.contains(m.target as Node),
        stopEvent: (e) => e.target instanceof Node && caret.contains(e.target),
      }
    },
)

/** Insert an (empty) toggle from the slash menu and drop the caret into its summary. */
export function runInsertToggle(ctx: Ctx): void {
  const commands = ctx.get(commandsCtx)
  const { from } = ctx.get(editorViewCtx).state.selection
  commands.call(clearTextInCurrentBlockCommand.key)
  commands.call(addBlockTypeCommand.key, { nodeType: detailsSchema.type(ctx) })
  commands.call(selectTextNearPosCommand.key, { pos: from })
}
