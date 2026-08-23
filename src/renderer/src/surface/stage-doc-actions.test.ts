import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasDocView, stagedDocRel } from './stage-doc-actions'
import { useWorkspace, type FileSurface } from '../workspace/store'

/**
 * The Stage bar's document actions — the predicate that decides whether a real, keepable document is on
 * stage (and therefore receives the document-only star, view menu, and overflow hierarchy), plus the
 * project-owned shelf action the visible Star button invokes. The renderer suite has no DOM, so the
 * menus' keyboard behaviour is proven in the document E2E; here we pin the pure decisions and store seam.
 */

const PROJECT = '/Users/dev/project'

/** A minimal file surface — `stagedDocRel` reads only `path` and `kind`. */
function surface(path: string, kind?: FileSurface['kind']): FileSurface {
  return { path, title: path.split('/').pop() ?? path, view: 'doc', rev: 0, ...(kind ? { kind } : {}) }
}

describe('stagedDocRel', () => {
  it('is null when there is nothing keepable on stage', () => {
    // Nothing staged, or no open project, has no path to star.
    expect(stagedDocRel(null, PROJECT)).toBeNull()
    expect(stagedDocRel(surface(`${PROJECT}/Documents/brief.md`), null)).toBeNull()
  })

  it('is null for a singleton surface — those are not documents', () => {
    for (const kind of ['preview', 'terminal', 'changes', 'turn-changes', 'agents'] as const) {
      expect(stagedDocRel(surface('koda://singleton', kind), PROJECT)).toBeNull()
    }
  })

  it('is null for a file with no rendered document view', () => {
    expect(stagedDocRel(surface(`${PROJECT}/src/index.ts`), PROJECT)).toBeNull()
    expect(stagedDocRel(surface(`${PROJECT}/notes.txt`), PROJECT)).toBeNull()
    expect(stagedDocRel(surface(`${PROJECT}/logo.png`), PROJECT)).toBeNull()
  })

  it('is null for a document outside the open project', () => {
    expect(stagedDocRel(surface('/somewhere/else/brief.md'), PROJECT)).toBeNull()
    // A sibling directory whose name merely starts with the project path is still outside it.
    expect(stagedDocRel(surface(`${PROJECT}-other/brief.md`), PROJECT)).toBeNull()
  })

  it('yields the project-relative path for an in-project markdown or html document', () => {
    expect(stagedDocRel(surface(`${PROJECT}/Documents/brief.md`), PROJECT)).toBe('Documents/brief.md')
    expect(stagedDocRel(surface(`${PROJECT}/Documents/report.html`), PROJECT)).toBe('Documents/report.html')
  })
})

describe('hasDocView', () => {
  it('names exactly the two formats with a rendered Stage document view', () => {
    expect(hasDocView('markdown')).toBe(true)
    expect(hasDocView('html')).toBe(true)
    for (const format of ['docx', 'pdf', 'text'] as const) expect(hasDocView(format)).toBe(false)
  })
})

describe('the store action the overflow menu invokes', () => {
  beforeEach(() => {
    // The module guards its boot-time git refresh behind `typeof window`, so it loads clean in node;
    // the star command reaches for `window.koda.setDocStar?.()`, absent here, so the durable write is a
    // no-op and only the synchronous in-memory toggle under test remains.
    vi.stubGlobal('window', { koda: {} })
    useWorkspace.setState({ starredDocs: [], legacyKeptDocsImported: [], projectPath: null })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('star then unstar toggles the shelf — the same actions the button and Library use', () => {
    const rel = 'Documents/brief.md'
    useWorkspace.getState().starDoc(rel)
    expect(useWorkspace.getState().starredDocs).toContain(rel)
    useWorkspace.getState().unstarDoc(rel)
    expect(useWorkspace.getState().starredDocs).not.toContain(rel)
  })
})
