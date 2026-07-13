import { useMemo, useState } from 'react'
import type { ArchivedSession } from '@shared/ipc'
import type { Entry } from '../transcript/types'
import { useWorkspace } from '../workspace/store'
import { Button } from '../ui'
import { SettingsSection } from './controls'
import { IconTrash } from './icons'
import { Caret } from '../Caret'

// The retrieval surface for sessions archived from the kebab. Archiving is non-destructive (the whole
// conversation is kept), so this is where it comes back from — restore reopens it as a live tab
// (reattaches via --resume on its next turn). Permanent delete lives here too, behind a small confirm.
//
// A row expands to preview the tail of the conversation (the last few turns) — just enough to recognize
// which chat this was before restoring it. That's all an archived chat needs; "what files it changed" is
// Recovery's job, not this. The transcript is already stored in the archive blob, so the preview is free.
export function ArchivedSection() {
  const archived = useWorkspace((s) => s.archived)
  const restoreArchived = useWorkspace((s) => s.restoreArchived)
  const deleteArchived = useWorkspace((s) => s.deleteArchived)
  const setSettingsOpen = useWorkspace((s) => s.setSettingsOpen)

  return (
    <SettingsSection title="Archived sessions">
      {archived.length === 0 ? (
        <div className="px-4 py-4 text-[12.5px] leading-snug text-text-muted">
          Sessions you archive land here. Nothing is deleted. Restore one any time to pick up where you
          left off.
        </div>
      ) : (
        archived.map((a) => (
          <ArchivedRow
            key={a.id}
            session={a}
            onRestore={() => {
              restoreArchived(a.id)
              setSettingsOpen(false) // jump back to the now-open session
            }}
            onDelete={() => deleteArchived(a.id)}
          />
        ))
      )}
    </SettingsSection>
  )
}

function ArchivedRow({
  session,
  onRestore,
  onDelete,
}: {
  session: ArchivedSession
  onRestore: () => void
  onDelete: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [open, setOpen] = useState(false)
  const preview = useMemo(() => previewTurns(session.items), [session.items])

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        {/* The label toggles the preview; the caret shows there's more to see. */}
        <button
          onClick={() => setOpen((o) => !o)}
          title={preview.length ? 'Preview the last few messages' : 'No messages to preview'}
          className="group flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Caret
            dir={open ? 'down' : 'right'}
            size={12}
            className="text-text-muted/50 group-hover:text-text-muted"
          />
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-medium text-text">{session.label}</span>
            <span className="mt-0.5 block truncate text-[12px] text-text-muted">
              {folderOf(session.cwd)} · archived {timeAgo(session.archivedAt)}
            </span>
          </span>
        </button>
        {confirmDelete ? (
          <span className="flex shrink-0 items-center gap-2.5 text-[12px]">
            <button
              onClick={onDelete}
              title="Delete this conversation permanently"
              className="font-medium text-red-500 transition-colors hover:text-red-400"
            >
              Delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-text-muted transition-colors hover:text-text"
            >
              Cancel
            </button>
          </span>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="secondary" onClick={onRestore}>Restore</Button>
            <button
              onClick={() => setConfirmDelete(true)}
              title="Delete permanently"
              aria-label="Delete permanently"
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg hover:text-red-500"
            >
              <IconTrash />
            </button>
          </div>
        )}
      </div>

      {open && (
        <div className="ml-6 mt-2.5 max-h-72 space-y-3 overflow-y-auto rounded-lg bg-bg/60 px-3.5 py-3">
          {preview.length === 0 ? (
            <p className="text-[12px] text-text-muted">This chat has no messages to preview.</p>
          ) : (
            preview.map((t, i) => (
              <div key={i}>
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted/55">
                  {t.kind === 'user' ? 'You' : 'Koda'}
                </div>
                <div className="line-clamp-4 whitespace-pre-wrap text-[12px] leading-relaxed text-text-muted">
                  {t.text}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** The last few readable turns (user prompts + assistant replies) from a stored transcript — enough to
 *  recognize the chat. Tool/thinking/workflow plumbing is skipped; `items` is opaque to main so it's
 *  cast to the renderer's Entry model here. */
function previewTurns(items: unknown[]): { kind: 'user' | 'assistant'; text: string }[] {
  const turns: { kind: 'user' | 'assistant'; text: string }[] = []
  for (const it of items as Entry[]) {
    if (it?.kind === 'user' && it.text?.trim()) turns.push({ kind: 'user', text: it.text.trim() })
    else if (it?.kind === 'assistant' && it.markdown?.trim())
      turns.push({ kind: 'assistant', text: it.markdown.trim() })
  }
  return turns.slice(-6) // just the tail
}

/** Last path segment of the project dir, for a compact "where this ran" line. */
function folderOf(cwd: string): string {
  return cwd.replace(/\/+$/, '').split('/').pop() || cwd
}

/** A coarse "x ago" phrase from an epoch-ms stamp — just enough to order/age the list. */
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d}d ago`
}
