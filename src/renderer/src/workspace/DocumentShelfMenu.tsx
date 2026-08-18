import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Menu, Overlay } from '../motion'

export type DocumentMenuTarget = {
  rel: string
  path: string
  title: string
  available: boolean
  trigger: HTMLElement | null
  x: number
  y: number
}

export function DocumentContextMenu({
  open,
  target,
  onClose,
  onOpen,
  onReveal,
  onUnstar,
  onDelete,
}: {
  open: boolean
  target: DocumentMenuTarget
  onClose: () => void
  onOpen: () => void
  onReveal: () => void
  onUnstar: () => void
  onDelete: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  const restoreFocus = useRef(true)
  const [pos, setPos] = useState({ x: target.x, y: target.y })

  useLayoutEffect(() => {
    if (!open || !ref.current) return
    const pad = 8
    const el = ref.current
    setPos({
      x: Math.max(pad, Math.min(target.x, window.innerWidth - el.offsetWidth - pad)),
      y: Math.max(pad, Math.min(target.y, window.innerHeight - el.offsetHeight - pad)),
    })
  }, [open, target.x, target.y])

  useEffect(() => {
    if (!open) return
    wasOpen.current = true
    restoreFocus.current = true
    const frame = requestAnimationFrame(() =>
      ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(),
    )
    const close = (): void => onClose()
    const onDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open, onClose])

  useEffect(() => {
    if (open || !wasOpen.current) return
    wasOpen.current = false
    if (restoreFocus.current && target.trigger?.isConnected) target.trigger.focus()
  }, [open, target.trigger])

  function close(restore = true): void {
    restoreFocus.current = restore
    onClose()
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    )
    if (!items.length) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const next = event.shiftKey
        ? (index - 1 + items.length) % items.length
        : (index + 1 + items.length) % items.length
      items[next]?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowUp'
            ? (index - 1 + items.length) % items.length
            : (index + 1 + items.length) % items.length
    items[next]?.focus()
  }

  return createPortal(
    <Menu
      open={open}
      onClose={() => close()}
      origin="origin-top-left"
      style={{ position: 'fixed', left: pos.x, top: pos.y }}
      className="z-50 w-44 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-pop"
    >
      <div
        ref={ref}
        role="menu"
        aria-label={`Actions for ${target.title}`}
        onKeyDown={onMenuKeyDown}
        onContextMenu={(event) => event.preventDefault()}
      >
        {target.available && (
          <>
            <DocumentMenuItem label="Open" onClick={onOpen} onClose={() => close()} />
            <DocumentMenuItem label="Reveal in Finder" onClick={onReveal} onClose={() => close()} />
            <div role="separator" className="my-1 border-t border-border" />
          </>
        )}
        <DocumentMenuItem label="Unstar" onClick={onUnstar} onClose={() => close(false)} />
        {target.available && (
          <DocumentMenuItem
            label="Delete document…"
            danger
            onClick={onDelete}
            onClose={() => close(false)}
          />
        )}
      </div>
    </Menu>,
    document.body,
  )
}

function DocumentMenuItem({
  label,
  danger = false,
  onClick,
  onClose,
}: {
  label: string
  danger?: boolean
  onClick: () => void
  onClose: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onClose()
        onClick()
      }}
      className={`block w-full px-3 py-1.5 text-left text-[12px] outline-none transition-colors hover:bg-bg focus-visible:bg-bg ${
        danger ? 'text-red-400' : 'text-text'
      }`}
    >
      {label}
    </button>
  )
}

/** Destructive, so deletion is confirmed; main refuses the delete unless it can first make the undo
 *  point promised here. */
export function DocumentDeleteConfirm({
  target,
  onCancel,
  onConfirm,
}: {
  target: Pick<DocumentMenuTarget, 'path' | 'title' | 'trigger'>
  onCancel: () => void
  onConfirm: () => Promise<string | null>
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cancel = useCallback((): void => {
    if (busy) return
    onCancel()
    requestAnimationFrame(() => {
      if (target.trigger?.isConnected) target.trigger.focus()
    })
  }, [busy, onCancel, target.trigger])

  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault()
        cancel()
      } else if (e.key === 'Tab') {
        const first = cancelRef.current
        const last = deleteRef.current
        if (!first || !last) return
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, cancel])

  async function remove(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const nextError = await onConfirm()
      if (!nextError) return
      setError(nextError)
      setBusy(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't delete the document.")
      setBusy(false)
    }
  }

  return (
    <Overlay
      onDismiss={() => {
        cancel()
      }}
      align="center"
      className="w-[320px] rounded-xl border border-border bg-bg p-4 shadow-pop"
    >
      <div role="dialog" aria-modal="true" aria-labelledby="delete-document-heading">
        <h2 id="delete-document-heading" className="text-sm font-medium text-text">
          Delete “{target.title}”?
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-text-muted">
          Koda makes an undo point first, so you can recover the document later.
        </p>
        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={cancel}
            className="rounded-md px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface hover:text-text disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            ref={deleteRef}
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            className="rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
          >
            {busy ? 'Deleting…' : 'Delete document'}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
