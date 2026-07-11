import { useState } from 'react'
import { useWorkspace } from '../workspace/store'
import { Button } from '../ui'

/**
 * Project intake (architecture/onboarding.md, the per-project axis) — the empty-state of a project
 * that has no agent guidelines yet (a New project, OR an existing folder opened for the first time
 * with no CLAUDE.md/AGENTS.md). The user describes what the project is; on "Get started" we start its
 * first session and dispatch a visible turn asking the agent to author the guidelines. Skip = a plain
 * blank workspace, remembered per-project (the default guardrails already cover them).
 *
 * Shown by ConversationSurface in place of the generic "Start building" empty-state while
 * `intakePending` is set (ProjectHome sets it for New project; `maybeOfferIntake` for existing folders).
 */
export function ProjectIntake() {
  const projectPath = useWorkspace((s) => s.projectPath)
  const startProjectIntake = useWorkspace((s) => s.startProjectIntake)
  const skipIntake = useWorkspace((s) => s.skipIntake)
  const [description, setDescription] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const name = projectPath ? projectPath.split('/').filter(Boolean).pop() : null
  const canStart = description.trim().length > 0 && !busy

  const start = (): void => {
    if (!canStart) return
    setBusy(true) // the swap to the live session unmounts this; guard against a double-submit until then
    setError(null)
    // Resolves true once the session is live (this component unmounts to the conversation); false only
    // if the session couldn't start — then we're still mounted, so recover the form.
    startProjectIntake({ description, notes })
      .then((ok) => {
        if (!ok) {
          setBusy(false)
          setError("Couldn't start the project. Please try again.")
        }
      })
      .catch(() => {
        setBusy(false)
        setError("Couldn't start the project. Please try again.")
      })
  }

  return (
    <div className="flex h-full w-full items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-8 shadow-soft">
        {name && (
          <span className="mb-3 inline-flex items-center gap-2 font-mono text-[11px] text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            Set up · {name}
          </span>
        )}
        <h1 className="font-display text-xl font-semibold tracking-tight">What are we building?</h1>
        <p className="mt-2 text-sm leading-relaxed text-text-muted">
          A line about this project lets the agent set up the right guidelines. It'll take a look at
          what's here, ask a couple of quick questions, then you're off.
        </p>

        <div className="mt-5">
          <label className="mb-1.5 block text-xs font-medium text-text">Tell me about it</label>
          <textarea
            autoFocus
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter submits; plain Enter stays a newline (this is a description, not a chat).
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                start()
              }
            }}
            rows={3}
            placeholder="a recipe app to share meals with my family, simple and works on my phone"
            className="w-full resize-none rounded-xl border border-border bg-bg px-3 py-2.5 text-sm leading-relaxed outline-none transition-colors placeholder:text-text-muted focus:border-accent"
          />
        </div>

        <div className="mt-3.5">
          <label className="mb-1.5 block text-xs font-medium text-text">
            Anything important to keep in mind? <span className="font-normal text-text-muted">(optional)</span>
          </label>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && start()}
            placeholder="must work offline · keep it free"
            className="w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm outline-none transition-colors placeholder:text-text-muted focus:border-accent"
          />
        </div>

        {error && (
          <p className="mt-3 rounded-xl border border-border bg-bg px-3 py-2 text-xs text-red-500">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={skipIntake} disabled={busy}>
            Skip
          </Button>
          <Button size="lg" onClick={start} disabled={!canStart}>
            Get started →
          </Button>
        </div>
      </div>
    </div>
  )
}
