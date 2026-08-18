import { useMemo, useState } from 'react'
import type { GitCommitGraphResult, GitPushResult, GitSyncState, GitWorktree } from '@shared/ipc'
import { Button, PixelGlyph } from '../../ui'
import { useWorkspace } from '../store'
import { UploadGlyph } from './icons'
import { LaneGraph } from './LaneGraph'
import {
  bundleSummary,
  buildTimeline,
  type LooseEnd,
  type SeamKind,
  type TimelineRow,
} from './timeline'

/**
 * The Versions timeline — your line of work drawn as the graph it actually is, with everything that
 * used to live in its own section folded onto it: open side lines sit in the timeline where the work
 * happened, and the GitHub boundary is a seam on the line instead of a panel about it.
 *
 * Row content lives here; the rail's geometry lives in LaneGraph; which rows exist and which lanes are
 * earned lives in timeline.ts.
 */

// The live-session seam. Nothing passes `liveBranches` yet: a session knows its project dir, not a
// branch, and the branches OTHER windows are driving aren't visible to this renderer at all, so no
// row can honestly claim "working now" today. The rendering is already here — pass branch names in
// once per-session branch attribution exists and those lines get the green lane, tip, and label.
const NO_LIVE_BRANCHES: string[] = []

export function VersionTimeline({
  graph,
  sync,
  worktrees,
  tidiedCount,
  selectedSha,
  onOpenCommit,
  onReview,
  onChanged,
  onLeave,
  trunk = null,
  liveBranches = NO_LIVE_BRANCHES,
}: {
  graph: GitCommitGraphResult | null
  sync: GitSyncState | null
  worktrees: GitWorktree[]
  /** The project's main line, so merging it back down reads as catching up rather than as new work. */
  trunk?: string | null
  /** Finished side lines this refresh cleaned up on its own — a confirmation, never a to-do. */
  tidiedCount: number
  selectedSha: string | null
  onOpenCommit: (sha: string) => void
  onReview: (branch: string) => void
  onChanged: () => void
  onLeave: () => void
  /** Branches a session is driving right now. See the live-session seam above. */
  liveBranches?: string[]
}) {
  // Merges the user opened. A merge from the trunk starts shut (catching up is not work arriving);
  // any other merge starts on a preview and this carries it the rest of the way.
  const [openMerges, setOpenMerges] = useState<ReadonlySet<string>>(() => new Set())
  const toggleMerge = (sha: string): void =>
    setOpenMerges((prev) => {
      const next = new Set(prev)
      if (!next.delete(sha)) next.add(sha)
      return next
    })

  const timeline = useMemo(
    () => buildTimeline({ graph, sync, worktrees, liveBranches, trunk, openMerges }),
    [graph, sync, worktrees, liveBranches, trunk, openMerges],
  )
  const [expanded, setExpanded] = useState(false)
  const hasLanedSide = timeline.rows.some((r) => r.t === 'side')

  const renderRow = (row: TimelineRow): React.ReactNode => {
    if (row.t === 'commit')
      return (
        <CommitRow
          subject={row.subject}
          when={row.when}
          title={`${row.subject} · ${row.sha.slice(0, 7)} · ${row.whenLong}`}
          dim={row.onGitHub === true}
          selected={row.sha === selectedSha}
          onOpen={() => onOpenCommit(row.sha)}
          inflowCount={row.inflowCount}
          inflowPartial={row.inflowPartial}
          inflowOpen={row.inflowOpen}
          inflowExpanded={row.inflowExpanded}
          fromTrunk={row.fromTrunk}
          onToggleInflow={row.inflowToggleable ? () => toggleMerge(row.sha) : undefined}
        />
      )
    if (row.t === 'inflow')
      return (
        <InflowRow
          subject={row.subject}
          when={row.when}
          title={`${row.subject} · ${row.sha.slice(0, 7)} · ${row.whenLong}`}
          selected={row.sha === selectedSha}
          onOpen={() => onOpenCommit(row.sha)}
        />
      )
    if (row.t === 'inflowMore')
      return (
        <InflowMoreRow
          remaining={row.remaining}
          partial={row.partial}
          onOpen={row.expandable ? () => toggleMerge(row.mergeSha) : undefined}
        />
      )
    if (row.t === 'day') return <DayRow label={row.label} />
    if (row.t === 'side') return <SideRow end={row.end} onReview={onReview} />
    if (row.t === 'bundle')
      return (
        <BundleRow
          ends={row.ends}
          more={hasLanedSide}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          onLeave={onLeave}
        />
      )
    return (
      <SeamRow
        sync={sync}
        kind={row.kind}
        ahead={timeline.ahead}
        onChanged={onChanged}
        onLeave={onLeave}
      />
    )
  }

  if (timeline.rows.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-text-muted">No versions yet. Save one to start your history.</p>
    )
  }

  return (
    <div className="pb-2 pt-1">
      <LaneGraph
        rows={timeline.rows}
        lanes={timeline.lanes}
        boundaryRow={timeline.boundaryRow}
        seamRow={timeline.seamRow}
        renderRow={renderRow}
      />
      {timeline.truncated && (
        <p className="px-3 pt-2 text-[11px] text-text-muted/70">+ older versions not shown.</p>
      )}
      {tidiedCount > 0 && (
        <p className="px-3 pt-2 text-[11px] leading-relaxed text-text-muted/80">
          Tidied up {tidiedCount} finished side {tidiedCount === 1 ? 'line' : 'lines'}, fully saved, so
          nothing was lost.
        </p>
      )}
    </div>
  )
}

// ── Rows ──────────────────────────────────────────────────────────────────────────────
/**
 * The day a run of versions was saved. A working day here is routinely twenty commits, and without a
 * break they read as one undifferentiated wall — the heading is what gives the column a rhythm.
 */
function DayRow({ label }: { label: string }) {
  return (
    <div className="flex items-end pb-1 pt-3 pr-3">
      <span className="font-display text-[10.5px] font-medium uppercase tracking-[0.09em] text-text-muted/70">
        {label}
      </span>
    </div>
  )
}

function CommitRow({
  subject,
  when,
  title,
  dim,
  selected,
  onOpen,
  inflowCount,
  inflowPartial,
  inflowOpen,
  inflowExpanded,
  fromTrunk,
  onToggleInflow,
}: {
  subject: string
  when: string
  title: string
  /** Already on GitHub, so it recedes — the unsaved end of the line is what needs attention. */
  dim: boolean
  selected: boolean
  onOpen: () => void
  /** Versions this merge brought in. 0 on an ordinary commit. */
  inflowCount: number
  inflowPartial: boolean
  inflowOpen: boolean
  inflowExpanded: boolean
  fromTrunk: boolean
  onToggleInflow?: () => void
}) {
  const inflowUnknown = inflowCount === 0 && inflowPartial
  const inflowLabel = inflowUnknown ? '?' : `${inflowCount}${inflowPartial ? '+' : ''}`
  const hasInflow = inflowCount > 0 || inflowPartial
  const toggleTitle = fromTrunk
    ? inflowOpen
      ? 'Hide what this merge brought in'
      : inflowUnknown
        ? 'Show what this merge brought in outside the loaded history'
        : `Show the ${inflowLabel} ${inflowCount === 1 ? 'version' : 'versions'} this merge brought in`
    : inflowExpanded
      ? 'Show fewer versions from this merge'
      : 'Show every loaded version from this merge'
  return (
    // A row, not a button, because a merge carries two different targets: the merge itself, and the
    // work it brought in. Nesting a button inside a button is invalid and swallows the inner click.
    <div
      className={`group flex w-full items-center gap-2 rounded-lg py-2 pl-1 pr-3 text-left transition-colors ${
        selected ? 'bg-accent/10' : 'hover:bg-surface'
      }`}
    >
      <button onClick={onOpen} title={title} className="min-w-0 flex-1 truncate text-left">
        <span
          className={`text-[13px] transition-colors group-hover:text-text ${
            selected || !dim ? 'text-text' : 'text-text-muted'
          }`}
        >
          {subject}
        </span>
      </button>
      {hasInflow && onToggleInflow ? (
        <button
          onClick={onToggleInflow}
          title={toggleTitle}
          className={`shrink-0 rounded px-1 text-[11px] tabular-nums outline-none transition-colors focus-visible:bg-surface ${
            inflowOpen
              ? 'text-[#4f8a5c] dark:text-[#91c799]'
              : 'text-text-muted hover:text-[#4f8a5c] dark:hover:text-[#7fb886]'
          }`}
        >
          {inflowLabel}
        </button>
      ) : hasInflow ? (
        <span
          title={inflowUnknown ? 'Some versions are outside the loaded history' : undefined}
          className={`shrink-0 px-1 text-[11px] tabular-nums ${
            inflowOpen ? 'text-[#4f8a5c] dark:text-[#91c799]' : 'text-text-muted'
          }`}
        >
          {inflowLabel}
        </span>
      ) : null}
      <span className="shrink-0 text-[11px] tabular-nums text-text-muted">{when}</span>
    </div>
  )
}

/** One version a merge brought in. Quieter than a spine row: it is context for the merge above it. */
function InflowRow({
  subject,
  when,
  title,
  selected,
  onOpen,
}: {
  subject: string
  when: string
  title: string
  selected: boolean
  onOpen: () => void
}) {
  return (
    <button
      onClick={onOpen}
      title={title}
      className={`group flex w-full items-center gap-3 rounded-lg py-1.5 pl-3 pr-3 text-left transition-colors ${
        selected ? 'bg-accent/10' : 'hover:bg-surface'
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-muted transition-colors group-hover:text-text">
        {subject}
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-text-muted/70">{when}</span>
    </button>
  )
}

/** The rest of a merge's versions, behind one row rather than a wall of them. */
function InflowMoreRow({
  remaining,
  partial,
  onOpen,
}: {
  remaining: number
  /** The fetch window ended before we had them all, so we cannot promise this is the whole tail. */
  partial: boolean
  onOpen?: () => void
}) {
  const copy = (
    <>
      {remaining > 0
        ? `+ ${remaining} more on that branch`
        : 'More on that branch than was loaded here'}
      {remaining > 0 && partial ? ' (at least)' : ''}
    </>
  )
  if (!onOpen)
    return (
      <div className="flex w-full items-center py-1.5 pl-3 pr-3 text-[11.5px] text-text-muted/70">
        {copy}
      </div>
    )
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center rounded-lg py-1.5 pl-3 pr-3 text-left text-[11.5px] text-text-muted outline-none transition-colors hover:text-text focus-visible:bg-surface focus-visible:text-text"
    >
      {copy}
    </button>
  )
}

/** One open side line, in the timeline where its work happened. */
function SideRow({ end, onReview }: { end: LooseEnd; onReview: (branch: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function open(): Promise<void> {
    if (!end.path) return
    setBusy(true)
    setNote(null)
    try {
      const res = await window.koda.openWorktree({ path: end.path })
      if (res.alreadyOpen) setNote('Already open in another window.')
    } catch (e) {
      setNote('Could not open it.')
      console.error('openWorktree failed', e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="py-0.5 pr-3">
      {/* The name shares its line with the action and truncates (it has a tooltip); the status gets a
          line to itself, because "17 loose files" is the whole reason this card is here. */}
      <div className="rounded-lg bg-surface px-2.5 py-2 shadow-soft">
        <div className="flex items-center gap-2">
          <span
            className="min-w-0 flex-1 truncate font-mono text-[12px] text-text"
            title={end.path ?? end.label}
          >
            {end.label}
          </span>
          {end.path && !end.missing ? (
            <Button variant="secondary" size="sm" onClick={open} disabled={busy} className="shrink-0">
              {busy ? 'Opening…' : 'Open'}
            </Button>
          ) : end.branch && !end.path ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onReview(end.branch as string)}
              className="shrink-0"
            >
              Review
            </Button>
          ) : null}
        </div>
        <span className={`mt-1 flex items-center gap-1.5 text-[11px] leading-snug ${statusTone(end)}`}>
          {end.live && <PixelGlyph loader size={9} className="shrink-0 text-emerald-500" />}
          <span>{end.live ? 'session working now' : end.status}</span>
        </span>
        {note && <p className="mt-0.5 text-[11px] text-text-muted/70">{note}</p>}
      </div>
    </div>
  )
}

function statusTone(end: LooseEnd): string {
  if (end.live) return 'text-emerald-500'
  if (end.missing) return 'text-red-400'
  if (end.ready) return 'text-emerald-600 dark:text-emerald-400/90'
  return 'text-[#9a6f1e] dark:text-[#e0c178]'
}

/** Everything past the lane cap, as one row: how many, how bad, and one way to deal with all of it. */
function BundleRow({
  ends,
  more,
  expanded,
  onToggle,
  onLeave,
}: {
  ends: LooseEnd[]
  /** Some side lines already have lanes, so these are the ones on top of those. */
  more: boolean
  expanded: boolean
  onToggle: () => void
  onLeave: () => void
}) {
  const sendTidySideLines = useWorkspace((s) => s.sendTidySideLines)
  const anyBusy = useWorkspace((s) => Object.values(s.sessions).some((sess) => sess.busy))
  const hasSession = useWorkspace((s) => !!s.activeId)
  const canAsk = hasSession && !anyBusy

  async function tidy(): Promise<void> {
    const ok = await sendTidySideLines({
      names: ends.map((e) => e.branch ?? e.label),
    })
    if (ok) onLeave() // back to the workspace to watch the agent work through the pile
  }

  return (
    <div className="py-0.5 pr-3">
      {/* A shade under the side-line cards rather than a dashed outline around them: this is the same
          kind of thing as those cards, just collapsed, and the heading already says it is a pile. */}
      <div className="rounded-lg bg-surface/60 px-2.5 py-2">
        {/* The count keeps its own line at any width; the two actions carry equal weight and drop
            below the text when the panel is too narrow to hold them beside it. */}
        <div data-lane-anchor>
          <span className="block text-[12.5px] font-medium text-text">
            {ends.length} {more ? 'more ' : ''}side {ends.length === 1 ? 'line' : 'lines'}
          </span>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 text-[11px] leading-snug text-text-muted">{bundleSummary(ends)}</span>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <Button variant="secondary" size="sm" onClick={onToggle}>
                {expanded ? 'Hide' : 'Show'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={tidy}
                disabled={!canAsk}
                title={
                  !hasSession
                    ? 'Open a session first'
                    : anyBusy
                      ? 'Wait for the agent to finish first'
                      : 'Your agent reviews all of them, keeps what holds real work, and clears the rest'
                }
              >
                Tidy up
              </Button>
            </div>
          </div>
        </div>
        {expanded && (
          <ul className="mt-2 border-t border-border pt-1">
            {ends.map((end) => (
              <li key={end.id} className="py-1.5 pl-1">
                <span className="block truncate font-mono text-[12px] text-text" title={end.path ?? end.label}>
                  {end.label}
                </span>
                <span className={`block truncate text-[11px] ${statusTone(end)}`}>{end.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * The GitHub seam: the point on your line where this Mac stops being the only copy. Push lives here
 * because this is where the boundary is, and a failed push is a conversation for the agent, never a
 * git lesson in a panel.
 */
function SeamRow({
  sync,
  kind,
  ahead,
  onChanged,
  onLeave,
}: {
  sync: GitSyncState | null
  /** What this seam is entitled to claim — the SAME decision that drew (or withheld) the split. */
  kind: SeamKind
  ahead: number
  onChanged: () => void
  onLeave: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Extract<GitPushResult, { ok: false }> | null>(null)
  const sendBackupAction = useWorkspace((s) => s.sendBackupAction)
  const anyBusy = useWorkspace((s) => Object.values(s.sessions).some((sess) => sess.busy))
  const hasSession = useWorkspace((s) => !!s.activeId)
  const canAsk = hasSession && !anyBusy

  async function push(): Promise<void> {
    setBusy(true)
    setFailure(null)
    try {
      const res = await window.koda.gitPush()
      if (res.ok) onChanged()
      else setFailure(res)
    } catch (err) {
      setFailure({ ok: false, code: 'git_failed', message: String(err) })
      console.error('gitPush failed', err)
    } finally {
      setBusy(false)
    }
  }

  async function askAgent(): Promise<void> {
    const ok = await sendBackupAction({ kind: 'fixPush', error: failure?.message ?? 'unknown error' })
    if (ok) onLeave()
  }

  if (!sync) return null
  const verified = sync.verified
  const allSafe = kind === 'boundary' && ahead === 0

  return (
    <div className="py-1.5 pr-3">
      {/* No box. The seam is a mark ON the line, not an object sitting beside it — the rail already
          draws its tick. The push is accent text rather than a bordered pill: at the default panel
          width a pill does not fit next to the sentence, and the pill that wrapped out of this row
          was the thing that read as a control floating in the timeline. */}
      {/* Never truncate the sentence: "Couldn't reach GitHub" clipped to "Couldn't reach Git…" loses
          the only word that matters. It wraps, and the action stays on the first line beside it. */}
      <div className="flex items-start gap-2" data-lane-anchor>
        <span
          className={`min-w-0 text-[11px] leading-snug ${
            allSafe ? 'text-emerald-600 dark:text-emerald-400/90' : 'text-text-muted'
          }`}
        >
          {SEAM_COPY[kind](ahead)}
        </span>
        {(ahead > 0 || kind === 'neverPushed') && (
          <button
            onClick={() => void push()}
            disabled={busy}
            title="Push to GitHub"
            className="ml-auto flex shrink-0 items-center gap-1 rounded text-[11px] font-medium text-accent transition-opacity hover:opacity-70 disabled:opacity-50"
          >
            <UploadGlyph />
            {busy
              ? 'Pushing…'
              : kind === 'neverPushed'
                ? 'Push this branch'
                : `Push ${ahead} ${ahead === 1 ? 'version' : 'versions'}`}
          </button>
        )}
      </div>

      {/* Never a confident line off a cached number: say what we last knew and offer to ask again. */}
      {!verified && (
        <p className="mt-1 text-[11px] leading-relaxed text-text-muted/70">
          This is the last thing it told us.{' '}
          <button onClick={onChanged} className="text-accent underline-offset-2 hover:underline">
            Check again
          </button>
        </p>
      )}

      {verified && sync.behind > 0 && (
        <p className="mt-1 text-[11px] leading-relaxed text-text-muted/70">
          {sync.behind} newer {sync.behind === 1 ? 'version exists' : 'versions exist'} on GitHub
          that{sync.behind === 1 ? " isn't" : " aren't"} on this computer yet.
        </p>
      )}

      {failure && (
        <div className="mt-1.5 rounded-lg bg-[#b5862f]/12 p-2.5">
          <p className="text-[11px] leading-relaxed text-[#7a5b14] dark:text-[#d8b765]">
            {failureCopy(failure.code)}
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void askAgent()}
            disabled={!canAsk}
            title={
              !hasSession
                ? 'Open a session first'
                : anyBusy
                  ? 'Wait for the agent to finish first'
                  : undefined
            }
            className="mt-2"
          >
            Ask your agent to fix it
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * One line per seam kind, each saying only what that kind knows. `boundary` is the only one allowed
 * to talk about a position on the line, because it's the only one we located a real commit for.
 */
const SEAM_COPY: Record<SeamKind, (ahead: number) => string> = {
  boundary: (ahead) => (ahead > 0 ? 'On GitHub from here down' : 'Everything is on GitHub'),
  neverPushed: () => "This branch hasn't been pushed to GitHub yet",
  unlocated: () => 'Some of this is not on GitHub yet',
  unverified: () => "Couldn't reach GitHub",
}

function failureCopy(code: Extract<GitPushResult, { ok: false }>['code']): string {
  switch (code) {
    case 'push_auth':
      return "GitHub didn't accept this computer's credentials, so the push couldn't go through."
    case 'push_rejected':
      return "GitHub has versions this computer doesn't, so they need to be combined before pushing."
    case 'no_remote':
      return "This project isn't connected to a GitHub repo yet."
    default:
      return "The push to GitHub didn't go through."
  }
}
