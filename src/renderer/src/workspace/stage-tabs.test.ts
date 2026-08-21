import { beforeEach, describe, expect, it } from 'vitest'
import {
  activeEditor,
  stageVisible,
  STAGE_TAB_LIMIT,
  useWorkspace,
  CHANGES_SURFACE_ID,
  PREVIEW_SURFACE_ID,
  TERMINAL_SURFACE_ID,
  TURN_CHANGES_SURFACE_ID,
  type SessionState,
} from './store'

/**
 * The Stage is a small set of CO-OPEN tabs, not one surface at a time. Everything below pins that
 * contract at the store level (the renderer only draws what these actions decide):
 *
 *  - the agent's auto-follow ADDS a tab and selects it, leaving what was already open in place;
 *  - a PINNED stage still collects the agent's tabs but never hands over the selection (the yank);
 *  - the strip stays small: over the cap the oldest expendable tab retires, never the selected one,
 *    never the preview (it fronts a running dev server).
 */

const SESSION = 'sess-1'

/** The paths on the strip, in tab order. */
function tabs(): string[] {
  return activeEditor(useWorkspace.getState()).surfaces.map((s) => s.path)
}
function selected(): string | null {
  return activeEditor(useWorkspace.getState()).activeSurfaceId
}

beforeEach(() => {
  // openChanges kicks a git refresh, and these tests run in plain Node — hand it a bridge that answers
  // "not a repo" so the refresh completes quietly instead of logging a missing-window error.
  ;(globalThis as unknown as { window: unknown }).window = {
    koda: { gitDetect: async () => ({ isRepo: false }) },
  }
  // Everything else here (openFile's recentFiles, openPreview, showEdit*) touches no bridge, so a bare
  // store reset is the rest of the fixture.
  useWorkspace.setState({ activeId: SESSION, editors: {}, recentFiles: [], stageExpanded: false })
  useWorkspace.setState({
    sessions: {
      [SESSION]: { id: SESSION, cwd: '/p' } as SessionState,
      'sess-background': { id: 'sess-background', cwd: '/other' } as SessionState,
    },
  })
})

describe('presentation receipts', () => {
  it('puts an explicit file and source location on the requesting session Stage', () => {
    useWorkspace.getState().applyStageReceipt({
      kind: 'present-file',
      id: 'receipt-file-1',
      sessionId: SESSION,
      path: 'src/app.ts',
      view: 'file',
      line: 17,
      column: 4,
    })

    expect(tabs()).toEqual(['/p/src/app.ts'])
    expect(selected()).toBe('/p/src/app.ts')
    expect(activeEditor(useWorkspace.getState()).surfaces[0]).toMatchObject({
      receiptId: 'receipt-file-1',
      gotoLine: 17,
      gotoColumn: 4,
    })
  })

  it('collects catch-up and background receipts without moving the foreground Stage', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/notes.md')
    s.applyStageReceipt({
      kind: 'present-file',
      id: 'receipt-catchup',
      sessionId: SESSION,
      path: 'README.md',
      view: 'document',
    }, { catchup: true })
    s.applyStageReceipt({
      kind: 'present-file',
      id: 'receipt-background',
      sessionId: 'sess-background',
      path: 'report.md',
      view: 'document',
    })

    expect(tabs()).toEqual(['/p/notes.md', '/p/README.md'])
    expect(selected()).toBe('/p/notes.md')
    expect(useWorkspace.getState().editors['sess-background'].surfaces).toEqual([
      expect.objectContaining({ path: '/other/report.md', view: 'doc' }),
    ])
  })

  it('keeps this-turn evidence distinct from ambient working-tree Changes', () => {
    const s = useWorkspace.getState()
    s.openChanges()
    s.applyStageReceipt({
      kind: 'turn-changes',
      id: 'receipt-turn-1',
      sessionId: SESSION,
      checkpointId: 'abcdef1',
      files: [
        { path: 'src/app.ts', status: 'modified', additions: 3, deletions: 1, binary: false },
      ],
      complete: true,
      overlapObserved: false,
    })

    expect(tabs()).toEqual([CHANGES_SURFACE_ID, TURN_CHANGES_SURFACE_ID])
    expect(selected()).toBe(CHANGES_SURFACE_ID)
    expect(activeEditor(useWorkspace.getState()).surfaces.at(-1)).toMatchObject({
      kind: 'turn-changes',
      receiptCheckpointId: 'abcdef1',
      receiptFiles: [{ path: 'src/app.ts', status: 'modified' }],
      receiptComplete: true,
    })
  })

  it('replaces a historical diff source when the same file returns to live session work', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/src/app.ts', undefined, {
      view: 'diff',
      diffSource: {
        kind: 'checkpoint',
        sessionId: SESSION,
        checkpointId: 'abcdef1',
        path: 'src/app.ts',
      },
    })
    expect(activeEditor(useWorkspace.getState()).surfaces[0].diffSource).toMatchObject({
      kind: 'checkpoint',
    })

    s.showEditDiff('/p/src/app.ts', SESSION)
    expect(activeEditor(useWorkspace.getState()).surfaces[0].diffSource).toEqual({
      kind: 'session',
      sessionId: SESSION,
    })
  })

  it('gives an explicit diff receipt its portable safety baseline and relative path', () => {
    useWorkspace.getState().applyStageReceipt({
      kind: 'present-file',
      id: 'receipt-diff-1',
      sessionId: SESSION,
      path: 'src/app.ts',
      view: 'diff',
      checkpointId: 'abcdef1',
    })

    expect(activeEditor(useWorkspace.getState()).surfaces[0].diffSource).toEqual({
      kind: 'checkpoint',
      sessionId: SESSION,
      checkpointId: 'abcdef1',
      path: 'src/app.ts',
    })
  })

  it('replaces the singleton receipt and removes it when a later turn changed nothing', () => {
    const s = useWorkspace.getState()
    s.applyStageReceipt({
      kind: 'turn-changes',
      id: 'receipt-turn-1',
      sessionId: SESSION,
      files: [{ path: 'a.ts', status: 'added', additions: 1, deletions: 0, binary: false }],
      complete: true,
      overlapObserved: false,
    })
    s.applyStageReceipt({
      kind: 'turn-changes',
      id: 'receipt-turn-2',
      sessionId: SESSION,
      files: [{ path: 'b.ts', status: 'deleted', additions: 0, deletions: 2, binary: false }],
      complete: false,
      overlapObserved: true,
    })

    expect(tabs()).toEqual([TURN_CHANGES_SURFACE_ID])
    expect(activeEditor(useWorkspace.getState()).surfaces[0]).toMatchObject({
      receiptId: 'receipt-turn-2',
      receiptFiles: [{ path: 'b.ts', status: 'deleted' }],
      receiptComplete: false,
      receiptOverlapObserved: true,
    })

    s.applyStageReceipt({
      kind: 'turn-changes',
      id: 'receipt-turn-3',
      sessionId: SESSION,
      files: [],
      complete: true,
      overlapObserved: false,
    })

    expect(tabs()).toEqual([])
    expect(selected()).toBeNull()
  })
})

describe('auto-follow adds and selects tabs', () => {
  it('keeps the file the user opened open when the agent edits another one', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/notes.md')
    s.showEditDiff('/p/api.ts', SESSION)

    expect(tabs()).toEqual(['/p/notes.md', '/p/api.ts'])
    expect(selected()).toBe('/p/api.ts')
  })

  it('re-selects an already-open tab instead of duplicating it', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/a.ts')
    s.openFile('/p/b.ts')
    s.showEditDiff('/p/a.ts', SESSION)

    expect(tabs()).toEqual(['/p/a.ts', '/p/b.ts']) // order is open order, it never reshuffles
    expect(selected()).toBe('/p/a.ts')
  })

  it('lets the preview join the strip beside the files', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/a.ts')
    s.openPreview('http://localhost:5173')

    expect(tabs()).toEqual(['/p/a.ts', PREVIEW_SURFACE_ID])
    expect(selected()).toBe(PREVIEW_SURFACE_ID)
  })
})

describe('the preview reads as live only while something is serving it', () => {
  const preview = () => activeEditor(useWorkspace.getState()).surfaces.find((s) => s.kind === 'preview')

  it('is live when it opens, and stops being live when that server dies', () => {
    const s = useWorkspace.getState()
    s.openPreview('http://localhost:5173')
    expect(preview()?.live).toBe(true)

    s.notePreviewStopped('http://localhost:5173')

    expect(preview()?.live).toBe(false)
    expect(tabs()).toEqual([PREVIEW_SURFACE_ID]) // the tab stays — its last paint is still worth reading
  })

  it('ignores a stop for a URL it is not showing', () => {
    const s = useWorkspace.getState()
    s.openPreview('http://localhost:5173')

    s.notePreviewStopped('http://localhost:4000')

    expect(preview()?.live).toBe(true)
  })

  it('goes live again when the preview is restarted onto a new port', () => {
    const s = useWorkspace.getState()
    s.openPreview('http://localhost:5173')
    s.notePreviewStopped('http://localhost:5173')

    s.openPreview('http://localhost:5174')

    expect(preview()?.live).toBe(true)
    expect(preview()?.previewUrl).toBe('http://localhost:5174')
  })

  it('clears the mark on a background session’s tab too — one dev server, one window', () => {
    const s = useWorkspace.getState()
    s.openPreview('http://localhost:5173', { sessionId: 'sess-other' })
    s.openPreview('http://localhost:5173')

    s.notePreviewStopped('http://localhost:5173')

    const other = useWorkspace.getState().editors['sess-other'].surfaces.find((x) => x.kind === 'preview')
    expect(other?.live).toBe(false)
    expect(preview()?.live).toBe(false)
  })
})

describe('the pin survives a yank attempt', () => {
  it('collects the agent’s tab without taking the stage', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/notes.md')
    s.setStagePinned(true)

    s.showEditDiff('/p/api.ts', SESSION)
    s.showEditDoc('/p/README.md', SESSION)
    s.openPreview('http://localhost:5173', { respectPin: true, sessionId: SESSION })

    expect(tabs()).toEqual(['/p/notes.md', '/p/api.ts', '/p/README.md', PREVIEW_SURFACE_ID])
    expect(selected()).toBe('/p/notes.md') // the yank never landed
    expect(activeEditor(useWorkspace.getState()).pinned).toBe(true)
  })

  it('still lets the user take the stage by hand, which releases the pin', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/notes.md')
    s.setStagePinned(true)
    s.showEditDiff('/p/api.ts', SESSION)

    s.selectSurface('/p/api.ts')

    expect(selected()).toBe('/p/api.ts')
    expect(activeEditor(useWorkspace.getState()).pinned).toBe(false)
  })
})

describe('the strip stays small', () => {
  it('retires the oldest expendable tab past the cap, keeping the selected one and the preview', () => {
    const s = useWorkspace.getState()
    s.openPreview('http://localhost:5173') // oldest tab, but it fronts a running server
    for (let i = 0; i < STAGE_TAB_LIMIT - 1; i++) s.openFile(`/p/f${i}.ts`)
    s.setStagePinned(true) // hold f4 on stage so the next arrivals cannot select it away

    s.showEditDiff('/p/new-a.ts', SESSION)
    s.showEditDiff('/p/new-b.ts', SESSION)

    const strip = tabs()
    expect(strip).toHaveLength(STAGE_TAB_LIMIT)
    expect(strip).toContain(PREVIEW_SURFACE_ID)
    expect(strip).toContain('/p/new-a.ts')
    expect(strip).toContain('/p/new-b.ts')
    expect(strip).toContain(selected())
    expect(strip).not.toContain('/p/f0.ts') // the oldest file tab retired first
    expect(strip).not.toContain('/p/f1.ts')
  })
})

describe('closing a tab', () => {
  it('falls to the tab that slid into its place', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/a.ts')
    s.openFile('/p/b.ts')
    s.openFile('/p/c.ts')
    s.selectSurface('/p/b.ts')

    s.closeSurface('/p/b.ts')

    expect(tabs()).toEqual(['/p/a.ts', '/p/c.ts'])
    expect(selected()).toBe('/p/c.ts')
  })

  it('empties the stage when the last tab goes', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/a.ts')

    s.closeSurface('/p/a.ts')

    expect(tabs()).toEqual([])
    expect(selected()).toBeNull()
  })
})

describe('every surface arrives as a tab', () => {
  it('puts the terminal and the changes review on the strip, like a file or the preview', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/a.ts')
    s.openTerminal('npm run dev')
    s.openChanges()

    expect(tabs()).toEqual(['/p/a.ts', TERMINAL_SURFACE_ID, CHANGES_SURFACE_ID])
    expect(selected()).toBe(CHANGES_SURFACE_ID)
    // The staged command rides along for the terminal view to type at the prompt (never runs it).
    expect(useWorkspace.getState().pendingTermCommand).toBe('npm run dev')
  })

  it('lands a background session’s terminal in ITS editor, not the one the user is reading', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/a.ts')

    s.openTerminal('sudo something', 'sess-background')

    // The active session's stage is untouched — no tab appeared, nothing was selected away.
    expect(tabs()).toEqual(['/p/a.ts'])
    expect(selected()).toBe('/p/a.ts')
    // The requesting session got the terminal, ready for when the user switches to it.
    const bg = useWorkspace.getState().editors['sess-background']
    expect(bg.surfaces.map((x) => x.path)).toEqual([TERMINAL_SURFACE_ID])
    expect(bg.activeSurfaceId).toBe(TERMINAL_SURFACE_ID)
  })

  it('re-selects the open terminal instead of stacking a second one', () => {
    const s = useWorkspace.getState()
    s.openTerminal()
    s.openFile('/p/a.ts')
    s.openTerminal()

    expect(tabs()).toEqual([TERMINAL_SURFACE_ID, '/p/a.ts'])
    expect(selected()).toBe(TERMINAL_SURFACE_ID)
  })

  it('holds the stage while the terminal is on it, so an agent edit cannot yank it away', () => {
    const s = useWorkspace.getState()
    s.openTerminal()

    s.showEditDiff('/p/api.ts', SESSION)

    expect(tabs()).toEqual([TERMINAL_SURFACE_ID, '/p/api.ts']) // the tab still lands
    expect(selected()).toBe(TERMINAL_SURFACE_ID) // the selection does not move
  })

  it('never retires a live surface to make room', () => {
    const s = useWorkspace.getState()
    s.openTerminal()
    s.openChanges()
    for (let i = 0; i < STAGE_TAB_LIMIT + 2; i++) s.openFile(`/p/f${i}.ts`)

    const strip = tabs()
    expect(strip).toHaveLength(STAGE_TAB_LIMIT)
    expect(strip).toContain(TERMINAL_SURFACE_ID)
    expect(strip).toContain(CHANGES_SURFACE_ID)
  })
})

describe('the stage shows itself only when it holds something', () => {
  it('stays away on a fresh chat', () => {
    expect(stageVisible(useWorkspace.getState())).toBe(false)
  })

  it('appears when something lands on it, and leaves when the last tab closes', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/a.ts')
    expect(stageVisible(useWorkspace.getState())).toBe(true)

    s.closeSurface('/p/a.ts')
    expect(stageVisible(useWorkspace.getState())).toBe(false)
  })

  it('honours a hide by hand: the agent’s next edit adds its tab without reopening the panel', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/a.ts')
    s.setDockOpen(false)

    s.showEditDiff('/p/api.ts', SESSION)

    expect(tabs()).toEqual(['/p/a.ts', '/p/api.ts'])
    expect(stageVisible(useWorkspace.getState())).toBe(false)
  })

  it('releases that hide when the user opens something themselves', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/a.ts')
    s.setDockOpen(false)

    s.openFile('/p/b.ts')

    expect(stageVisible(useWorkspace.getState())).toBe(true)
  })

  it('is per session: a new chat starts clean even while another has a full stage', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/a.ts')

    useWorkspace.setState({ activeId: 'sess-2' })

    expect(stageVisible(useWorkspace.getState())).toBe(false)
    expect(tabs()).toEqual([])
  })
})

describe('expanding the stage', () => {
  it('opens the dock and works for whatever tab is on stage, not just the preview', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/a.ts')

    s.setStageExpanded(true)

    expect(useWorkspace.getState().stageExpanded).toBe(true)
    expect(stageVisible(useWorkspace.getState())).toBe(true)
    expect(selected()).toBe('/p/a.ts') // expanding did not drag the preview on stage
  })

  it('collapses when the dock closes, so a reopened dock is not stuck full width', () => {
    const s = useWorkspace.getState()
    s.setStageExpanded(true)

    s.setDockOpen(false)

    expect(useWorkspace.getState().stageExpanded).toBe(false)
  })

  it('collapses when the last tab closes, so the next file does not land full width', () => {
    const s = useWorkspace.getState()
    s.openFile('/p/a.ts')
    s.setStageExpanded(true)

    s.closeSurface('/p/a.ts')

    expect(useWorkspace.getState().stageExpanded).toBe(false)
  })
})
