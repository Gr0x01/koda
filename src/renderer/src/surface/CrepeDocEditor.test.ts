import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSaveCoalescer, docEditorGuards } from './CrepeDocEditor'

/**
 * The document surface's two load-bearing rules: reading state blocks the USER without blocking the
 * agent, and "saved automatically" is a coalesced write rather than a write per keystroke.
 *
 * The wiring assertions read the source. This repo's Vitest lane is plain Node, so the rendered Crepe
 * editor's edit-and-close path is driven by the built-Electron doc-surface assay. What a source check
 * can hold is the thing most likely to rot silently: that a typed edit still reaches disk through the
 * contained writer and never becomes an engine turn, and that review copy still names Koda instead
 * of one engine.
 */
const SOURCE = readFileSync(join(__dirname, 'CrepeDocEditor.tsx'), 'utf8')
const CALLOUT_SOURCE = readFileSync(join(__dirname, 'blocks/callout.ts'), 'utf8')
const TOGGLE_SOURCE = readFileSync(join(__dirname, 'blocks/toggle.ts'), 'utf8')
const ARTIFACT_CARD_SOURCE = readFileSync(join(__dirname, 'artifact-card.ts'), 'utf8')
const MILKDOWN_RUNTIME_SOURCE = readFileSync(join(__dirname, 'milkdown-runtime.ts'), 'utf8')

/** The body of a top-level function declaration, by brace matching from its signature. */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, `${signature} is gone from CrepeDocEditor.tsx`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces after ${signature}`)
}

describe('docEditorGuards', () => {
  it('lets a document be read, selected, and refreshed without being typeable', () => {
    expect(docEditorGuards({ readOnly: false, editing: false })).toEqual({
      userEditable: false,
      acceptsRefresh: true,
      selectable: true,
    })
  })

  it('opens the user path only once Edit is chosen', () => {
    expect(docEditorGuards({ readOnly: false, editing: true })).toEqual({
      userEditable: true,
      acceptsRefresh: true,
      selectable: true,
    })
  })

  it('keeps a truncated file unwritable in either state', () => {
    for (const editing of [false, true]) {
      expect(docEditorGuards({ readOnly: true, editing })).toEqual({
        userEditable: false,
        acceptsRefresh: false,
        selectable: false,
      })
    }
  })
})

describe('createSaveCoalescer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('turns a burst of keystrokes into one write, after the doc goes idle', async () => {
    const save = vi.fn(async () => {})
    const autosave = createSaveCoalescer(save, 50)
    for (let i = 0; i < 8; i++) {
      autosave.schedule()
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(save).not.toHaveBeenCalled() // still typing: nothing has been written yet
    await vi.advanceTimersByTimeAsync(50)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('writes immediately on flush, so an unmount mid-typing keeps the edit', async () => {
    const save = vi.fn(async () => {})
    const autosave = createSaveCoalescer(save, 50)
    autosave.schedule()
    await autosave.flush() // the Stage tab switch that unmounts the pane
    expect(save).toHaveBeenCalledTimes(1)
    // The flush consumed the pending timer rather than leaving a second write behind it.
    await vi.advanceTimersByTimeAsync(200)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('drops a pending write on cancel', async () => {
    const save = vi.fn(async () => {})
    const autosave = createSaveCoalescer(save, 50)
    autosave.schedule()
    autosave.cancel()
    await vi.advanceTimersByTimeAsync(200)
    expect(save).not.toHaveBeenCalled()
  })

  it('queues one more pass when a flush lands mid-write, so nothing typed is lost', async () => {
    const written: string[] = []
    let text = 'first'
    // The in-flight write is held open here so the test can decide when it lands.
    const gate: { release: (() => void) | null } = { release: null }
    const save = async (): Promise<void> => {
      const pending = text
      await new Promise<void>((resolve) => {
        gate.release = resolve
      })
      written.push(pending)
    }
    const autosave = createSaveCoalescer(save, 50)
    autosave.schedule()
    await vi.advanceTimersByTimeAsync(50)
    expect(written).toEqual([]) // the first write is in flight, not yet landed

    text = 'second' // the user keeps typing while that write is out
    const flushed = autosave.flush()
    gate.release?.()
    await vi.advanceTimersByTimeAsync(0) // the queued pass starts and blocks on its own promise
    gate.release?.()
    await flushed
    expect(written).toEqual(['first', 'second'])
  })
})

describe('the direct-edit path', () => {
  it('reaches disk through the contained writer and never through the engine', () => {
    const save = functionBody(SOURCE, 'async function save()')
    expect(save).toContain('window.koda.writeFile')
    expect(save).not.toContain('sendCanvasEdit')
    // The one engine call in this surface is the selection ask — a deliberate turn the user sends.
    expect(SOURCE.match(/sendCanvasEdit\(\{/g)).toHaveLength(1)
    expect(functionBody(SOURCE, 'async function askCanvas(')).toContain('sendCanvasEdit({')
  })

  it('registers its coalesced writer and keeps the unmount flush alive through cleanup', () => {
    expect(SOURCE).toContain('registerFileWriter(path, surfacePath, async () => {')
    expect(SOURCE).toContain('void autosave.flush().catch(() => {}).finally(unregister)')
  })

  it('keeps the body reachable after the editor is torn down', () => {
    // Milkdown's markdown listener is debounced 200ms and cancelled on destroy, so the last
    // keystrokes before a tab switch exist only inside the editor. Reading it in the teardown, before
    // `destroy()`, is what the unmount flush then writes; without it a fast close loses them.
    const mountStart = SOURCE.indexOf('const crepe = new Crepe(')
    const teardown = SOURCE.slice(mountStart, SOURCE.indexOf('}, [path])', mountStart))
    expect(teardown).toMatch(/finalBodyRef\.current = crepe\.getMarkdown\(\)[\s\S]*crepe\.destroy\(\)/)
    // And a save prefers the live editor over that snapshot, so an ordinary save is never one behind.
    expect(functionBody(SOURCE, 'async function save()')).toContain(
      'crepeRef.current?.getMarkdown() ?? finalBodyRef.current',
    )
  })

  it('keeps every write behind the one save that checkpoints', () => {
    // Revert also drains through autosave; a second writer could race a confirmed sidebar delete.
    expect(SOURCE.match(/window\.koda\.writeFile\(/g)).toHaveLength(1)
    expect(functionBody(SOURCE, 'async function revertReview()')).toContain('await autosave.flush()')
  })
})

describe('the Milkdown runtime boundary', () => {
  it('keeps Crepe and every custom desktop plugin on one module identity', () => {
    for (const source of [SOURCE, CALLOUT_SOURCE, TOGGLE_SOURCE, ARTIFACT_CARD_SOURCE]) {
      const runtimeImports = source
        .split('\n')
        .filter((line) => line.includes("from '@milkdown/") && !line.trimStart().startsWith('import type'))
      expect(runtimeImports).toEqual([])
    }

    expect(SOURCE).toContain("from './milkdown-runtime'")
    expect(CALLOUT_SOURCE).toContain("from '../milkdown-runtime'")
    expect(TOGGLE_SOURCE).toContain("from '../milkdown-runtime'")
    expect(MILKDOWN_RUNTIME_SOURCE).toContain("export { Crepe } from '@milkdown/crepe'")
    expect(MILKDOWN_RUNTIME_SOURCE).toContain("from '@milkdown/kit/core'")
    expect(MILKDOWN_RUNTIME_SOURCE).toContain("from '@milkdown/kit/utils'")
  })

  it('does not present an initialization failure as a save failure', () => {
    expect(SOURCE).toContain("Couldn't open editor: {initError}")
    expect(SOURCE).toContain("Couldn't save: {saveError}")
    expect(SOURCE).toContain('await reloadForModuleGraphError(e)')
    expect(SOURCE).not.toContain('.catch((e) => !disposed && setError(String(e)))')
  })
})

describe('agent-edit review', () => {
  it('names Koda, not the engine behind it', () => {
    expect(SOURCE).toContain('Koda changed 1 passage')
    for (const engine of ['Claude', 'Codex', 'Anthropic', 'OpenAI']) {
      expect(SOURCE.includes(`>${engine}`), `${engine} appears in doc-surface copy`).toBe(false)
      expect(SOURCE.includes(`${engine} edited`), `${engine} appears in doc-surface copy`).toBe(false)
    }
  })

  it('offers Revert and Accept edit, and no third meaning for Keep', () => {
    expect(SOURCE).toContain('Accept edit')
    expect(SOURCE).toContain('Revert')
    expect(SOURCE).not.toMatch(/>\s*Keep\s*</)
  })

  it('announces itself to a screen reader', () => {
    const review = SOURCE.slice(SOURCE.indexOf('Koda changed 1 passage') - 800, SOURCE.indexOf('Koda changed 1 passage'))
    expect(review).toContain('role="status"')
  })

  it('still treats the user typing over a pending agent edit as acceptance', () => {
    // Revert must never be able to discard writing the user did on top of the agent's change.
    expect(SOURCE).toMatch(/if \(dirty && review !== null\) setReview\(null\)/)
  })
})

describe('smart artifact references', () => {
  it('renders recognized links as cards without touching the document model', () => {
    // The card is a decoration plugin, registered like the other custom plugins — so the markdown on
    // disk stays the portable link and never gains a card node.
    expect(SOURCE).toContain('createArtifactCardPlugin({')
  })

  it('creates the view through the shared command and never as an engine turn', () => {
    const create = functionBody(SOURCE, 'async function createInteractiveView()')
    // One command owns the artifact — the same IPC the agent's create_interactive verb runs.
    expect(create).toContain('window.koda.createInteractiveDocument({')
    // It inserts the portable link back and opens the artifact beside the source (a co-open tab).
    expect(create).toContain('insertArtifactLink(')
    expect(create).toContain('openFile(joinProjectPath(')
    // Making a view is not an agent edit: no engine turn is sent from this path.
    expect(create).not.toContain('sendCanvasEdit')
  })

  it('inserts an ordinary markdown link node, not raw HTML, into the source', () => {
    const insert = functionBody(SOURCE, 'function insertArtifactLink(')
    expect(insert).toContain('schema.marks.link')
    expect(insert).not.toContain('innerHTML')
    expect(insert).not.toContain('<a')
  })

  it('opens a card through the session rename-repair resolver', () => {
    // A card's link text is the portable original; opening resolves through the repair map so a
    // Koda-driven rename still lands on the artifact's current home.
    expect(SOURCE).toContain('repairArtifactTarget(resolved, repairsRef.current)')
    expect(SOURCE).toContain('const docRefRepairs = useWorkspace((s) => s.docRefRepairs)')
  })
})
