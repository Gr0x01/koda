import { useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import './monaco-setup' // wires the bundled, CSP-safe workers + the local (non-CDN) monaco loader
import { languageFor, MONO_FONT } from './monaco-lang'
import { useTheme } from '../theme'
import { useTextSize } from '../text-size'
import { createSerialFlush, registerFileWriter } from '../workspace/file-writer-registry'

/**
 * The editable file surface body (ui-workspace.md §4). Lazy-loaded so `monaco-editor` stays out of
 * the conversation-only bundle — it only loads once a file is actually opened (see FileSurfaceView).
 *
 * Saves flow back through `fs:writeFile`, where main takes a safety-git checkpoint of the pre-edit
 * tree before writing — so a user edit is recoverable exactly like an engine tool write.
 */

export function MonacoFileEditor({
  path,
  surfacePath,
  initialContent,
  readOnly = false,
  gotoLine,
  gotoColumn,
  gotoNonce,
  className = '',
}: {
  /** Main's resolved path: the one identity used for writes and destructive-boundary matching. */
  path: string
  /** The lexical path that keys this open Stage surface. */
  surfacePath: string
  initialContent: string
  readOnly?: boolean
  /** Reveal + select this 1-based line on mount (a search hit opened the file here). */
  gotoLine?: number
  /** Optional 1-based column paired with gotoLine. */
  gotoColumn?: number
  /** Re-trigger the reveal when the file was already open (bumped per open — see store.openFile). */
  gotoNonce?: number
  className?: string
}) {
  const { monacoTheme } = useTheme()
  const { codeFontSize } = useTextSize()
  // The last-saved content — dirty is "current value differs from this". Lives in a ref because the
  // ⌘S handler reads it without needing to be re-bound on every keystroke.
  const baselineRef = useRef(initialContent)
  const valueRef = useRef(initialContent)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Ordinary save controls report inline instead of throwing. The registered destructive-boundary
  // flush reads this ref after the serial queue drains and turns the same failure into a hard stop.
  const lastSaveErrorRef = useRef<unknown>(null)
  // The last save landed but main couldn't take a recovery point for it. Silence here would leave the
  // user believing this edit is undoable when it isn't. Cleared by the next save that does get one.
  const [noUndo, setNoUndo] = useState(false)
  // The pane swaps a new file's content INTO this instance rather than remounting it (see the
  // initialContent effect below), so a per-file flag follows the user to the next file unless it's
  // cleared here.
  useEffect(() => setNoUndo(false), [path])

  async function save(): Promise<void> {
    if (readOnly) return
    // Capture the exact payload. The user may keep typing while IPC is in flight; treating the later
    // buffer as the saved baseline would make those newer characters look durable when they are not.
    const content = valueRef.current
    if (content === baselineRef.current) {
      lastSaveErrorRef.current = null
      setError(null)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await window.koda.writeFile({ path, content })
      baselineRef.current = content
      setDirty(valueRef.current !== content)
      setNoUndo(res.checkpointed === false)
      lastSaveErrorRef.current = null
    } catch (e) {
      lastSaveErrorRef.current = e
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  // Keep the latest `save` reachable from Monaco's command (bound once on mount).
  const saveRef = useRef(save)
  saveRef.current = save
  // Every explicit save joins one tail. A delete arriving during an older IPC write therefore queues
  // one final pass that reads valueRef only after the older write has landed.
  const flushSaveRef = useRef<(() => Promise<void>) | null>(null)
  if (!flushSaveRef.current) flushSaveRef.current = createSerialFlush(() => saveRef.current())
  const flushSave = flushSaveRef.current

  useEffect(() => {
    const unregister = registerFileWriter(path, surfacePath, async () => {
      await flushSave()
      if (lastSaveErrorRef.current) throw lastSaveErrorRef.current
    })
    return () => {
      // Keep this writer discoverable until its last buffered/in-flight content has settled. Besides
      // closing the delete race, this prevents a tab switch from silently discarding Monaco's buffer.
      void flushSave().catch(() => {}).finally(unregister)
    }
  }, [path, surfacePath, flushSave])

  // The live editor instance, captured on mount so the gotoLine effect can drive it (the editor
  // mounts async, so a line requested before mount is applied here too).
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)

  function reveal(line?: number, column?: number): void {
    const ed = editorRef.current
    if (!ed || !line) return
    ed.revealLineInCenter(line)
    ed.setPosition({ lineNumber: line, column: column ?? 1 })
    ed.focus()
  }

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void flushSave())
    reveal(gotoLine, gotoColumn) // apply a location requested before the editor finished mounting
  }

  // Re-reveal when the target line changes, or when the same file is re-opened at a line (nonce).
  useEffect(() => {
    reveal(gotoLine, gotoColumn)
  }, [gotoLine, gotoColumn, gotoNonce])

  // The file changed on disk (FileSurfaceView re-read it → new `initialContent`). Swap it into the live
  // editor so the open file tracks the change, preserving cursor + scroll. Guards, both via refs so this
  // only reacts to a genuine disk change (not a save round-trip): skip if the user has unsaved edits
  // (never clobber their work), and skip if the new content already matches our baseline (nothing new).
  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return // pre-mount: `defaultValue` seeds the initial content
    if (valueRef.current !== baselineRef.current) return // unsaved user edits win
    if (initialContent === baselineRef.current) return // no real change on disk
    const model = ed.getModel()
    if (!model) return
    const pos = ed.getPosition()
    const top = ed.getScrollTop()
    baselineRef.current = initialContent // set before setValue so the onChange sees a clean (non-dirty) buffer
    valueRef.current = initialContent
    model.setValue(initialContent)
    if (pos) ed.setPosition(pos)
    ed.setScrollTop(top)
  }, [initialContent])

  return (
    <div className={`flex flex-col overflow-hidden ${className}`}>
      <div className="min-h-0 flex-1">
        <Editor
          path={path}
          language={languageFor(path)}
          defaultValue={initialContent}
          theme={monacoTheme}
          onChange={(v) => {
            valueRef.current = v ?? ''
            setDirty(valueRef.current !== baselineRef.current)
          }}
          onMount={onMount}
          options={{
            readOnly,
            wordWrap: 'on',
            minimap: { enabled: false },
            fontFamily: MONO_FONT || undefined,
            fontSize: codeFontSize,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            renderLineHighlight: 'line',
            padding: { top: 12, bottom: 12 },
          }}
        />
      </div>
      {(dirty || error || noUndo) && !readOnly && (
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-1.5">
          {error ? (
            <span className="truncate text-[11px] text-red-400">Couldn't save: {error}</span>
          ) : dirty ? (
            <span className="text-[11px] text-text-muted">Unsaved changes</span>
          ) : (
            <span role="status" className="truncate text-[11px] text-amber-600 dark:text-amber-400">
              Saved, but Koda couldn't add this to the recovery timeline.
            </span>
          )}
          {(dirty || error) && (
            <button
              onClick={() => void flushSave()}
              disabled={saving}
              className="shrink-0 rounded-lg bg-accent px-3 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default MonacoFileEditor
