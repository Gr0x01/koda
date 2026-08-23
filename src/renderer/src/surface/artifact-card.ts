/**
 * Smart artifact references for the Crepe (Milkdown) doc surface (typed-documents plan, Slice 2 +
 * Architecture §5 "portable smart references").
 *
 * A rich embed here is a PRESENTATION upgrade over an ordinary relative markdown link, never new
 * syntax. The `.md` on disk keeps only `[title](sibling.html)`; this module renders that link as a
 * card while leaving the ProseMirror document — and therefore the serialized markdown — untouched.
 * That is why the card is a ProseMirror *decoration* rather than a custom node: a decoration adds DOM
 * and classes without entering the document model, so `getMarkdown()` still emits the exact portable
 * link, and the file stays a valid clickable relative link outside Koda / in a plain editor / on
 * GitHub. Card presentation state (collapse, later size) is the sidecar's to hold — never the file's.
 *
 * Recognition keys off `resolveDocFormat` from the shared document contract, not a hardcoded
 * extension, so the set of formats that earn a card is one line to widen. Only RELATIVE links to
 * project-local artifact formats become cards; an external URL, an absolute path, a bare `#anchor`,
 * an inline mid-sentence link, and a link to another markdown/text file all stay ordinary links.
 */
import { resolveDocFormat } from '@shared/document-contract'
import type { DocFormat } from '@shared/ipc'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { $prose, Plugin, PluginKey, Decoration, DecorationSet } from './milkdown-runtime'

/**
 * The formats a recognized link is promoted to a card for. Starts at `html` — the first (and, in this
 * slice, only) self-contained artifact Koda opens on the Stage — but membership is decided through
 * `resolveDocFormat`, so admitting `docx`/`pdf` later is adding a word here, not a new extension test.
 */
export const RECOGNIZED_ARTIFACT_FORMATS: ReadonlySet<DocFormat> = new Set<DocFormat>(['html'])

/**
 * Does this link ref point at a project-local artifact that should render as a smart card?
 *
 * A card stands in for a durable relative link to a sibling artifact, so anything that is not a
 * relative project path is left exactly as the author wrote it: a scheme (`http:`, `mailto:`) or a
 * protocol-relative `//host` is external; a leading `/` is not a relative link; a bare `#fragment`
 * is same-document navigation. What remains is judged purely on its format.
 */
export function isRecognizedArtifactRef(ref: string): boolean {
  if (!ref) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) return false
  if (ref.startsWith('/')) return false
  const target = ref.split('#')[0].split('?')[0]
  if (!target) return false
  return RECOGNIZED_ARTIFACT_FORMATS.has(resolveDocFormat(target))
}

/**
 * Resolve a doc-relative link target against the doc's own folder — a pure string walk (no node:path
 * in the renderer). An absolute path passes through (the contained-fs gate downstream judges it); a
 * `..` escape above the project root returns null and the caller simply ignores the click.
 *
 * Shared with the doc editor's live-link click handler so "where does this link point" has one answer.
 */
export function resolveDocRelativePath(docPath: string, ref: string): string | null {
  if (ref.startsWith('/')) return ref
  const base = docPath.split('/').slice(0, -1)
  for (const seg of ref.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (base.length <= 1) return null
      base.pop()
    } else base.push(seg)
  }
  return base.join('/') || null
}

/** Decode a link ref for filesystem resolution — a Koda-inserted ref percent-encodes spaces so the
 *  markdown link stays valid, and the file path has to be the decoded form. Best-effort: a malformed
 *  `%` sequence is used as written rather than throwing the click away. */
export function decodeArtifactRef(ref: string): string {
  const target = ref.split('#')[0]
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

/**
 * Derive a bounded, human title for a new interactive view from the passage it is built from.
 *
 * The first non-empty line, stripped of the markdown that dresses it (a heading's `#`, a list bullet,
 * inline emphasis/code, a link's target) so the title reads as words. Bounded well under the create
 * command's own ceilings, and never empty — an all-symbol or blank selection still names something.
 */
export function deriveInteractiveViewTitle(selection: string, max = 80): string {
  const firstLine = (selection ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  let title = (firstLine ?? '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title) title = 'Interactive view'
  if (title.length > max) {
    const clipped = title.slice(0, max)
    const atWord = clipped.replace(/\s+\S*$/, '').trim()
    title = atWord || clipped.trim()
  }
  return title
}

/**
 * A portable relative markdown link ref from a source document to an artifact, both project-relative
 * POSIX paths. Each segment is percent-encoded so a filename with a space (`Reading notes.html`) still
 * produces a valid, clickable link everywhere — the decode above and the editor's own click handler
 * both undo it before resolving on disk.
 */
export function artifactLinkRef(sourceRel: string, artifactRel: string): string {
  const from = sourceRel.split('/').slice(0, -1)
  const to = artifactRel.split('/')
  let i = 0
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++
  const parts = [...from.slice(i).map(() => '..'), ...to.slice(i)]
  return parts.map((seg) => (seg === '..' ? '..' : encodeURIComponent(seg))).join('/')
}

/**
 * If a paragraph is nothing but a single recognized artifact link, return that link's href. A
 * paragraph carrying any other visible text, an image, or a non-artifact link is not a card — this is
 * what keeps an inline mid-sentence link, and a link to another `.md`, an ordinary link.
 */
export function loneArtifactLinkHref(paragraph: ProseNode): string | null {
  if (paragraph.type.name !== 'paragraph') return null
  let href: string | null = null
  let matched = false
  let ok = true
  paragraph.content.forEach((child) => {
    if (!ok) return
    if (!child.isText) {
      ok = false
      return
    }
    const link = child.marks.find((mark) => mark.type.name === 'link')
    if (!link) {
      if ((child.text ?? '').trim()) ok = false
      return
    }
    const linkHref = String((link.attrs as { href?: unknown }).href ?? '')
    if (href !== null && href !== linkHref) {
      ok = false
      return
    }
    href = linkHref
    matched = true
  })
  if (!ok || !matched || href === null) return null
  return isRecognizedArtifactRef(href) ? href : null
}

/**
 * Follow a resolved artifact path through the Koda-driven renames and deletes the workspace recorded
 * this session, so a card opens the artifact's CURRENT location even though the source link text still
 * spells the old one. Handles an exact rename, a parent-folder move (prefix), and a chain of both; a
 * deleted target reports itself so the caller can decline to open a path that is gone.
 *
 * This is the card-resolution half of reference repair. Rewriting the stale link text back into the
 * `.md` so the repair survives a fresh session is a separate, source-mutating follow-up.
 */
export function repairArtifactTarget(
  abs: string,
  repairs: Readonly<Record<string, string | null>>,
): { path: string; deleted: boolean } {
  let current = abs
  for (let guard = 0; guard < 64; guard++) {
    if (Object.prototype.hasOwnProperty.call(repairs, current)) {
      const next = repairs[current]
      if (next === null) return { path: current, deleted: true }
      if (next === current) break
      current = next
      continue
    }
    const prefix = Object.keys(repairs).find((key) => current.startsWith(key + '/'))
    if (prefix === undefined) break
    const next = repairs[prefix]
    if (next === null) return { path: current, deleted: true }
    current = next + current.slice(prefix.length)
  }
  return { path: current, deleted: false }
}

/** What the doc editor wires the card's affordances to. Both receive the raw link href; the editor
 *  resolves it against the doc path and applies any Koda-driven rename repair before acting, so
 *  resolution and repair live in one place instead of inside every button. */
export interface ArtifactCardActions {
  /** Open the artifact beside the source on the Stage (a co-open tab). */
  onOpen: (href: string) => void
  /** Reveal the artifact file in Finder. */
  onReveal: (href: string) => void
}

const artifactCardKey = new PluginKey('koda-artifact-card')

const OPEN_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4"/></svg>'
const REVEAL_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>'

function actionButton(label: string, icon: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'koda-artifact-card-action'
  button.setAttribute('aria-label', label)
  button.title = label
  button.innerHTML = icon
  // Keep the gesture off ProseMirror: no selection change, no editor focus steal, no bubbling.
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    run()
  })
  return button
}

function buildActionsWidget(href: string, actions: ArtifactCardActions): HTMLElement {
  const bar = document.createElement('span')
  bar.className = 'koda-artifact-card-actions'
  bar.contentEditable = 'false'
  bar.setAttribute('aria-hidden', 'false')
  bar.appendChild(actionButton('Open on Stage', OPEN_ICON, () => actions.onOpen(href)))
  bar.appendChild(actionButton('Reveal in Finder', REVEAL_ICON, () => actions.onReveal(href)))
  return bar
}

function buildDecorations(doc: ProseNode, actions: ArtifactCardActions): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true
    const href = loneArtifactLinkHref(node)
    if (!href) return false
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, { class: 'koda-artifact-card', 'data-koda-artifact': href }),
    )
    decorations.push(
      Decoration.widget(pos + node.nodeSize - 1, () => buildActionsWidget(href, actions), {
        side: 1,
        key: `koda-artifact-card:${href}`,
        ignoreSelection: true,
        stopEvent: () => true,
      }),
    )
    return false
  })
  return DecorationSet.create(doc, decorations)
}

/**
 * The Milkdown plugin: recompute the card decorations whenever the document changes, and hand them to
 * ProseMirror to paint. The document model is never touched, so serialization stays byte-identical to
 * the portable links the file holds. Registered per open document because the callbacks close over
 * that document's path and the workspace's open/reveal seams.
 */
export function createArtifactCardPlugin(actions: ArtifactCardActions) {
  return $prose(
    () =>
      new Plugin({
        key: artifactCardKey,
        state: {
          init: (_config, state) => buildDecorations(state.doc, actions),
          apply: (tr, value) => (tr.docChanged ? buildDecorations(tr.doc, actions) : value),
        },
        props: {
          decorations(state) {
            return artifactCardKey.getState(state)
          },
        },
      }),
  )
}
