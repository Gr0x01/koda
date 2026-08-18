import { useEffect, useRef, useState } from 'react'
import { Menu } from '../motion'
import { Caret } from '../Caret'
import { useWorkspace } from './store'
import { REASONING_EFFORTS, prettyEffort } from './models'

/**
 * Per-session reasoning picker. Values are the engines' own terms and stay separate from model choice,
 * but the two are persisted as one new-chat posture in the store. A short explanation makes the dial
 * understandable without turning the compact composer into a settings form.
 */
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
  const hasPending = useWorkspace((s) => s.pending.some((request) => request.sessionId === sessionId))
  const locked = !!busy || hasPending
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const value = prettyEffort(effort)
  const label = effort ? value : 'Reasoning'

  function choose(next: string): void {
    setSessionEffort(sessionId, next || undefined)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative min-w-0 shrink">
      <button
        onClick={() => !locked && setOpen((current) => !current)}
        disabled={locked}
        title={locked ? 'Finish or stop what’s running to change effort' : `Reasoning effort: ${value}`}
        aria-label={`Reasoning effort: ${value}`}
        aria-expanded={open}
        className={`flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors hover:text-text disabled:opacity-40 ${
          open ? 'bg-bg text-text' : 'text-text-muted'
        }`}
      >
        <ReasoningMark />
        <span className="truncate">{label}</span>
        <Caret className="text-text-muted" />
      </button>

      <Menu
        open={open}
        onClose={() => setOpen(false)}
        origin="origin-bottom-left"
        className="absolute bottom-full left-0 z-10 mb-1.5 w-72 overflow-hidden rounded-xl border border-border bg-surface p-2.5 shadow-pop"
      >
        <div className="px-1.5 pb-2 pt-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-text-muted/75">
          Reasoning effort
        </div>
        {REASONING_EFFORTS.map((option) => (
          <button
            key={option.id || 'default'}
            onClick={() => choose(option.id)}
            className={`grid min-h-[47px] w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
              (effort ?? '') === option.id ? 'bg-accent/10' : 'hover:bg-bg'
            }`}
          >
            <span
              className={`size-3.5 rounded-full border ${
                (effort ?? '') === option.id
                  ? 'border-[4px] border-accent'
                  : 'border-border text-transparent'
              }`}
            />
            <span className="min-w-0">
              <span className="block text-[11px] font-medium text-text">{option.label}</span>
              <span className="mt-0.5 block truncate text-[9px] text-text-muted">
                {option.description}
              </span>
            </span>
            {option.badge && <span className="text-[8.5px] text-text-muted/75">{option.badge}</span>}
          </button>
        ))}
      </Menu>
    </div>
  )
}

function ReasoningMark(): React.JSX.Element {
  return (
    <svg
      className="size-3.5 shrink-0 text-accent/90"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="m5.7 5.7 2.8 2.8M15.5 15.5l2.8 2.8M18.3 5.7l-2.8 2.8M8.5 15.5l-2.8 2.8" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  )
}
