import { useState } from 'react'
import type { ArchivedSession } from '@shared/ipc'
import { useWorkspace } from '../workspace/store'
import { Button } from '../ui'
import { SettingsSection } from './controls'
import { IconTrash } from './icons'

// The retrieval surface for sessions archived from the kebab. Archiving is non-destructive (the whole
// conversation is kept), so this is where it comes back from — restore reopens it as a live tab
// (reattaches via --resume on its next turn). Permanent delete lives here too, behind a small confirm.
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
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-[13.5px] font-medium text-text">{session.label}</div>
        <div className="mt-0.5 truncate text-[12px] text-text-muted">
          {folderOf(session.cwd)} · archived {timeAgo(session.archivedAt)}
        </div>
      </div>
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
  )
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
