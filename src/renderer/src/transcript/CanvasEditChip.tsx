/**
 * Words in a quoted passage: whitespace-delimited runs, which is the only definition that is exactly
 * countable from the text itself and explainable to the person reading the figure. Deliberately does
 * NOT strip markdown syntax — the Canvas send quotes the passage verbatim into the turn, so the
 * markers really are sent. The store counts at send time and keeps only the figure: the passage's own
 * words never enter the transcript, which is written to disk and forwarded to the phone.
 */
export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

/** A doc-surface "Canvas" edit request — the user pointed at a passage in the rendered document and
 *  asked the agent to change it. Rendered as a compact chip (distinct from a typed message) so the
 *  worklog reads "this edit came from the doc," not the composer. Shares the user-turn accent rule.
 *
 *  This is the one send path that quotes real document words into a turn, so the chip says how many
 *  went. It states the figure and never grades it: no threshold, no colour that means good or bad. */
export function CanvasEditChip({
  docTitle,
  instruction,
  selectedWords,
}: {
  docTitle: string
  instruction: string
  /** How many words of the document this edit quoted. Absent when the user asked about the document
   *  without selecting a passage — nothing of it travelled, and a "0 words" line would be noise. */
  selectedWords?: number
}) {
  return (
    <div className="border-l-2 border-accent/40 pl-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 rounded-md bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-accent">
          ✎ {docTitle}
        </span>
        <span className="text-[length:var(--prose-fs)] font-medium leading-relaxed text-text">{instruction}</span>
      </div>
      {selectedWords !== undefined && (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-text-muted">
          <svg
            width={12}
            height={12}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="shrink-0"
          >
            <path d="M17 6H3M21 12H8M21 18H8M3 12v6" />
          </svg>
          <span className="tabular-nums">
            used {selectedWords} selected {selectedWords === 1 ? 'word' : 'words'}
          </span>
        </div>
      )}
    </div>
  )
}
