import { useEffect, useRef, useState } from 'react'
import { Menu } from '../motion'
import { Caret } from '../Caret'
import { useWorkspace } from './store'

/**
 * Per-session reasoning-effort picker — a compact pill beside the model picker. The levels are the
 * engine's own `--effort` terms verbatim (low/medium/high/xhigh/max); "Default" leaves the flag off
 * so the engine decides (adaptive thinking). Selecting reattaches the session with `--effort` on its
 * next turn (the engine can't change effort live on a -p process), so it's blocked mid-turn — same
 * shape as the model picker and crossing plan mode.
 */

// Verbatim from `claude --help` (--effort <level>: low, medium, high, xhigh, max). Pass-through only.
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export function EffortControl({
  sessionId,
  effort,
  busy,
}: {
  sessionId: string
  effort?: string
  busy?: boolean
}) {
  const setSessionEffort = useWorkspace((s) => s.setSessionEffort)
  const hasPending = useWorkspace((s) => s.pending.some((r) => r.sessionId === sessionId))
  const locked = !!busy || hasPending
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const label = effort ? `Effort: ${effort}` : 'Effort'

  function choose(next: string | undefined): void {
    setSessionEffort(sessionId, next)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative min-w-0 shrink">
      <button
        onClick={() => !locked && setOpen((v) => !v)}
        disabled={locked}
        title={locked ? 'Finish or stop what’s running to change effort' : `Reasoning effort: ${effort ?? 'default'}`}
        className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:text-text disabled:opacity-40"
      >
        <span className="truncate">{label}</span>
        <Caret className="text-text-muted" />
      </button>

      <Menu
        open={open}
        onClose={() => setOpen(false)}
        origin="origin-bottom-left"
        className="absolute bottom-full left-0 z-10 mb-1.5 w-52 overflow-hidden rounded-lg border border-border bg-surface shadow-pop"
      >
        <Row label="Default" hint="engine decides" active={!effort} onClick={() => choose(undefined)} />
        {LEVELS.map((lvl) => (
          <Row key={lvl} label={lvl} active={effort === lvl} onClick={() => choose(lvl)} />
        ))}
      </Menu>
    </div>
  )
}

function Row({
  label,
  hint,
  active,
  onClick,
}: {
  label: string
  hint?: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors ${
        active ? 'bg-accent/10 text-accent' : 'text-text hover:bg-bg'
      }`}
    >
      <span className="w-3 shrink-0 text-accent">{active ? '✓' : ''}</span>
      <span className="truncate font-medium">{label}</span>
      {hint && <span className="ml-auto truncate text-[10px] text-text-muted">{hint}</span>}
    </button>
  )
}
