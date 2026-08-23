import { useEffect, useRef } from 'react'
import { Overlay } from '../../motion'
import { useWorkspace } from '../store'
import { LibraryPanel } from './LibraryPanel'

/**
 * The Library overlay: the panel plus the chrome that summons it. Summoned, used and left, in the
 * same spirit as the Find overlay, because the reader is here to get to a document rather than to
 * live in a browser.
 *
 * Opening routes through the store's `openFile`, so the Stage remains the single owner of what is
 * open: the Library never mounts a surface, tracks a tab, or holds a second idea of the active
 * document. It reads main and hands off a path.
 */

/** Everything a Tab can land on, minus the things that would swallow it. `:not([disabled])` matters
 *  in the ask view, where the Ask button is disabled until a question is typed and would otherwise be
 *  the last stop Shift+Tab dead-ends on. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])'

export function Library({ onClose }: { onClose: () => void }) {
  const openFile = useWorkspace((s) => s.openFile)
  const newDocument = useWorkspace((s) => s.newDocument)
  const filesRev = useWorkspace((s) => s.filesRev)
  const activeId = useWorkspace((s) => s.activeId)
  const starredRels = useWorkspace((s) => s.starredDocs)
  const starDoc = useWorkspace((s) => s.starDoc)
  const unstarDoc = useWorkspace((s) => s.unstarDoc)
  // Snapshot the owner at launch. A background phone action may switch/archive the active chat while
  // the modal is open; an ask must never follow that mutation onto another engine or billing path.
  const modalSessionId = useRef(useWorkspace.getState().activeId).current
  const dialogRef = useRef<HTMLElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)

  // Asking is session-scoped even though starring is project-wide. If a phone action switches or
  // archives the launch owner, close before a later Ask can mutate the replacement chat. Reopening
  // gives the new active chat a fresh snapshot.
  useEffect(() => {
    if (activeId !== modalSessionId) onClose()
  }, [activeId, modalSessionId, onClose])

  // `aria-modal` claims the rest of the window is unreachable, so it has to actually be. The overlay
  // renders inline in the chassis rather than through a portal, so the background is every OTHER child
  // of the scrim's parent: each is marked inert (which also takes it out of the accessibility tree)
  // for exactly as long as the Library is open, and put back the way it was found, since another
  // overlay may have marked it first.
  useEffect(() => {
    const self = scrimRef.current
    const parent = self?.parentElement
    if (!self || !parent) return
    const background = Array.from(parent.children).filter(
      (el): el is HTMLElement => el !== self && el instanceof HTMLElement,
    )
    const wasInert = background.map((el) => el.inert)
    for (const el of background) el.inert = true
    return () => {
      background.forEach((el, i) => (el.inert = wasInert[i]))
    }
  }, [])

  // Focus goes back where it came from on close. Without this, dismissing with Escape leaves
  // `activeElement` on `<body>` and the next Tab restarts from the top of the window — a keyboard user
  // loses their place every time they glance at the Library.
  //
  // Read during render, not in an effect: effects flush bottom-up, so by the time this component's own
  // effects run, LibraryPanel has already focused the search box and the opener is no longer knowable
  // from the DOM. This is the lazy-ref-initialization form (`if (ref.current === null)`), so a
  // StrictMode double-render captures once.
  const opener = useRef<Element | null>(null)
  if (opener.current === null) opener.current = document.activeElement
  useEffect(() => {
    const at = opener.current
    return () => {
      if (at instanceof HTMLElement && at.isConnected) at.focus()
    }
  }, [])

  // Escape closes from anywhere inside (the search box is not the only thing focusable), and Tab cycles
  // within the dialog instead of walking off into the workspace behind it.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const root = dialogRef.current
      if (!root) return
      // A hidden stop is still in the DOM (a collapsed panel, a row scrolled out of an
      // `overflow:hidden` box), and focusing one moves focus somewhere the user cannot see.
      const stops = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      )
      const first = stops[0]
      const last = stops[stops.length - 1]
      if (!first || !last) return
      const at = document.activeElement
      if (e.shiftKey && (at === first || !root.contains(at))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && at === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // The height is FIXED, not a max. Sized to its content the window resized and re-centred on every
  // filter click, so the chips and the search box moved out from under the pointer still using them.
  // Filtering changes what the list holds, never the frame it sits in.
  return (
    <Overlay
      onDismiss={onClose}
      align="start"
      scrimRef={scrimRef}
      className="flex h-[min(720px,78vh)] w-[min(1000px,94vw)] flex-col overflow-hidden rounded-2xl border border-border bg-bg shadow-soft"
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-heading"
        className="flex min-h-0 flex-1 flex-col"
      >
        <LibraryPanel
          onOpenPath={(path, line, asCode) => {
            openFile(path, line, asCode ? { view: 'file' } : undefined)
            onClose()
          }}
          onNewDocument={async () => {
            await newDocument()
            onClose()
          }}
          onClose={onClose}
          revision={filesRev}
          askingSessionId={modalSessionId}
          starredRels={starredRels}
          onToggleStarred={(rel) => (starredRels.includes(rel) ? unstarDoc(rel) : starDoc(rel))}
        />
      </section>
    </Overlay>
  )
}
