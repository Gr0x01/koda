import { useEffect, useState } from 'react'
import { useWorkspace } from '../workspace/store'
import { Button } from '../ui'
import { SettingsSection, SettingsRow, Toggle } from './controls'
import { IconWarning } from './icons'

/**
 * Settings → Memory: what the project's memory is, how heavy the always-loaded part has grown, and
 * the one action that matters — asking the agent to tidy it. The status-bar pill deep-links here when
 * the injected pair (MEMORY.md index + active-context.md) crosses the heaviness line, because a bloated
 * always-loaded context measurably dulls the agent. The tidy itself is a normal conversational turn
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
      <p className="text-[12.5px] leading-relaxed text-text-muted">
        The agent keeps what it learns about this project in a set of notes: how things are built,
        decisions and the reasons behind them, context worth carrying forward. Two of those notes,
        the index and the current context, load into every conversation so each session starts
        already oriented.
      </p>
      <SettingsSection title="Project memory">
        <SettingsRow
          label="Always-loaded size"
          description="The part of memory that rides along in every conversation. Past a point, that weight dulls the agent instead of sharpening it."
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
          description="Asks the agent to distill the always-loaded notes back down, moving detail into topic notes and archiving the old tail. Nothing is lost: replaced notes are marked, not deleted, and every change can be undone."
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
        />
        {hint && <div className="px-4 py-2.5 text-[12px] text-amber-500">{hint}</div>}
        <SettingsRow
          label="Tidy overnight"
          description="A couple of quiet hours after you stop working, Koda tidies the memory of the projects you worked in that day and leaves the session for you to read in the morning. Anything needing your judgment is flagged, never decided. Uses your plan while you're away."
          control={<Toggle checked={dream ?? false} onChange={toggleDream} label="Tidy overnight" />}
        />
      </SettingsSection>
    </>
  )
}
