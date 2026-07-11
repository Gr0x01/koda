/**
 * Extended-thinking indicator. On subscription `-p` the reasoning text is redacted
 * (spike/capture), so there's no chain-of-thought to show — only that the model is
 * thinking and roughly how much (the engine's cumulative `estimatedTokens`). Mirrors
 * the TUI's "Thinking…" affordance: a quiet, dim line that resolves once real output
 * begins. Deliberately understated — it's a status, not content.
 */
export function ThinkingIndicator({ estimatedTokens, active }: { estimatedTokens?: number; active: boolean }) {
  const tokens = estimatedTokens != null ? `~${estimatedTokens.toLocaleString()} tokens` : null
  return (
    <div className="flex items-center gap-2.5 py-0.5 pl-0.5 text-[11px] text-text-muted">
      <span className={`grid h-4 w-4 shrink-0 place-items-center leading-none ${active ? 'text-accent' : 'text-text-muted'}`}>✦</span>
      <span className="italic">
        {active ? 'Thinking' : 'Thought'}
        {active && <span className="animate-pulse">…</span>}
      </span>
      {tokens && <span className="font-mono opacity-70">{tokens}</span>}
    </div>
  )
}
