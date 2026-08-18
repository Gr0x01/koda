import { useEffect, useState } from 'react'
import type { ArchivedSessionMeta } from '@shared/ipc'
import { useWorkspace } from '../workspace/store'
import { Button } from '../ui'
import { SegmentedControl, SettingsNote, SettingsRow, SettingsSection } from './controls'
import { IconTrash } from './icons'
import { Caret } from '../Caret'

// How long an archived chat is kept before it's auto-deleted. Default 'Forever' (value 0): archives live
// outside the undo history, so a purge can't be undone — the safe default never deletes, and short
// windows are opt-in for people who don't want old chats piling up.
const RETENTION_OPTIONS: { value: string; label: string; title: string }[] = [
  { value: '0', label: 'Forever', title: "Never auto-deleted. You'll manage them yourself." },
  { value: '7', label: '7 days', title: 'Delete archived chats after a week' },
  { value: '30', label: '30 days', title: 'Delete archived chats after a month' },
  { value: '90', label: '90 days', title: 'Delete archived chats after three months' },
]

// The retrieval surface for sessions archived from the kebab. Archiving is non-destructive (the whole
// conversation is kept), so this is where it comes back from — restore reopens it as a live tab
// (reattaches via --resume on its next turn). Permanent delete lives here too, behind a small confirm.
//
// A row expands to preview the tail of the conversation (the last few turns) — just enough to recognize
// which chat this was before restoring it. That's all an archived chat needs; "what files it changed" is
// Recovery's job, not this. The preview is baked into the archive metadata, so the list never loads the
// (cold-stored) transcript body — only Restore does.
export function ArchivedSection() {
  const archived = useWorkspace((s) => s.archived)
  const restoreArchived = useWorkspace((s) => s.restoreArchived)
  const deleteArchived = useWorkspace((s) => s.deleteArchived)
  const setSettingsOpen = useWorkspace((s) => s.setSettingsOpen)

  const [retentionDays, setRetentionDays] = useState<number | null>(null)
  useEffect(() => {
    window.koda.getSettings().then((s) => setRetentionDays(s.archiveRetentionDays)).catch(console.error)
  }, [])
  const changeRetention = (next: string): void => {
    const days = Number(next)
    setRetentionDays(days)
    window.koda.updateSettings({ archiveRetentionDays: days }).catch(console.error) // applied on next load
  }

  return (
    <SettingsSection
      title="Archived sessions"
      note="An archived chat keeps its whole conversation and sits outside the undo history, so deleting one is permanent."
    >
      <SettingsRow
        label="Delete old archived chats"
        description="How long an archived chat is kept before Koda deletes it for good."
        control={
          <SegmentedControl
            ariaLabel="Delete old archived chats"
            value={String(retentionDays ?? 0)}
            options={RETENTION_OPTIONS}
            onChange={changeRetention}
          />
        }
      />
      {archived.length === 0 ? (
        <SettingsNote>
          Sessions you archive land here, and Restore reopens one where you left off.
        </SettingsNote>
      ) : (
        archived.map((a) => (
          <ArchivedRow
            key={a.id}
            session={a}
            onRestore={() => {
              void restoreArchived(a.id)
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
  session: ArchivedSessionMeta
  onRestore: () => void
  onDelete: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [open, setOpen] = useState(false)
  const preview = session.preview ?? []

  return (
    <div className="py-3">
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
            <span className="mt-1 block truncate text-[12.5px] text-text-muted">
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
