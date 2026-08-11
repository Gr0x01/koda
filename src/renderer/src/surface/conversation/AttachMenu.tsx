import { useEffect, useRef, useState } from 'react'
import { Menu } from '../../motion'
import { refusedAttachmentMessage, stagingFromFiles, type StagedAttachment } from './attach'

/* ── The composer's + menu ────────────────────────────────────────────────────────────────────
 * Two ways to hand the agent a file without dragging it in:
 *   Attach a file…            → native picker; bytes come back from main and are staged exactly
 *                               like a drop (images compressed, csv/pdf raw + named).
 *   Point at files or folders… → nothing is copied — the chosen absolute paths land in the draft
 *                               as references the agent reads in place. For things that live
 *                               where they are (a folder of data, a big export). */
export function AttachMenu({
  onAttach,
  onInsertPaths,
  onRefused,
}: {
  onAttach: (staged: StagedAttachment[]) => void
  onInsertPaths: (paths: string[]) => void
  /** Copy for anything the pick couldn't attach (null when it was all fine) — the composer shows it. */
  onRefused: (message: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Click-out closes (Escape is handled by <Menu onClose>).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  async function pickFiles(): Promise<void> {
    setOpen(false)
    const { files } = await window.koda.pickComposerFiles()
    if (!files.length) return
    // Rebuild File objects so picked images run through the same downscale pipeline as a drop.
    const fileObjs = files.map(
      (f) =>
        new File([Uint8Array.from(atob(f.dataBase64), (c) => c.charCodeAt(0))], f.name, {
          type: f.mediaType,
        }),
    )
    onRefused(refusedAttachmentMessage(fileObjs))
    const staged = await stagingFromFiles(fileObjs)
    if (staged.length) onAttach(staged)
  }

  async function pickPath(): Promise<void> {
    setOpen(false)
    const { paths } = await window.koda.pickComposerPath()
    if (paths.length) onInsertPaths(paths)
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Attach"
        aria-label="Attach"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
          open ? 'bg-surface text-text' : 'text-text-muted hover:bg-surface hover:text-text'
        }`}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        origin="origin-bottom-right"
        className="absolute bottom-full right-0 z-10 mb-1.5 w-60 rounded-lg border border-border bg-surface py-1 shadow-pop"
      >
        <MenuRow
          label="Attach a file…"
          hint="Images, CSV, PDF"
          onClick={() => void pickFiles()}
          icon={
            <path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48" />
          }
        />
        <MenuRow
          label="Point at files or folders…"
          hint="Referenced in place, not copied"
          onClick={() => void pickPath()}
          icon={
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          }
        />
      </Menu>
    </div>
  )
}

function MenuRow({
  label,
  hint,
  icon,
  onClick,
}: {
  label: string
  hint: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-bg"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-text-muted"
        aria-hidden
      >
        {icon}
      </svg>
      <span className="min-w-0">
        <span className="block text-xs text-text">{label}</span>
        <span className="block text-[11px] text-text-muted">{hint}</span>
      </span>
    </button>
  )
}
