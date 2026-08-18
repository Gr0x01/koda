import { useEffect, useState } from 'react'
import { useWorkspace } from '../workspace/store'
import { Button } from '../ui'
import { SettingsSection, SettingsRow, Toggle } from './controls'
import { IconWarning } from './icons'

/**
 * Settings → Memory: what the project's memory is, how heavy its navigation layer has grown, and
 * the one action that matters — asking the agent to tidy it. The status-bar pill deep-links here when
 * the index + active-context pair crosses the heaviness line, because a bloated map becomes difficult
 * to retrieve from reliably. The tidy itself is a normal conversational turn
 * (the agent does the pruning, safety-git makes it undoable) — Koda never rewrites memory behind
 * the user's back.
 */
export function MemorySection() {
  const weight = useWorkspace((s) => s.memoryWeight)
  const refreshMemoryWeight = useWorkspace((s) => s.refreshMemoryWeight)
  const sendMemoryTidy = useWorkspace((s) => s.sendMemoryTidy)
  const setSettingsOpen = useWorkspace((s) => s.setSettingsOpen)
  // Tidy opens its own fresh session, so it only needs a project to be open — it no longer depends on
  // there being an idle active session to borrow.
  const canSend = useWorkspace((s) => !!s.projectPath)
  const [hint, setHint] = useState<string | null>(null)
  const [dream, setDream] = useState<boolean | null>(null)

  // Re-read on open — the pill's slow ambient poll may be minutes stale.
  useEffect(() => {
    void refreshMemoryWeight()
    window.koda.getSettings().then((s) => setDream(s.dreamEnabled)).catch(console.error)
  }, [refreshMemoryWeight])

  const toggleDream = (next: boolean): void => {
    setDream(next)
    // Trust the echo, not the optimistic flip: a main process that dropped the field (the 08-04
    // stale-dev-main incident) snaps the toggle back OFF instead of lying that it took.
    window.koda
      .updateSettings({ dreamEnabled: next })
      .then((s) => setDream(s.dreamEnabled === true))
      .catch(console.error)
  }

  const tidy = async () => {
    setHint(null)
    const ok = await sendMemoryTidy()
    if (ok) {
      // Hand the stage back to the conversation so the tidy is watched, not hidden behind Settings.
      setSettingsOpen(false)
    } else {
      setHint('Open a project first.')
    }
  }

  const words = weight ? Math.round(weight.chars / 5) : 0

  return (
    <>
      <SettingsSection
        title="Project memory"
        note="The agent keeps what it learns about this project in a set of notes: how things are built, decisions and the reasons behind them, context worth carrying forward. A tiny project card travels with every conversation, and the index, current context, and topic notes open only when the work needs them. A tidy runs as a normal conversation you can watch, every change it makes is recoverable, and anything needing your judgment is flagged rather than decided."
      >
        <SettingsRow
          label="Navigation size"
          description="How big the index and current-context notes have grown, which is the map the agent reads to find everything else."
          control={
            weight === null ? (
              <span className="text-[12.5px] text-text-muted">…</span>
            ) : !weight.present ? (
              <span className="text-[12.5px] text-text-muted">no memory yet</span>
            ) : weight.heavy ? (
              <span className="flex items-center gap-1.5 text-[12.5px] text-amber-500">
                <span className="[&_svg]:h-3.5 [&_svg]:w-3.5" aria-hidden>
                  <IconWarning />
                </span>
                heavy · ~{words.toLocaleString()} words
              </span>
            ) : (
              <span className="text-[12.5px] text-text-muted">healthy · ~{words.toLocaleString()} words</span>
            )
          }
        />
        <SettingsRow
          label="Tidy memory"
          description="Ask the agent to distill those notes back down, moving detail into topic notes and archiving the old tail."
          control={
            <Button
              variant={weight?.heavy ? 'primary' : 'ghost'}
              size="md"
              disabled={!weight?.present || !canSend}
              onClick={() => void tidy()}
            >
              Tidy memory
            </Button>
          }
        >
          {hint && <p className="text-[12px] text-amber-500">{hint}</p>}
        </SettingsRow>
        <SettingsRow
          label="Tidy overnight"
          description="Run that tidy on its own a couple of quiet hours after you stop working, using your plan while you are away."
          control={<Toggle checked={dream ?? false} onChange={toggleDream} label="Tidy overnight" />}
        />
      </SettingsSection>
    </>
  )
}
