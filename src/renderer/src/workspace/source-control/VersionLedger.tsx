import { Fragment } from 'react'
import type { GitCommitGraphResult, GitGraphRow } from '@shared/ipc'

/**
 * The Versions history as a calm linear ledger — the current line's versions, newest first. git-graph.ts
 * reserves lane 0 for HEAD's first-parent chain, so filtering to it gives exactly "your line": side
 * branches (other lanes) never appear here, they're surfaced as plain-language Loose Ends instead of
 * drawn as lanes. One row per version — what it was · when · a tick on an implied rail; tap to see what
 * it changed.
 *
 * The rail carries the one infra fact a non-engineer needs — is this safe yet: an accent tick means
 * "only on this Mac, not backed up," a muted tick means "on GitHub, safe," and a green divider labels
 * the boundary. Driven by `localOnlyCount` (how many newest versions aren't on the remote), so it's
 * correct whether you're ahead or fully pushed.
 */
export function Ledger({
  graph,
  selectedSha,
  localOnlyCount,
  onOpenCommit,
}: {
  graph: GitCommitGraphResult
  selectedSha: string | null
  /** How many of the newest versions are only on this Mac (sync.ahead). null ⇒ no backup to compare
   *  against (no remote / never pushed / unverified) — the rail then shows no safe/unsafe split. */
  localOnlyCount: number | null
  onOpenCommit: (sha: string) => void
}) {
  const rows = graph.layout.rows.filter((r) => r.lane === 0)
  // The backed-up boundary: the first `localOnlyCount` rows are local-only, the rest are on GitHub.
  // The divider slots in between — only when the split is real (some local AND some backed up in view).
  const boundary = localOnlyCount
  const showDivider = boundary !== null && boundary > 0 && boundary < rows.length

  return (
    <ul className="flex flex-col px-1.5 pb-1">
      {rows.map((row, i) => (
        <Fragment key={row.sha}>
          {showDivider && i === boundary && <BackupDivider />}
          <LedgerRow
            row={row}
            head={i === 0}
            // null ⇒ unknown (no backup tracking); else true when this version is only on this Mac.
            localOnly={boundary === null ? null : i < boundary}
            selected={row.sha === selectedSha}
            onOpen={() => onOpenCommit(row.sha)}
          />
        </Fragment>
      ))}
      {graph.truncated && (
        <li className="px-3 py-1 text-[11px] text-text-muted/70">+ older versions not shown.</li>
      )}
    </ul>
  )
}

function LedgerRow({
  row,
  head,
  localOnly,
  selected,
  onOpen,
}: {
  row: GitGraphRow
  head: boolean // the tip of your current line — your latest version
  localOnly: boolean | null // true = only on this Mac; false = on GitHub; null = no backup tracking
  selected: boolean
  onOpen: () => void
}) {
  // Rail tick encodes two things without icons: WIDTH marks the latest (your anchor); COLOR marks
  // backup state — accent = local-only/not-safe-yet, muted = on GitHub. With no backup tracking, only
  // the latest gets the accent anchor and the rest sit quiet.
  const tickColor =
    localOnly === null ? (head ? 'bg-accent' : 'bg-border') : localOnly ? 'bg-accent' : 'bg-border'
  const tickWidth = head ? 'w-5' : 'w-4'

  return (
    <li>
      <button
        onClick={onOpen}
        title={`${row.subject} · ${row.sha.slice(0, 7)}`}
        className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
          selected ? 'bg-accent/10' : 'hover:bg-surface'
        }`}
      >
        <span
          className={`min-w-0 flex-1 truncate text-[13px] transition-colors group-hover:text-text ${
            selected || head ? 'text-text' : 'text-text-muted'
          }`}
        >
          {row.subject}
        </span>
        <span className={`shrink-0 text-[11.5px] tabular-nums ${head ? 'text-text' : 'text-text-muted'}`}>
          {row.relativeDate}
        </span>
        <span className={`h-[2px] shrink-0 rounded-full ${tickWidth} ${tickColor}`} />
      </button>
    </li>
  )
}

/** The "safely on GitHub" line — a calm hairline the ledger flows through, no git vocabulary. */
function BackupDivider() {
  return (
    <li
      className="flex items-center gap-2.5 px-3 pb-1.5 pt-2.5"
      title="The versions above are only on this Mac; everything below is backed up to GitHub"
    >
      <span className="h-px flex-1 bg-gradient-to-l from-emerald-500/40 to-transparent" />
      <span className="shrink-0 whitespace-nowrap text-[10.5px] text-emerald-600 dark:text-emerald-400/90">
        On GitHub from here down
      </span>
      <span className="h-px flex-1 bg-gradient-to-r from-emerald-500/40 to-transparent" />
    </li>
  )
}
