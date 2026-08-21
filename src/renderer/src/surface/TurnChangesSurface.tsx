import type { FileSurface } from '../workspace/store'
import { useWorkspace } from '../workspace/store'

/** Exact completed-turn evidence. Unlike Changes, this is read-only and remains truthful after the
 * agent commits: each row can open a safety-baseline diff rather than re-reading current Git dirt. */
export function TurnChangesSurface({ surface }: { surface: FileSurface }) {
  const openFile = useWorkspace((state) => state.openFile)
  const cwd = useWorkspace((state) =>
    surface.sessionId ? state.sessions[surface.sessionId]?.cwd : undefined,
  )
  const files = surface.receiptFiles ?? []

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <div className="text-[13px] font-medium text-text">Files changed this turn</div>
        <div className="mt-0.5 text-[11.5px] text-text-muted">
          {files.length} {files.length === 1 ? 'file' : 'files'} observed from the turn’s recovery point
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            onClick={() => {
              if (!cwd) return
              const diffSource =
                surface.receiptCheckpointId && surface.sessionId
                  ? {
                      kind: 'checkpoint' as const,
                      sessionId: surface.sessionId,
                      checkpointId: surface.receiptCheckpointId,
                      path: file.path,
                    }
                  : surface.sessionId
                    ? { kind: 'session' as const, sessionId: surface.sessionId }
                    : { kind: 'working-tree' as const }
              openFile(`${cwd.replace(/\/+$/, '')}/${file.path}`, undefined, {
                view: 'diff',
                diffSource,
              })
            }}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-text/5"
          >
            <span className={`w-4 shrink-0 font-mono text-[11px] ${STATUS_TONE[file.status]}`}>
              {STATUS_MARK[file.status]}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text">{file.path}</span>
            {!file.binary && (
              <span className="shrink-0 font-mono text-[10.5px] text-text-muted">
                <span className="text-emerald-500">+{file.additions}</span>{' '}
                <span className="text-red-400">−{file.deletions}</span>
              </span>
            )}
          </button>
        ))}
        {!surface.receiptComplete && (
          <p className="px-3 py-2 text-[11.5px] leading-relaxed text-amber-500">
            Koda could not prove the complete file set. The files it did observe are shown above.
          </p>
        )}
        {surface.receiptOverlapObserved && (
          <p className="px-3 py-2 text-[11.5px] leading-relaxed text-text-muted">
            Another live session also wrote in this workspace during the turn.
          </p>
        )}
      </div>
    </div>
  )
}

const STATUS_MARK = { added: 'A', modified: 'M', deleted: 'D' } as const
const STATUS_TONE = {
  added: 'text-emerald-500',
  modified: 'text-amber-500',
  deleted: 'text-red-400',
} as const
