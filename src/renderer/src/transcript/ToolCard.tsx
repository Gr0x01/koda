import { memo, useState } from 'react'
import { compactToolOutput } from '@shared/tool-output'
import { Collapse } from '../motion'
import { Caret } from '../Caret'
import { detailOf, summarize } from './step-summary'

/**
 * A tool step, folded from a ToolRequested + its matching ToolResult (by id) into
 * one collapsible card. Collapsed by default — vibecoders watch the conversation,
 * not the plumbing — but what it ran and what came back are one click away.
 *
 * Opening a step shows what a person would want: the command it ran, then its output.
 * Not the tool's raw JSON input — that reads as an IDE debugging a harness, and for the
 * file tools the header already says the only part that matters. A step with neither
 * (a Read that hasn't returned) doesn't offer a caret at all, so a disclosure control
 * on this surface always has something behind it.
 *
 * Memoized: a finished step's props are frozen, so it sits out the re-render
 * storm a fan-out's event rate would otherwise put every row through.
 */
export const ToolCard = memo(function ToolCard({
  name,
  input,
  liveOutput,
  result,
  isError,
}: {
  name: string
  input: unknown
  liveOutput?: string
  result?: string
  isError?: boolean
}) {
  const [open, setOpen] = useState(false)
  const pending = result === undefined
  const glyph = isError ? '✗' : pending ? '●' : '✓'
  const glyphClass = isError ? 'text-red-400' : pending ? 'animate-pulse text-accent' : 'text-text-muted'
  const summary = summarize(input)
  const detail = detailOf(input, summary)
  const output = result ?? liveOutput ?? ''
  const canOpen = Boolean(detail || output)

  const row = (
    <>
      {/* Fixed-width status gutter — every plumbing row hangs off this shared left axis. */}
      <span className={`grid h-4 w-4 shrink-0 place-items-center font-mono text-[11px] leading-none ${glyphClass}`}>
        {glyph}
      </span>
      {/* Min-width name column so the argument starts at the same x on every row (Write/Bash/Read align). */}
      <span className="min-w-[3.5rem] shrink-0 font-mono text-[11px] font-semibold uppercase tracking-wide text-text-muted transition-colors group-hover:text-text">
        {name}
      </span>
      <span className="truncate font-mono text-xs text-text-muted/75 transition-colors group-hover:text-text">
        {summary}
      </span>
    </>
  )
  const rowClass =
    'group flex w-full items-center gap-2.5 rounded-md py-0.5 pl-0.5 pr-2 text-left leading-5 transition-colors'

  if (!canOpen) return <div className={rowClass}>{row}</div>

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`${rowClass} hover:bg-black/[0.03] dark:hover:bg-white/[0.04]`}
      >
        {row}
        <Caret dir={open ? 'down' : 'right'} className="ml-auto text-text-muted/50 transition-colors group-hover:text-text" />
      </button>
      <Collapse open={open}>
        <div className="my-1.5 ml-7 space-y-2 border-l border-border pl-3 text-xs">
          {detail && <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-text-muted">{detail}</pre>}
          {output && (
            <pre
              className={`overflow-x-auto whitespace-pre-wrap font-mono ${
                isError ? 'text-red-400' : 'text-text-muted'
              }`}
            >
              {compactToolOutput(output)}
            </pre>
          )}
        </div>
      </Collapse>
    </div>
  )
})
