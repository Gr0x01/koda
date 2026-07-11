import { useEffect, useRef, useState } from 'react'
import type { ApprovalMode } from '@shared/ipc'
import { Menu } from '../motion'
import { Caret } from '../Caret'
import { useWorkspace } from './store'

/**
 * Per-session mode control — pared down for non-engineers to three postures (the engine's edits-vs-
 * commands granularity is an engineer's distinction; safety-git + the destructive-git tripwire cover the
 * real risk regardless of mode). Shown Cursor-style as a single compact pill (active mode only); click to
 * open the menu and pick another, or Shift+Tab in the composer to cycle (see `nextApprovalMode`).
 * Auto/Check first switch the gate live; Plan first is the engine's --permission-mode plan, so crossing
 * the plan boundary reattaches the session (can't change live on a -p process) — blocked mid-turn since a
 * respawn would kill the running turn. `acceptEdits` is no longer user-pickable (post-plan now lands in
 * Auto), but stays in MODE_LABEL so a legacy session persisted in it still renders.
 */
const TIERS: { mode: ApprovalMode; label: string; desc: string; title: string }[] = [
  { mode: 'auto', label: 'Auto', desc: 'Builds on its own', title: 'Auto-approve everything (destructive git + recovery still confirm)' },
  { mode: 'plan', label: 'Plan first', desc: 'Shows a plan before building', title: 'Researches read-only and presents a plan before building' },
  { mode: 'ask', label: 'Check first', desc: 'Asks before each step', title: 'Asks before every edit and command' },
]

/** Display labels for the pill, including the now-unpickable `acceptEdits` (legacy/persisted sessions). */
const MODE_LABEL: Record<ApprovalMode, string> = {
  auto: 'Auto',
  acceptEdits: 'Auto',
  plan: 'Plan first',
  ask: 'Check first',
}

/** Crossing into/out of Plan respawns the engine — can't do that mid-turn. */
function crossesPlanWhileBusy(target: ApprovalMode, current: ApprovalMode, busy?: boolean): boolean {
  return !!busy && (target === 'plan') !== (current === 'plan')
}

/** Next mode in the shift+tab cycle, skipping any tier blocked while busy (i.e. Plan mid-turn). */
export function nextApprovalMode(current: ApprovalMode, busy?: boolean): ApprovalMode {
  const i = TIERS.findIndex((t) => t.mode === current)
  for (let step = 1; step <= TIERS.length; step++) {
    const cand = TIERS[(i + step) % TIERS.length].mode
    if (!crossesPlanWhileBusy(cand, current, busy)) return cand
  }
  return current
}

export function ApprovalModeControl({
  sessionId,
  mode,
  busy,
}: {
  sessionId: string
  mode: ApprovalMode
  busy?: boolean
}) {
  const setSessionApprovalMode = useWorkspace((s) => s.setSessionApprovalMode)
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

  const active = TIERS.find((t) => t.mode === mode) ?? TIERS[0]

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`${active.title} · Shift+Tab to cycle`}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:text-text"
      >
        {MODE_LABEL[mode]}
        <Caret className="text-text-muted" />
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        origin="origin-bottom-left"
        className="absolute bottom-full left-0 z-10 mb-1.5 w-64 overflow-hidden rounded-lg border border-border bg-surface shadow-pop"
      >
          {TIERS.map((t) => {
            const blocked = crossesPlanWhileBusy(t.mode, mode, busy)
            const selected = t.mode === mode
            return (
              <button
                key={t.mode}
                onClick={() => {
                  setSessionApprovalMode(sessionId, t.mode)
                  setOpen(false)
                }}
                disabled={blocked}
                title={blocked ? 'Finish or stop what’s running to switch Plan first mode' : t.title}
                className={`flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors disabled:opacity-30 ${
                  selected ? 'bg-accent/10' : 'hover:bg-bg'
                }`}
              >
                <span className={`mt-0.5 w-3 shrink-0 text-[11px] ${selected ? 'text-accent' : ''}`}>{selected ? '✓' : ''}</span>
                <span className="min-w-0">
                  <span className={`block text-[11px] font-medium ${selected ? 'text-accent' : 'text-text'}`}>{t.label}</span>
                  <span className="block text-[10px] text-text-muted">{t.desc}</span>
                </span>
              </button>
            )
          })}
      </Menu>
    </div>
  )
}
