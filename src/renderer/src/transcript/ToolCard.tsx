import { useState } from 'react'
import { Collapse } from '../motion'
import { Caret } from '../Caret'

/**
 * A tool step, folded from a ToolRequested + its matching ToolResult (by id) into
 * one collapsible card. Collapsed by default — vibecoders watch the conversation,
 * not the plumbing — but the input + result are one click away.
 */
export function ToolCard({
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

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-2.5 rounded-md py-1 pl-0.5 pr-2 text-left"
      >
        {/* Fixed-width status gutter — every plumbing row hangs off this shared left axis. */}
        <span className={`grid h-4 w-4 shrink-0 place-items-center font-mono text-[11px] leading-none ${glyphClass}`}>
          {glyph}
        </span>
        {/* Min-width name column so the argument starts at the same x on every row (Write/Bash/Read align). */}
        <span className="min-w-[3.5rem] shrink-0 font-mono text-[11px] font-semibold uppercase tracking-wide text-text-muted transition-colors group-hover:text-text">
          {name}
        </span>
        <span className="truncate font-mono text-xs text-text-muted/75 transition-colors group-hover:text-text">
          {summarize(input)}
        </span>
        <Caret dir={open ? 'down' : 'right'} className="ml-auto text-text-muted/50 transition-colors group-hover:text-text" />
      </button>
      <Collapse open={open}>
        <div className="my-1.5 ml-7 space-y-2 border-l border-border pl-3 text-xs">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-text-muted">
            {JSON.stringify(input, null, 2)}
          </pre>
          {(result !== undefined || liveOutput) && (
            <pre
              className={`overflow-x-auto whitespace-pre-wrap font-mono ${
                isError ? 'text-red-400' : 'text-text-muted'
              }`}
            >
              {(() => {
                const output = result ?? liveOutput ?? ''
                return output.length > 2000 ? '… (showing latest)\n' + output.slice(-2000) : output
              })()}
            </pre>
          )}
        </div>
      </Collapse>
    </div>
  )
}

/** A one-line, human-leaning summary of the tool's input for the collapsed header. */
function summarize(input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  const pick = (k: string) => (typeof obj[k] === 'string' ? (obj[k] as string) : undefined)
  const first = pick('file_path') ?? pick('path') ?? pick('command') ?? pick('pattern') ?? pick('query')
  if (first) return first
  const json = JSON.stringify(input ?? {})
  return json.length > 80 ? json.slice(0, 80) + '…' : json
}
