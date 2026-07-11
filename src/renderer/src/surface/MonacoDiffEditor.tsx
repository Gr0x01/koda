import { useEffect, useRef } from 'react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { monaco } from './monaco-setup' // wires the bundled, CSP-safe workers + the local (non-CDN) monaco loader
import { languageFor, MONO_FONT } from './monaco-lang'
import { useTheme } from '../theme'
import { useTextSize } from '../text-size'

/**
 * The diff body — Monaco's side-by-side DiffEditor showing `before` (safety-git HEAD, pre-edit) vs
 * `after` (current file). Read-only: this is for *watching* a change, not editing it (flip to the
 * File view to edit). Lazy-loaded so `monaco-editor` stays out of the conversation-only bundle.
 *
 * Driven imperatively rather than through `@monaco-editor/react`'s <DiffEditor> so we own the
 * disposal ORDER: the widget is torn down before its text models. The wrapper disposes models
 * first, which — under React StrictMode's mount→unmount→remount in dev — throws
 * "TextModel got disposed before DiffEditorWidget model got reset" and left the diff pane blank.
 */
export function MonacoDiffEditor({
  path,
  before,
  after,
  className = '',
}: {
  path: string
  before: string
  after: string
  className?: string
}) {
  const { monacoTheme } = useTheme()
  const { codeFontSize } = useTextSize()
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null)
  const modelsRef = useRef<{
    original: MonacoEditor.ITextModel
    modified: MonacoEditor.ITextModel
  } | null>(null)

  // Create the diff editor once. Cleanup disposes the widget first (which detaches its models),
  // then the models — the safe order monaco requires.
  useEffect(() => {
    if (!containerRef.current) return
    const ed = monaco.editor.createDiffEditor(containerRef.current, {
      readOnly: true,
      renderSideBySide: true,
      wordWrap: 'on',
      minimap: { enabled: false },
      fontFamily: MONO_FONT || undefined,
      fontSize: codeFontSize,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      padding: { top: 12, bottom: 12 },
      theme: monacoTheme,
    })
    editorRef.current = ed
    return () => {
      ed.dispose()
      modelsRef.current?.original.dispose()
      modelsRef.current?.modified.dispose()
      modelsRef.current = null
      editorRef.current = null
    }
    // Options seeded here re-sync via the effects below; recreating the editor on every change
    // would defeat the whole point (it's the churn that triggered the dispose race).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Swap in fresh models whenever the content or file (→ language) changes. Old models are detached
  // by setModel before we dispose them, so the "disposed before reset" throw can't happen.
  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return
    const language = languageFor(path)
    const original = monaco.editor.createModel(before, language)
    const modified = monaco.editor.createModel(after, language)
    ed.setModel({ original, modified })
    modelsRef.current?.original.dispose()
    modelsRef.current?.modified.dispose()
    modelsRef.current = { original, modified }
  }, [path, before, after])

  useEffect(() => {
    monaco.editor.setTheme(monacoTheme)
  }, [monacoTheme])

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: codeFontSize })
  }, [codeFontSize])

  return <div ref={containerRef} className={`min-h-0 ${className}`} />
}

export default MonacoDiffEditor
