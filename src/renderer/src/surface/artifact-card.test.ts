import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import {
  artifactLinkRef,
  decodeArtifactRef,
  deriveInteractiveViewTitle,
  isRecognizedArtifactRef,
  loneArtifactLinkHref,
  repairArtifactTarget,
  resolveDocRelativePath,
} from './artifact-card'

/**
 * The smart-reference recognizer and its portable-link math. These decide which links become cards and
 * how a Create-interactive-view link is written, so the load-bearing property under test is that only a
 * relative link to a project-local artifact is ever promoted — everything else stays an ordinary link,
 * and the ref that lands in the file is always plain, portable markdown.
 */
describe('isRecognizedArtifactRef', () => {
  it('recognizes a relative link to a project-local artifact format', () => {
    expect(isRecognizedArtifactRef('frost.html')).toBe(true)
    expect(isRecognizedArtifactRef('views/frost.html')).toBe(true)
    expect(isRecognizedArtifactRef('../shared/report.htm')).toBe(true)
    expect(isRecognizedArtifactRef('Reading%20notes.html')).toBe(true)
    expect(isRecognizedArtifactRef('frost.html#section')).toBe(true)
  })

  it('leaves a non-local or non-artifact link an ordinary link', () => {
    // External and non-relative are not project-local artifacts.
    expect(isRecognizedArtifactRef('https://example.com/frost.html')).toBe(false)
    expect(isRecognizedArtifactRef('mailto:me@example.com')).toBe(false)
    expect(isRecognizedArtifactRef('//cdn.example.com/x.html')).toBe(false)
    expect(isRecognizedArtifactRef('/Documents/frost.html')).toBe(false)
    expect(isRecognizedArtifactRef('#heading')).toBe(false)
    // A relative link, but not an artifact format: markdown navigation and plain files stay plain.
    expect(isRecognizedArtifactRef('notes.md')).toBe(false)
    expect(isRecognizedArtifactRef('diagram.png')).toBe(false)
    expect(isRecognizedArtifactRef('data.txt')).toBe(false)
    expect(isRecognizedArtifactRef('')).toBe(false)
  })
})

describe('resolveDocRelativePath', () => {
  it('resolves against the doc folder and refuses an escape above the project root', () => {
    expect(resolveDocRelativePath('/proj/Documents/plan.md', 'frost.html')).toBe('/proj/Documents/frost.html')
    expect(resolveDocRelativePath('/proj/Documents/plan.md', 'views/frost.html')).toBe(
      '/proj/Documents/views/frost.html',
    )
    expect(resolveDocRelativePath('/proj/Documents/notes/plan.md', '../frost.html')).toBe(
      '/proj/Documents/frost.html',
    )
    // Absolute passes through for the downstream contained-fs gate to judge.
    expect(resolveDocRelativePath('/proj/Documents/plan.md', '/x.html')).toBe('/x.html')
    // Climbing past the root is refused.
    expect(resolveDocRelativePath('/proj/plan.md', '../../etc/passwd')).toBeNull()
  })
})

describe('deriveInteractiveViewTitle', () => {
  it('takes the first meaningful line, stripped of markdown, bounded, never empty', () => {
    expect(deriveInteractiveViewTitle('## Frost date explorer\n\nBody text')).toBe('Frost date explorer')
    expect(deriveInteractiveViewTitle('\n\n- **Compare** the `plans`')).toBe('Compare the plans')
    expect(deriveInteractiveViewTitle('   ')).toBe('Interactive view')
    const long = 'A'.repeat(200)
    expect(deriveInteractiveViewTitle(long).length).toBeLessThanOrEqual(80)
  })

  it('clips at a word boundary when possible', () => {
    const words = `${'ab '.repeat(40)}tail`
    const title = deriveInteractiveViewTitle(words)
    expect(title.length).toBeLessThanOrEqual(80)
    expect(title.endsWith(' ')).toBe(false)
  })
})

describe('artifactLinkRef', () => {
  it('writes a plain, portable relative ref from the source to the artifact', () => {
    expect(artifactLinkRef('Documents/notes/plan.md', 'Documents/notes/frost.html')).toBe('frost.html')
    expect(artifactLinkRef('Documents/plan.md', 'Documents/views/frost.html')).toBe('views/frost.html')
    expect(artifactLinkRef('Documents/a/b/plan.md', 'Documents/frost.html')).toBe('../../frost.html')
  })

  it('percent-encodes a segment with a space so the markdown link stays valid', () => {
    const ref = artifactLinkRef('Documents/plan.md', 'Documents/Reading notes.html')
    expect(ref).toBe('Reading%20notes.html')
    // And it round-trips back to the on-disk name for resolution.
    expect(decodeArtifactRef(ref)).toBe('Reading notes.html')
  })
})

describe('repairArtifactTarget', () => {
  it('follows a Koda-driven rename, a folder move, a chain, and a delete', () => {
    expect(repairArtifactTarget('/proj/Documents/frost.html', {})).toEqual({
      path: '/proj/Documents/frost.html',
      deleted: false,
    })
    // Exact rename.
    expect(
      repairArtifactTarget('/proj/Documents/frost.html', {
        '/proj/Documents/frost.html': '/proj/Documents/weather.html',
      }).path,
    ).toBe('/proj/Documents/weather.html')
    // Parent-folder move carries the child.
    expect(
      repairArtifactTarget('/proj/Documents/views/frost.html', {
        '/proj/Documents/views': '/proj/Documents/archive',
      }).path,
    ).toBe('/proj/Documents/archive/frost.html')
    // A chain resolves in one call.
    expect(
      repairArtifactTarget('/proj/a.html', {
        '/proj/a.html': '/proj/b.html',
        '/proj/b.html': '/proj/c.html',
      }).path,
    ).toBe('/proj/c.html')
    // A deleted target reports itself.
    expect(repairArtifactTarget('/proj/gone.html', { '/proj/gone.html': null })).toEqual({
      path: '/proj/gone.html',
      deleted: true,
    })
  })
})

// Minimal ProseMirror-node stand-ins: `loneArtifactLinkHref` only reads `type.name`, iterates inline
// content, and inspects each child's `isText`/`marks`/`text`, so a hand-built shape exercises the
// lone-link rule without a live editor (the plain-Node test lane has no ProseMirror schema).
const linkMark = (href: string) => ({ type: { name: 'link' }, attrs: { href } })
const textNode = (text: string, marks: unknown[] = []) => ({ isText: true, text, marks })
const imageNode = { isText: false }
const paragraph = (...children: unknown[]) =>
  ({
    type: { name: 'paragraph' },
    content: { forEach: (cb: (child: unknown) => void) => children.forEach(cb) },
  }) as unknown as ProseNode

describe('loneArtifactLinkHref', () => {
  it('matches a paragraph that is only a recognized artifact link', () => {
    expect(loneArtifactLinkHref(paragraph(textNode('Frost explorer', [linkMark('frost.html')])))).toBe(
      'frost.html',
    )
    // Whitespace-only text around the link does not disqualify it.
    expect(
      loneArtifactLinkHref(
        paragraph(textNode('  '), textNode('Frost', [linkMark('frost.html')]), textNode(' ')),
      ),
    ).toBe('frost.html')
  })

  it('leaves an inline, non-artifact, or non-link paragraph alone', () => {
    // An inline mid-sentence link keeps ordinary visible text beside it.
    expect(
      loneArtifactLinkHref(paragraph(textNode('see '), textNode('Frost', [linkMark('frost.html')]))),
    ).toBeNull()
    // A relative link to a non-artifact format is not a card.
    expect(loneArtifactLinkHref(paragraph(textNode('Notes', [linkMark('notes.md')])))).toBeNull()
    // An image (or any non-text inline node) is not a lone link.
    expect(loneArtifactLinkHref(paragraph(imageNode))).toBeNull()
    // Plain text with no link at all.
    expect(loneArtifactLinkHref(paragraph(textNode('just prose')))).toBeNull()
  })
})

/**
 * Portability is the whole contract: the card is a presentation upgrade, never new markdown syntax.
 * A source check holds the thing most likely to rot — that the card is a ProseMirror *decoration* over
 * an untouched document model, not a custom node that would change what `getMarkdown()` serializes.
 */
describe('the card stays out of the document model', () => {
  const SOURCE = readFileSync(join(__dirname, 'artifact-card.ts'), 'utf8')

  it('renders through decorations, never a node schema or new syntax', () => {
    expect(SOURCE).toContain('Decoration.node(')
    expect(SOURCE).toContain('Decoration.widget(')
    expect(SOURCE).not.toContain('$nodeSchema')
    expect(SOURCE).not.toContain('$remark')
  })

  it('routes every Milkdown runtime value through the single boundary module', () => {
    const runtimeImports = SOURCE.split('\n').filter(
      (line) => line.includes("from '@milkdown/") && !line.trimStart().startsWith('import type'),
    )
    expect(runtimeImports).toEqual([])
    expect(SOURCE).toContain("from './milkdown-runtime'")
  })
})
