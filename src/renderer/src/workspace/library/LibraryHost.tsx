import { useEffect, useState } from 'react'
import { Library } from './Library'
import { windowHasOpenModal } from '../../window-modal'

/**
 * Owns whether the Library is open, and the one keybinding that opens it. The open flag lives here
 * rather than in the workspace store because nothing else needs to read it, and `AnimatePresence`
 * belongs to whoever owns the flag.
 */

const OPEN_EVENT = 'koda:open-library'

/** Summon the Library from anywhere (a sidebar entry, a "browse documents" affordance) without
 *  importing the host or growing the store. */
export function openLibrary(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT))
}

export function LibraryHost() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      if (e.code !== 'KeyK' && e.key.toLowerCase() !== 'k') return
      // Monaco treats ⌘K as a chord prefix and a terminal forwards it to the shell, so a global
      // grab would quietly break both. Inside those two surfaces the key stays theirs; the Library
      // is still one click away everywhere else.
      const target = e.target as Element | null
      if (target?.closest?.('.monaco-editor, .xterm')) return
      e.preventDefault()
      setOpen((v) => (!v && windowHasOpenModal() ? v : !v))
    }
    function onOpen(): void {
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  // Mounted only while open, so every open is a fresh read and a clean autofocus. The close is
  // deliberately synchronous, with no exit animation: closing usually HANDS OFF to the Stage, and an
  // animated exit keeps the scrim over the surface it just opened while that surface is busy
  // mounting. Under a starved main thread the "brief" exit lingers whole seconds and eats the first
  // click on the freshly opened file.
  return <>{open && <Library onClose={() => setOpen(false)} />}</>
}
