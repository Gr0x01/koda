// Shared primitives used both by SourceControl.tsx and the sub-components it imports.
// Extracted here to break the import cycle: sub-components can't import from SourceControl.tsx
// because SourceControl.tsx imports them.
import { useState, type ReactNode } from 'react'
import type { GitStatusFile } from '@shared/ipc'

// ── Section chrome ────────────────────────────────────────────────────────────────────
export function Section({
  label,
  count,
  children,
}: {
  label: string
  count?: number
  children: ReactNode
}) {
  return (
    <div className="border-t border-border pt-2 pb-1 first:border-t-0">
      <div className="flex items-baseline gap-1.5 px-3 pb-1">
        <h3 className="font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {label}
        </h3>
        {count !== undefined && count > 0 && (
          <span className="text-[11px] tabular-nums text-text-muted/50">{count}</span>
        )}
      </div>
      {children}
    </div>
  )
}

// ── File list row ─────────────────────────────────────────────────────────────────────
export function FileButton({
  file,
  active,
  onClick,
  title,
  trailing,
  onDiscard,
}: {
  file: GitStatusFile
  active: boolean
  onClick: () => void
  title: string
  /** Optional right-aligned cue (e.g. "shown above ↑" tying the row to the staged diff). */
  trailing?: ReactNode
  /** When set, a hover-revealed discard control appears; returns error copy, or null on success. */
  onDiscard?: () => Promise<string | null>
}) {
  // Row is a container (not one big button) so the discard control can be its own click target next to
  // the name — a button can't nest inside a button. The name area keeps the whole diff-opening click.
  return (
    <div
      className={`group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-[13px] transition-colors ${
        active ? 'bg-surface text-text' : 'text-text-muted hover:bg-surface'
      }`}
    >
      <button
        onClick={onClick}
        title={title}
        className={`flex min-w-0 flex-1 items-center gap-2 text-left transition-colors ${
          active ? 'text-text' : 'hover:text-text'
        }`}
      >
        <StatusGlyph status={file.status} />
        <span className="min-w-0 flex-1 truncate">{basename(file.path)}</span>
      </button>
      {trailing}
      {onDiscard && <DiscardControl label={basename(file.path)} onDiscard={onDiscard} />}
    </div>
  )
}

// A quiet per-row discard: an ✕ that surfaces on row hover (or focus), a light inline "Discard? Yes /
// Keep" confirm (no modal — it's recoverable from the timeline), then a brief busy state. On failure it
// shows a retryable label rather than a toast. Success just lets the row vanish on the next git refresh.
function DiscardControl({
  label,
  onDiscard,
}: {
  label: string
  onDiscard: () => Promise<string | null>
}) {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'busy'>('idle')
  const [err, setErr] = useState<string | null>(null)

  async function run(): Promise<void> {
    setPhase('busy')
    setErr(null)
    const msg = await onDiscard()
    if (msg) {
      setErr(msg)
      setPhase('idle')
    }
    // success → the file leaves the changes list on refresh; this row unmounts, no reset needed.
  }

  if (phase === 'busy') {
    return <span className="shrink-0 text-[10px] text-text-muted">Removing…</span>
  }
  if (phase === 'confirm') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-[10px]">
        <span className="text-text-muted">Discard?</span>
        <button onClick={run} className="font-medium text-red-400 transition-colors hover:text-red-300">
          Yes
        </button>
        <button
          onClick={() => setPhase('idle')}
          className="text-text-muted transition-colors hover:text-text"
        >
          Keep
        </button>
      </span>
    )
  }
  if (err) {
    return (
      <button
        onClick={() => {
          setErr(null)
          setPhase('confirm')
        }}
        title={err}
        className="shrink-0 text-[10px] text-red-400 transition-colors hover:text-red-300"
      >
        Couldn't — retry
      </button>
    )
  }
  return (
    <button
      onClick={() => setPhase('confirm')}
      title={`Discard changes to ${label}`}
      aria-label={`Discard changes to ${label}`}
      className="shrink-0 rounded p-0.5 text-text-muted/60 opacity-0 transition-all hover:text-red-400 focus:opacity-100 group-hover:opacity-100"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  )
}

// ── Status glyph ──────────────────────────────────────────────────────────────────────
const GLYPH: Record<GitStatusFile['status'], { ch: string; cls: string; title: string }> = {
  modified: { ch: 'M', cls: 'text-amber-500', title: 'Modified' },
  added: { ch: 'A', cls: 'text-emerald-500', title: 'Added' },
  deleted: { ch: 'D', cls: 'text-red-500', title: 'Deleted' },
  renamed: { ch: 'R', cls: 'text-accent', title: 'Renamed' },
  untracked: { ch: 'U', cls: 'text-emerald-500', title: 'New (untracked)' },
  other: { ch: '•', cls: 'text-text-muted', title: 'Changed' },
}

export function StatusGlyph({ status }: { status: GitStatusFile['status'] }) {
  const g = GLYPH[status]
  return (
    <span
      className={`w-3 shrink-0 text-center font-mono text-[11px] font-semibold ${g.cls}`}
      title={g.title}
    >
      {g.ch}
    </span>
  )
}

// ── Path helpers ──────────────────────────────────────────────────────────────────────
export function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p
}

export function shortRoot(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p
}
