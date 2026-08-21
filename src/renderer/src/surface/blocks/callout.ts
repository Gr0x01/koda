/*
 * Callout block — a Notion-style tinted aside that stays canonical markdown on disk as a
 * GitHub-alert blockquote: `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`.
 * It's just a marked blockquote, so it degrades gracefully in every other markdown renderer.
 *
 * remark-gfm does NOT parse these into a distinct node, so we add our own pieces:
 *  - a remark transformer (runs on PARSE only — Milkdown's parser calls remark.runSync) that detects a
 *    blockquote whose first paragraph starts with `[!TYPE]` and retypes it to a `callout` mdast node;
 *  - a $nodeSchema whose toMarkdown writes the callout back out as exactly that blockquote form.
 *
 * Serialize note: the marker is emitted as an mdast `html` node, not a `text` node. remark-stringify
 * escapes `[` in text (`> \[!NOTE]`, which breaks the alert), but emits `html` verbatim. On reparse
 * `[!NOTE]` is plain text again (it isn't valid HTML), so the transformer re-matches it — stable.
 */
import type { Ctx } from '@milkdown/kit/ctx'
import type { Blockquote, Paragraph, Root, Text } from 'mdast'
import {
  $inputRule,
  $nodeSchema,
  $remark,
  commandsCtx,
  clearTextInCurrentBlockCommand,
  wrappingInputRule,
  wrapInBlockTypeCommand,
} from '../milkdown-runtime'
import { visit } from 'unist-util-visit'

export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

const KINDS: readonly CalloutKind[] = ['note', 'tip', 'important', 'warning', 'caution']
const DEFAULT_KIND: CalloutKind = 'note'

/** `[!NOTE]` (case-insensitive) at the very start of the first paragraph's text. */
const MARKER = /^\[!(\w+)\]/

function toKind(raw: string): CalloutKind | null {
  const k = raw.toLowerCase()
  return (KINDS as readonly string[]).includes(k) ? (k as CalloutKind) : null
}

/**
 * PARSE transformer: a blockquote whose first paragraph opens with a known `[!TYPE]` becomes a
 * `callout` mdast node carrying `kind`, with the marker stripped from the body. Unknown `[!XYZ]`
 * is left untouched → renders as a plain blockquote (fail-soft, never throws).
 */
export const calloutRemark = $remark('kodaCallout', () => () => (tree: Root) => {
  visit(tree, 'blockquote', (node: Blockquote) => {
    const firstBlock = node.children[0]
    if (!firstBlock || firstBlock.type !== 'paragraph') return
    const firstInline = (firstBlock as Paragraph).children[0]
    if (!firstInline || firstInline.type !== 'text') return

    const match = MARKER.exec((firstInline as Text).value)
    if (!match) return
    const kind = toKind(match[1])
    if (!kind) return

    // Drop the marker (and the single line break / spaces that follow it on the marker line).
    const rest = (firstInline as Text).value.slice(match[0].length).replace(/^[ \t]*(\r?\n)?/, '')
    if (rest.length > 0) {
      ;(firstInline as Text).value = rest
    } else {
      ;(firstBlock as Paragraph).children.shift()
      if ((firstBlock as Paragraph).children.length === 0) node.children.shift()
    }
    // Container needs ≥1 block (content is `block+`); a marker-only callout gets an empty paragraph.
    if (node.children.length === 0) {
      node.children.push({ type: 'paragraph', children: [] } as Paragraph)
    }

    const callout = node as unknown as { type: string; kind: CalloutKind }
    callout.type = 'callout'
    callout.kind = kind
  })
})

/** The callout node: a block container that round-trips to/from the alert blockquote. */
export const calloutSchema = $nodeSchema('callout', () => ({
  content: 'block+',
  group: 'block',
  defining: true,
  attrs: { kind: { default: DEFAULT_KIND, validate: 'string' } },
  parseDOM: [
    {
      tag: 'div[data-callout]',
      getAttrs: (dom) => ({
        kind: toKind((dom as HTMLElement).dataset.calloutKind ?? '') ?? DEFAULT_KIND,
      }),
    },
  ],
  toDOM: (node) => [
    'div',
    { 'data-callout': '', 'data-callout-kind': node.attrs.kind as string, class: 'koda-callout' },
    0,
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'callout',
    runner: (state, node, type) => {
      const kind = toKind(String(node.kind ?? '')) ?? DEFAULT_KIND
      state.openNode(type, { kind })
      state.next(node.children ?? [])
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'callout',
    runner: (state, node) => {
      const kind = toKind(String(node.attrs.kind ?? '')) ?? DEFAULT_KIND
      state.openNode('blockquote')
      // Marker as an `html` node so remark-stringify emits `[!NOTE]` raw (text would escape the `[`).
      state.addNode('html', undefined, `[!${kind.toUpperCase()}]`)
      state.next(node.content)
      state.closeNode()
    },
  },
}))

/** Typing `[!note] ` (any known kind) at the start of a paragraph wraps it in a callout. */
export const calloutInputRule = $inputRule((ctx) =>
  wrappingInputRule(
    /^\[!(note|tip|important|warning|caution)\]\s$/i,
    calloutSchema.type(ctx),
    (match) => ({ kind: toKind(match[1]) ?? DEFAULT_KIND }),
  ),
)

/** Slash-menu icon (lucide `info`). CSS colours it via `currentColor`. */
export const calloutIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>'

/** Insert a callout from the slash menu: clear the `/query` text, then wrap the block (mirrors the
 *  built-in blockquote item). */
export function runInsertCallout(ctx: Ctx, kind: CalloutKind = DEFAULT_KIND): void {
  const commands = ctx.get(commandsCtx)
  commands.call(clearTextInCurrentBlockCommand.key)
  commands.call(wrapInBlockTypeCommand.key, {
    nodeType: calloutSchema.type(ctx),
    attrs: { kind },
  })
}
