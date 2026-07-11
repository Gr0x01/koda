/** A doc-surface "Canvas" edit request — the user pointed at a passage in the rendered document and
 *  asked the agent to change it. Rendered as a compact chip (distinct from a typed message) so the
 *  worklog reads "this edit came from the doc," not the composer. Shares the user-turn accent rule. */
export function CanvasEditChip({ docTitle, instruction }: { docTitle: string; instruction: string }) {
  return (
    <div className="flex items-start gap-2 border-l-2 border-accent/40 pl-3">
      <span className="mt-0.5 shrink-0 rounded-md bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-accent">
        ✎ {docTitle}
      </span>
      <span className="text-[length:var(--prose-fs)] font-medium leading-relaxed text-text">{instruction}</span>
    </div>
  )
}
