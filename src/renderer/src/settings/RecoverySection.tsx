import { Fragment, Suspense, useCallback, useEffect, useState } from 'react'
import type { Checkpoint, ChangedFile, SafetyChangesResult, SafetyFileDiffResult } from '@shared/ipc'
import { useWorkspace } from '../workspace/store'
import { Button, lazyWithRetry } from '../ui'

// Reuse the live-edits diff body (lazy — keeps monaco out of the settings bundle until shown).
const MonacoDiffEditor = lazyWithRetry(() => import('../surface/MonacoDiffEditor'))

/**
 * Settings → Recovery (dual-git.md §2, the "advanced — the human *can*" door). Safety-git's timeline,
 * project-scoped, with the thing a bare name can't give you: for a save point, exactly **what going
 * back would undo** — a changed-file list and a real before→after diff. So "go back" is an informed
 * choice, not a leap from a label. The everyday recovery door stays the agent offering it in chat;
 * this is where you look for yourself.
 *
 * Three columns: the timeline, the selected point's changed files, and the chosen file's diff.
 */
export function RecoverySection() {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedCp, setSelectedCp] = useState<string | null>(null)

  // A restore rewinds the project's working tree — never do it while ANY session on this project is
  // mid-turn (the engine could write a stale buffer back over restored files; dual-git.md §6).
  const busy = useWorkspace((s) => Object.values(s.sessions).some((sess) => sess.busy))
  const noteRestored = useWorkspace((s) => s.noteRestored)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      // Show only the moments the user navigates by (turns, manual edits, recovery markers). The
      // per-tool 'step' snapshots stay in safety-git for fine restore but would flood the timeline
      // with dozens of near-identical "before Edit: …" points — noise for a non-engineer.
      const all = await window.koda.listCheckpoints()
      setCheckpoints(all.filter((c) => c.kind !== 'step'))
    } catch (err) {
      setError('Could not load your history.')
      console.error('listCheckpoints failed', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="flex h-full min-h-0">
      {/* Timeline */}
      <Timeline
        checkpoints={checkpoints}
        loading={loading}
        error={error}
        selectedCp={selectedCp}
        onSelect={setSelectedCp}
      />

      {/* Selected point — changes + restore + diff */}
      {selectedCp ? (
        <CheckpointDetail
          key={selectedCp}
          checkpoint={checkpoints.find((c) => c.id === selectedCp)!}
          busy={busy}
          onRestored={(label) => {
            noteRestored(label)
            setSelectedCp(null)
            void refresh()
          }}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center px-8">
          <p className="max-w-xs text-center text-sm text-text-muted">
            Select a save point on the left to see what changed since then.
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * The "Ledger" timeline (design: .koda/scratch/backups-ledger.html, A′). A calm one-line-per-point
 * list — title left, time + a tick on an implied right rail. The rail earns its keep on hover:
 * pointing at a past point lights the ticks for every change that "going back" there would rewind
 * (the rows more recent than it), and the header hint spells out the span. So choosing a point to
 * return to is informed by *how far back it reaches*, before you open it.
 */
function Timeline({
  checkpoints,
  loading,
  error,
  selectedCp,
  onSelect,
}: {
  checkpoints: Checkpoint[]
  loading: boolean
  error: string | null
  selectedCp: string | null
  onSelect: (id: string) => void
}) {
  // Which row the pointer is on (newest-first index), or null when not hovering.
  const [hover, setHover] = useState<number | null>(null)
  // The lit span is driven by the SELECTED point and previewed by hover: selecting one keeps its
  // span lit while you inspect its "changes you'd undo" on the right, and hover temporarily shows a
  // different point's reach on top. Fall back to the selection when the pointer leaves the list.
  const selectedIdx = selectedCp ? checkpoints.findIndex((c) => c.id === selectedCp) : -1
  const active = hover ?? (selectedIdx >= 0 ? selectedIdx : null)
  const hint =
    active === null ? null : active === 0 ? "You're at the latest point" : `Going back undoes your last ${active} save point${active > 1 ? 's' : ''}`

  return (
    <div className="flex w-80 shrink-0 flex-col border-r border-border">
      <div className="px-4 pb-3 pt-5">
        <h2 className="px-1 font-display text-sm font-semibold text-text">Recovery</h2>
        <p className="mt-1 px-1 text-xs leading-relaxed text-text-muted">
          Save points Koda kept as you worked. Hover a point to see what going back would undo, then
          pick one. Going back is reversible, because your current work is saved first.
        </p>
        {/* Live span hint — reserved height so the list never jumps as it appears/updates. */}
        <div className="mt-2 min-h-[16px] px-1 text-[11px] leading-4">
          {hint && (
            <span className={active === 0 ? 'text-text-muted' : 'text-accent'}>{hint}</span>
          )}
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
        onMouseLeave={() => setHover(null)}
      >
        {loading ? (
          <p className="px-1 text-xs text-text-muted">Loading…</p>
        ) : error && checkpoints.length === 0 ? (
          <p className="px-1 text-xs text-red-400">{error}</p>
        ) : checkpoints.length === 0 ? (
          <p className="px-1 text-xs text-text-muted">No save points yet. They appear as you work.</p>
        ) : (
          <ul className="flex flex-col">
            {checkpoints.map((cp, i) => {
              const bucket = dayBucket(cp.createdAt)
              const showBreak = i === 0 || bucket !== dayBucket(checkpoints[i - 1].createdAt)
              return (
                <Fragment key={cp.id}>
                  {showBreak && <DayBreak label={bucket} first={i === 0} />}
                  <LedgerRow
                    cp={cp}
                    latest={i === 0}
                    selected={cp.id === selectedCp}
                    inSpan={active !== null && i < active}
                    landing={active === i}
                    onSelect={() => onSelect(cp.id)}
                    onHover={() => setHover(i)}
                  />
                </Fragment>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

function DayBreak({ label, first }: { label: string; first: boolean }) {
  return (
    <li className={`flex items-center gap-2.5 px-3 pb-1.5 ${first ? 'pt-1' : 'pt-3'}`}>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted/80">
        {label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </li>
  )
}

function LedgerRow({
  cp,
  latest,
  selected,
  inSpan,
  landing,
  onSelect,
  onHover,
}: {
  cp: Checkpoint
  latest: boolean
  selected: boolean
  inSpan: boolean // a more-recent change that going back to the hovered point would rewind
  landing: boolean // the hovered point itself — where you'd land
  onSelect: () => void
  onHover: () => void
}) {
  // Tick on the implied rail: landing = solid accent anchor, in-span = accent, latest = the
  // brightened "present" mark, else the quiet default. Span states win over the resting look.
  const tick = landing
    ? 'w-5 bg-accent'
    : inSpan
      ? 'w-4 bg-accent/60'
      : latest
        ? 'w-5 bg-text'
        : 'w-4 bg-border'
  const when = landing || inSpan ? 'text-accent' : latest ? 'text-text' : 'text-text-muted'
  // The title joins the span so a hovered run reads as one block — the whole stretch that going
  // back would rewind lights up together (title + time + rail), not just the ticks.
  const title = inSpan || landing || selected || latest ? 'text-text' : 'text-text-muted'

  return (
    <li>
      <button
        onClick={onSelect}
        onMouseEnter={onHover}
        onFocus={onHover}
        className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
          selected ? 'bg-accent/10' : 'hover:bg-surface'
        }`}
      >
        <span className={`min-w-0 flex-1 truncate text-[13px] transition-colors group-hover:text-text ${title}`}>
          {describe(cp).label}
        </span>
        <span className={`shrink-0 text-[11px] tabular-nums transition-colors ${when}`}>
          {relativeTime(cp.createdAt)}
        </span>
        <span className={`h-[2px] shrink-0 rounded-full transition-colors ${tick}`} />
      </button>
    </li>
  )
}

/**
 * Group label for a checkpoint's day, relative to now: Today / Yesterday / a weekday within the
 * last week / else a short date. Drives the inline hairline breaks so a long list stays scannable
 * without heavy per-day headers.
 */
function dayBucket(unixSeconds: number): string {
  const now = new Date()
  const d = new Date(unixSeconds * 1000)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfToday - startOfDay) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
  return d.toLocaleDateString(undefined, opts)
}

// ── The selected checkpoint: what you'd undo + the diff + go-back ─────────────────────
function CheckpointDetail({
  checkpoint,
  busy,
  onRestored,
}: {
  checkpoint: Checkpoint
  busy: boolean
  onRestored: (label: string) => void
}) {
  const [changes, setChanges] = useState<SafetyChangesResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setActiveFile(null)
    window.koda
      .checkpointChanges({ checkpointId: checkpoint.id })
      .then((c) => {
        if (!alive) return
        setChanges(c)
        setActiveFile(c.files[0]?.path ?? null) // auto-open the first file's diff
      })
      .catch((err) => {
        if (alive) setError('Could not load the changes.')
        console.error('checkpointChanges failed', err)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [checkpoint.id])

  async function goBack(): Promise<void> {
    if (busy || restoring) return
    setRestoring(true)
    setError(null)
    try {
      await window.koda.restoreCheckpoint({ checkpointId: checkpoint.id })
      onRestored(describe(checkpoint).plain)
    } catch (err) {
      setError('Could not go back. Your files were not changed.')
      console.error('restoreCheckpoint failed', err)
      setRestoring(false)
    }
  }

  const fileCount = changes?.files.length ?? 0

  return (
    <div className="flex min-w-0 flex-1">
      {/* Changes list + restore */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="border-b border-border px-4 py-4">
          <p className="text-[11px] uppercase tracking-wider text-text-muted">
            {relativeTime(checkpoint.createdAt)}
          </p>
          <p className="mt-0.5 text-sm text-text">{describe(checkpoint).label}</p>

          {confirming ? (
            <div className="mt-3 rounded-lg border border-border bg-surface p-2.5">
              <p className="text-xs leading-relaxed text-text-muted">
                This undoes everything since this point. Your current work is saved first, so you can
                undo the undo.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Button variant="primary" size="sm" disabled={busy || restoring} onClick={goBack}>
                  {restoring ? 'Going back…' : 'Yes, go back'}
                </Button>
                <Button variant="ghost" size="sm" disabled={restoring} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => setConfirming(true)}
              title={busy ? 'Wait for the agent to finish first' : undefined}
              className="mt-3 w-full"
            >
              Go back to here
            </Button>
          )}
          {busy && !confirming && (
            <p className="mt-1.5 text-[11px] text-text-muted">Wait for the agent to finish before going back.</p>
          )}
          {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
        </div>

        <div className="px-4 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            {fileCount > 0 ? `Changes you'd undo · ${fileCount}` : 'Changes you’d undo'}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {loading ? (
            <p className="px-2 text-xs text-text-muted">Loading…</p>
          ) : fileCount === 0 ? (
            <p className="px-2 text-xs text-text-muted">
              Nothing changed since this point. It matches your project now.
            </p>
          ) : (
            <>
              <ul className="flex flex-col">
                {changes!.files.map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    active={f.path === activeFile}
                    onSelect={() => setActiveFile(f.path)}
                  />
                ))}
              </ul>
              {changes!.truncated && (
                <p className="px-2 py-1 text-[11px] text-text-muted/70">+ more files not shown.</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Diff of the chosen file */}
      <div className="min-w-0 flex-1">
        {activeFile ? (
          <FileDiff checkpointId={checkpoint.id} path={activeFile} />
        ) : (
          <div className="flex h-full items-center justify-center px-8">
            <p className="text-sm text-text-muted">
              {fileCount === 0 ? 'No changes to show.' : 'Select a file to see what changed.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function FileRow({
  file,
  active,
  onSelect,
}: {
  file: ChangedFile
  active: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        onClick={onSelect}
        title={file.path}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
          active ? 'bg-surface text-text' : 'text-text-muted hover:bg-surface/60'
        }`}
      >
        <StatusGlyph status={file.status} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{basename(file.path)}</span>
        {!file.binary && (file.additions > 0 || file.deletions > 0) && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums">
            {file.additions > 0 && <span className="text-emerald-500">+{file.additions}</span>}
            {file.deletions > 0 && <span className="ml-1 text-red-500">−{file.deletions}</span>}
          </span>
        )}
      </button>
    </li>
  )
}

function FileDiff({ checkpointId, path }: { checkpointId: string; path: string }) {
  const [diff, setDiff] = useState<SafetyFileDiffResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setDiff(null)
    setError(null)
    window.koda
      .checkpointFileDiff({ checkpointId, path })
      .then((d) => alive && setDiff(d))
      .catch((err) => {
        if (alive) setError(String(err))
        console.error('checkpointFileDiff failed', err)
      })
    return () => {
      alive = false
    }
  }, [checkpointId, path])

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2">
        <p className="truncate font-mono text-[12px] text-text-muted" title={path}>
          {path}
        </p>
      </div>
      <div className="min-h-0 flex-1">
        {error ? (
          <p className="px-4 py-3 text-xs text-red-400">Couldn't show this change: {error}</p>
        ) : !diff ? (
          <p className="px-4 py-3 text-xs text-text-muted">Loading…</p>
        ) : diff.binary ? (
          <p className="px-4 py-3 text-xs text-text-muted">Binary file: can't show a diff.</p>
        ) : diff.truncated ? (
          <p className="px-4 py-3 text-xs text-text-muted">File too large to diff here.</p>
        ) : (
          <Suspense fallback={<p className="px-4 py-3 text-xs text-text-muted">Loading editor…</p>}>
            <MonacoDiffEditor path={path} before={diff.before} after={diff.after} className="h-full" />
          </Suspense>
        )}
      </div>
    </div>
  )
}

// ── shared bits (ported from the retired recovery drawer) ─────────────────────────────
const GLYPH: Record<ChangedFile['status'], { ch: string; cls: string; title: string }> = {
  added: { ch: 'A', cls: 'text-emerald-500', title: 'Added' },
  modified: { ch: 'M', cls: 'text-amber-500', title: 'Modified' },
  deleted: { ch: 'D', cls: 'text-red-500', title: 'Deleted' },
}

function StatusGlyph({ status }: { status: ChangedFile['status'] }) {
  const g = GLYPH[status]
  return (
    <span className={`w-3 shrink-0 text-center font-mono text-[11px] font-semibold ${g.cls}`} title={g.title}>
      {g.ch}
    </span>
  )
}

/**
 * Turn a checkpoint into human terms. Every row is a "before" moment, so the LIST shows just the bare
 * action (no repeated "Before" eating the width); the word only re-appears in the `plain` sentence
 * form ("Went back to before …"). `humanized` ⇒ `label` is a final standalone action phrase; else
 * it's the raw turn prompt, shown quoted as a placeholder. Legacy cached labels still carry a leading
 * "Before " — strip it here so old and new history read alike. The two restore-generated labels are
 * git jargon — rewrite so a non-engineer never sees a SHA.
 */
function describe(cp: { label: string; humanized?: boolean }): { label: string; plain: string } {
  const { label } = cp
  if (label === 'before recovery') {
    return { label: 'Snapshot before you went back', plain: 'the snapshot before your last undo' }
  }
  if (label.startsWith('recovered to ')) {
    return { label: '↩ Went back to an earlier point', plain: 'an earlier point' }
  }
  if (cp.humanized) {
    const action = label.replace(/^before\s+/i, '')
    return {
      label: action.charAt(0).toUpperCase() + action.slice(1),
      plain: `before ${action.charAt(0).toLowerCase() + action.slice(1)}`,
    }
  }
  return { label: `"${label}"`, plain: `before "${label}"` }
}

function relativeTime(unixSeconds: number): string {
  const diff = Math.max(0, Date.now() / 1000 - unixSeconds)
  if (diff < 45) return 'just now'
  const mins = Math.round(diff / 60)
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(diff / 3600)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(diff / 86400)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p
}
