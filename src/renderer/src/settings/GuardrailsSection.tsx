import { useEffect, useState, type ReactNode } from 'react'
import { undoPointRefusal, type GuardrailsLayer, type SkillState } from '@shared/ipc'
import { AnimatePresence, duration, ease, motion } from '../motion'
import { useWorkspace } from '../workspace/store'
import { SegmentedControl, SettingsRow, SettingsSection, Toggle } from './controls'
import { Button } from '../ui'

// ── Guardrails (the behavior layer) ────────────────────────────────────────────────
// What shapes the agent — its always-on judgment (rules), focused playbooks (skills), and specialist
// helpers (subagents). Visible on purpose: it's the product's soul, not a dangerous knob. Koda ships a
// curated, protected set; this project's own items are editable, and "+ New" hands authoring to the agent.
type GuardrailScope = 'koda' | 'project'
type ScopeFilter = 'all' | GuardrailScope
type AuthoringKind = 'rule' | 'skill' | 'subagent'

const SCOPE_OPTIONS: { value: ScopeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'koda', label: 'Koda defaults' },
  { value: 'project', label: 'This project' },
]

const GUARDRAIL_GENERIC_ERROR = "Couldn't update guardrails. Your existing settings were left unchanged."

/** Same sentence the file + doc editors use for a save that landed without a recovery point behind it. */
const SAVED_WITHOUT_UNDO = "Saved, but Koda couldn't add this to the recovery timeline."

/** Main refuses a guardrail edit it couldn't first make undoable. That refusal already names what did
 *  NOT happen, and the generic line would send the user back to retry against a broken recovery store
 *  forever, so pass it through. */
function guardrailErrorCopy(err: unknown): string {
  return undoPointRefusal(err) ?? GUARDRAIL_GENERIC_ERROR
}

/** The row version. A row sits directly under the rule it belongs to while the section banner carries
 *  the long sentence, so it stays terse for ordinary failures and speaks up only when it holds
 *  something the banner's generic line doesn't: why the edit was refused. */
function guardrailRowErrorCopy(err: unknown): string {
  return undoPointRefusal(err) ?? "Couldn't update. Try again."
}

export function GuardrailsSection() {
  const [layer, setLayer] = useState<GuardrailsLayer | null>(null)
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [tick, setTick] = useState(0)
  const [error, setError] = useState('')
  const canAuthor = useWorkspace((s) => !!s.activeId && !!s.sessions[s.activeId])

  useEffect(() => {
    window.koda.listGuardrails().then(setLayer).catch(console.error)
  }, [tick])

  const refresh = (): void => setTick((t) => t + 1)

  // Reconcile out-of-band changes (the agent authoring a rule/skill in a session, or a hand-edit of a
  // .claude/*.md) when the window regains focus — replaces the old manual Refresh button.
  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  // Switch a Koda default off/on for this project. Disabling never deletes it (it lives in the bundled
  // pack) — toggling back on restores it. Takes effect on the next session (the engine reads the set at
  // spawn). Optimism isn't worth it here: re-list so every derived bit (counts, styling) stays truthful.
  const toggle = async (key: string, enabled: boolean): Promise<void> => {
    try {
      await window.koda.setGuardrailEnabled({ key, enabled })
      setError('')
    } catch {
      setError(GUARDRAIL_GENERIC_ERROR)
      throw new Error('Guardrail update failed')
    } finally {
      refresh()
    }
  }

  if (!layer) return <div className="px-1 text-[13px] text-text-muted">Loading…</div>

  const pick = scope
  const rules = pick === 'all' ? layer.rules : layer.rules.filter((r) => r.scope === pick)
  const skills = pick === 'all' ? layer.skills : layer.skills.filter((s) => s.scope === pick)
  const subagents = pick === 'all' ? layer.subagents : layer.subagents.filter((s) => s.scope === pick)

  // Normalize a rule (a Koda principle or the project CLAUDE.md) into the shared row shape.
  const ruleProps = (r: GuardrailsLayer['rules'][number]): RowProps => ({
    title: r.title,
    badge: r.path ? 'yours' : r.customized ? 'koda-edited' : 'koda',
    subtitle: r.summary ?? '',
    body: r.body,
    enabled: r.enabled,
    protectedItem: r.kind === 'safety',
    canToggle: !!r.toggleKey,
    resetLabel: r.customized ? 'restore' : null,
    onToggle: async (next) => {
      if (r.toggleKey) await toggle(r.toggleKey, next)
    },
    onSave: async (text) => {
      try {
        // The project CLAUDE.md row is a plain overwrite, which main lets through even when it has no
        // recovery point (refusing would strand the user's typed rules). It reports instead, so say so.
        let noUndo = false
        if (r.principleId) {
          await window.koda.setRuleOverride({ principleId: r.principleId, text })
        } else if (r.path) {
          const res = await window.koda.writeFile({ path: r.path, content: text })
          noUndo = res.checkpointed === false
        }
        setError(noUndo ? SAVED_WITHOUT_UNDO : '')
        refresh()
      } catch (err) {
        setError(guardrailErrorCopy(err))
        throw err
      }
    },
    onReset:
      r.customized && r.principleId
        ? async () => {
            try {
              await window.koda.setRuleOverride({ principleId: r.principleId!, text: null })
              setError('')
              refresh()
            } catch (err) {
              setError(guardrailErrorCopy(err))
              throw err
            }
          }
        : undefined,
  })

  // Normalize a skill/subagent into the same shape. Saving a Koda default forks it into the project.
  const itemProps = (s: GuardrailsLayer['skills'][number], kind: 'skill' | 'subagent'): RowProps => ({
    title: s.name,
    mono: true,
    badge: s.scope === 'koda' ? 'koda' : s.isOverride ? 'koda-edited' : 'yours',
    subtitle: s.description,
    body: s.body,
    enabled: s.enabled,
    canToggle: !!s.toggleKey,
    resetLabel: s.scope === 'project' ? (s.isOverride ? 'restore' : 'delete') : null,
    onToggle: async (next) => {
      if (s.toggleKey) await toggle(s.toggleKey, next)
    },
    onSave: async (text) => {
      await window.koda.saveItemBody({ kind, name: s.name, content: text })
      refresh()
    },
    onReset:
      s.scope === 'project'
        ? async () => {
            await window.koda.removeGuardrailItem({ kind, name: s.name })
            refresh()
          }
        : undefined,
  })

  return (
    <>
      <div className="space-y-2.5">
        <h2 className="font-display text-[15px] font-semibold text-text">Guardrails</h2>
        <p className="text-[13px] leading-relaxed text-text-muted">
          What shapes your agent: its always-on judgment, the skills it reaches for, and the specialist
          helpers it delegates to. Koda ships a curated set that works in every project.{' '}
          <span className="text-text">Flip any off, open one to edit it, or add your own.</span> Nothing
          is lost: anything you change can be restored. Safety rules ask first.
        </p>
        {error && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-text-muted">
            {error}
          </div>
        )}
        <div className="pt-0.5">
          <SegmentedControl ariaLabel="Scope" value={scope} options={SCOPE_OPTIONS} onChange={setScope} />
        </div>
      </div>

      <GuardrailGroup
        title="Rules"
        subtitle="Always-on judgment that shapes every response."
        newKind="rule"
        canAuthor={canAuthor}
        isEmpty={rules.length === 0}
        onChanged={refresh}
      >
        {rules.map((r, i) => (
          <GuardrailRow key={r.toggleKey ?? r.path ?? `rule-${i}`} {...ruleProps(r)} />
        ))}
      </GuardrailGroup>

      <GuardrailGroup
        title="Skills"
        subtitle="Focused playbooks the agent uses when a task calls for one."
        newKind="skill"
        canAuthor={canAuthor}
        isEmpty={skills.length === 0}
        onChanged={refresh}
      >
        {skills.map((s) => (
          <GuardrailRow key={`${s.scope}-${s.name}`} {...itemProps(s, 'skill')} />
        ))}
      </GuardrailGroup>

      <GuardrailGroup
        title="Subagents"
        subtitle="Specialist helpers the agent hands focused work to."
        newKind="subagent"
        canAuthor={canAuthor}
        isEmpty={subagents.length === 0}
        onChanged={refresh}
      >
        {subagents.map((s) => (
          <GuardrailRow key={`${s.scope}-${s.name}`} {...itemProps(s, 'subagent')} />
        ))}
      </GuardrailGroup>
    </>
  )
}

/** Where a catalog skill is turned on. 'everywhere' = the Koda-managed global plugin (every project);
 *  'project' = just this project's .claude/skills; 'off' = neither. (Underneath these are two booleans
 *  — global/project — but a skill on globally is already on here, so the surface offers one clear pick.) */
type SkillScopeValue = 'off' | 'project' | 'everywhere'

/**
 * The skills gallery (Settings → Skills): the bundled, curated Apache-2.0 subset of Anthropic's Agent
 * Skills. A few ship on; the rest are one pick away. Per "curate, not configure" this is a calm grouped
 * list, not a marketplace. Scope picks apply on the next message (the engine reads skills at spawn).
 */
export function SkillsSection() {
  const [skills, setSkills] = useState<SkillState[] | null>(null)
  const [tick, setTick] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)
  const projectPath = useWorkspace((s) => s.projectPath)

  useEffect(() => {
    window.koda.listSkills().then(setSkills).catch(console.error)
  }, [tick])
  const refresh = (): void => setTick((t) => t + 1)

  // Reconcile if the user activated a skill from another window / a different project.
  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  const valueOf = (s: SkillState): SkillScopeValue =>
    s.global ? 'everywhere' : s.project ? 'project' : 'off'

  // Set a skill's scope deterministically (≤2 IPC calls): 'everywhere' = global on / project off;
  // 'project' = global off / project on; 'off' = both off. Re-list after so derived state stays truthful.
  const setScopeFor = async (s: SkillState, next: SkillScopeValue): Promise<void> => {
    if (busyId) return
    const wantGlobal = next === 'everywhere'
    const wantProject = next === 'project'
    setBusyId(s.id)
    try {
      if (s.global !== wantGlobal)
        await window.koda.setSkillActive({ id: s.id, scope: 'global', active: wantGlobal })
      if (s.project !== wantProject)
        await window.koda.setSkillActive({ id: s.id, scope: 'project', active: wantProject })
    } catch (err) {
      console.error(err)
    } finally {
      setBusyId(null)
      refresh()
    }
  }

  if (!skills) return <div className="px-1 text-[13px] text-text-muted">Loading…</div>

  // 'This project' only makes sense with a folder open (a ProjectHome window has none).
  const options: { value: SkillScopeValue; label: string }[] = projectPath
    ? [
        { value: 'off', label: 'Off' },
        { value: 'project', label: 'This project' },
        { value: 'everywhere', label: 'Everywhere' },
      ]
    : [
        { value: 'off', label: 'Off' },
        { value: 'everywhere', label: 'Everywhere' },
      ]

  // Category order follows the catalog (canvas/theme/brand first, advanced last).
  const categories: string[] = []
  for (const s of skills) if (!categories.includes(s.category)) categories.push(s.category)

  return (
    <>
      <div className="space-y-2.5">
        <h2 className="font-display text-[15px] font-semibold text-text">Skills</h2>
        <p className="text-[13px] leading-relaxed text-text-muted">
          Capabilities your agent reaches for when a task calls for one — designing a poster, theming a
          page, co-authoring a doc. Koda turns a few on by default.{' '}
          <span className="text-text">Add any to just this project or everywhere.</span> Changes apply to
          your next message. These are Anthropic's open-source skills.
        </p>
      </div>

      {categories.map((cat) => (
        <SettingsSection key={cat} title={cat}>
          {skills
            .filter((s) => s.category === cat)
            .map((s) => (
              <SettingsRow
                key={s.id}
                label={s.title}
                description={
                  <>
                    {s.blurb}
                    {s.deps !== 'none' && <span className="text-text-muted/70"> · {s.deps}</span>}
                  </>
                }
                control={
                  <SegmentedControl
                    ariaLabel={`${s.title} availability`}
                    value={valueOf(s)}
                    options={options}
                    onChange={(next) => setScopeFor(s, next)}
                  />
                }
              />
            ))}
        </SettingsSection>
      ))}
    </>
  )
}

/**
 * A titled card holding a kind of guardrail, with an inline "+ New" composer offering two paths:
 * **Save** writes what you typed/pasted straight to the project (no agent); **Create with agent**
 * hands it to the running session to author. Save is the no-surprise direct path (paste an existing
 * rule/skill); the agent path is for "describe it and scaffold it for me".
 */
function GuardrailGroup({
  title,
  subtitle,
  newKind,
  canAuthor,
  isEmpty,
  onChanged,
  children,
}: {
  title: string
  subtitle: string
  newKind: AuthoringKind
  canAuthor: boolean
  isEmpty: boolean
  onChanged: () => void
  children: ReactNode
}) {
  const [composing, setComposing] = useState(false)
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const send = useWorkspace((s) => s.sendGuardrailAuthoring)
  const setSettingsOpen = useWorkspace((s) => s.setSettingsOpen)

  const close = (): void => {
    setComposing(false)
    setText('')
    setNote('')
  }

  // Save: write verbatim to the project, no agent round-trip. Surfaces the main-side validation
  // error (missing name, name clash) inline rather than dropping it.
  const save = async (): Promise<void> => {
    if (!text.trim() || saving) return
    setSaving(true)
    try {
      await window.koda.saveGuardrail({ kind: newKind, text })
      onChanged()
      close()
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  // Create with agent: hand the description to the running session; it authors the file (and the
  // user watches it happen, so we close the pane on success).
  const createWithAgent = async (): Promise<void> => {
    if (!text.trim()) return
    const ok = await send({ kind: newKind, description: text })
    if (ok) {
      close()
      setSettingsOpen(false)
    } else {
      setNote("The agent is busy. Try again when it's done, or use Save.")
    }
  }

  const placeholder =
    newKind === 'rule'
      ? 'Type or paste a rule: a short line of guidance. Save adds it as-is, or let the agent shape it.'
      : `Paste a ${newKind} (include its name: line at the top), or describe one for the agent to scaffold.`

  return (
    <section>
      <div className="flex items-baseline justify-between px-1 pb-2">
        <h3 className="font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {title}
        </h3>
        {!composing && (
          <Button variant="ghost" size="sm" onClick={() => setComposing(true)}>
            + New
          </Button>
        )}
      </div>
      <p className="px-1 pb-2 text-[12px] leading-snug text-text-muted">{subtitle}</p>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-soft">
        {composing && (
          <div className="space-y-2.5 px-4 py-3.5">
            <textarea
              autoFocus
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                if (note) setNote('')
              }}
              placeholder={placeholder}
              rows={3}
              className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[12.5px] text-text placeholder:font-sans placeholder:text-text-muted/60 focus:border-accent focus:outline-none"
            />
            {note && <div className="text-[12px] text-text-muted">{note}</div>}
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <div className="flex-1" />
              <Button variant="primary" onClick={save} disabled={!text.trim() || saving}>
                Save
              </Button>
              <Button
                variant="secondary"
                onClick={createWithAgent}
                disabled={!text.trim() || !canAuthor}
                title={canAuthor ? undefined : 'Open a session first'}
              >
                Create with agent
              </Button>
            </div>
          </div>
        )}
        {isEmpty && !composing ? (
          <div className="px-4 py-3.5 text-[12.5px] text-text-muted">Nothing here yet.</div>
        ) : (
          children
        )}
      </div>
    </section>
  )
}

type ResetKind = 'restore' | 'delete'

interface RowProps {
  title: string
  mono?: boolean
  badge: 'koda' | 'koda-edited' | 'yours'
  subtitle: string
  body: string
  enabled: boolean
  protectedItem?: boolean
  canToggle: boolean
  resetLabel: ResetKind | null
  onToggle: (next: boolean) => Promise<void>
  onSave: (text: string) => Promise<void>
  onReset?: () => Promise<void>
}

/**
 * One row for every guardrail — rule, skill, or subagent (the single shape). A calm name + provenance
 * badge + summary with one on/off toggle; clicking the row opens an inline editor where the content
 * edits in place and the contextual reset (Restore default / Delete) lives. Saving a Koda default forks
 * it into the project. A protected (safety) row confirms before switching off.
 */
function GuardrailRow(p: RowProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(p.body)
  const [saving, setSaving] = useState(false)
  // The failure LINE, not a flag: a refused edit (no undo point) has to say why, or the user retries
  // forever against a recovery store that isn't coming back on its own.
  const [failed, setFailed] = useState<string | null>(null)
  const [confirmOff, setConfirmOff] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  // Re-seed the editor when the row re-lists (after a save/toggle/reset), unless it's open mid-edit.
  useEffect(() => {
    if (!open) setDraft(p.body)
  }, [p.body, open])

  const dirty = draft !== p.body

  const save = async (): Promise<void> => {
    if (saving || !dirty) return
    setSaving(true)
    setFailed(null)
    try {
      await p.onSave(draft)
      setOpen(false)
    } catch (e) {
      setFailed(guardrailRowErrorCopy(e))
    } finally {
      setSaving(false)
    }
  }

  const flip = (): void => {
    if (p.enabled && p.protectedItem) {
      setConfirmOff(true)
      return
    }
    void p.onToggle(!p.enabled).catch((e) => setFailed(guardrailRowErrorCopy(e)))
  }

  const reset = async (): Promise<void> => {
    setConfirmReset(false)
    setFailed(null)
    try {
      if (p.onReset) await p.onReset()
    } catch (e) {
      setFailed(guardrailRowErrorCopy(e))
    }
  }

  return (
    <div className={p.enabled ? '' : 'opacity-60'}>
      <div
        onClick={() => setOpen((o) => !o)}
        className="group cursor-pointer px-4 py-3.5 transition-colors hover:bg-bg/40"
      >
        {/* Controls ride the name line so they vertically center on it (items-center), independent of
            the description height below. Resting state is bare; the row reveals "Open ›" on hover, and
            a faint chevron once open. */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`truncate font-medium ${p.mono ? 'font-mono text-[13px]' : 'text-[13.5px]'} ${
                p.enabled ? 'text-text' : 'text-text-muted line-through'
              }`}
            >
              {p.title}
            </span>
            <Badge kind={p.badge} />
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {open ? (
              <Chevron />
            ) : (
              <span className="text-[12px] font-medium leading-none text-text-muted opacity-0 transition-opacity duration-[var(--duration-base)] ease-[var(--ease-out-koda)] group-hover:opacity-100">
                Open&nbsp;›
              </span>
            )}
            {p.canToggle && (
              // flex, not a bare span: an inline-block <button> would sit on the text baseline and
              // reserve descender space below it, floating the toggle above the row's true center.
              <span className="flex" onClick={(e) => e.stopPropagation()}>
                <Toggle checked={p.enabled} onChange={flip} label={`Enable ${p.title}`} />
              </span>
            )}
          </div>
        </div>
        {p.subtitle && (
          <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-text-muted">{p.subtitle}</div>
        )}
        {failed && !open && (
          <div role="status" className="mt-1 text-[12px] text-text-muted">
            {failed}
          </div>
        )}
      </div>

      <AnimatePresence initial={false}>
        {confirmOff && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: duration.fast, ease: ease.out }}
            className="overflow-hidden"
          >
            <div className="mx-4 mb-3 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-text-muted">
              <span className="flex-1">This includes a safety guard. Turning it off removes it.</span>
              {/* Inline amber callout actions: amber-specific color (Turn off) and plain hover (Keep).
                  Neither maps faithfully to a variant — left as raw buttons. */}
              <button
                onClick={() => {
                  setConfirmOff(false)
                  void p.onToggle(false).catch((e) => setFailed(guardrailRowErrorCopy(e)))
                }}
                className="font-medium text-amber-700 transition-opacity hover:opacity-80 dark:text-amber-400"
              >
                Turn off
              </button>
              <button onClick={() => setConfirmOff(false)} className="transition-colors hover:text-text">
                Keep
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: duration.base, ease: ease.out }}
            className="overflow-hidden"
          >
            <div className="space-y-2.5 border-t border-border bg-bg/40 px-4 py-3.5">
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={p.mono ? 14 : 9}
                className="w-full resize-y rounded-lg border border-border bg-surface px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-text focus:border-accent focus:outline-none"
              />
              {failed && (
                <div role="status" className="text-[12px] text-text-muted">
                  {failed}
                </div>
              )}
              <div className="flex items-center gap-2">
                {p.onReset && p.resetLabel && !confirmReset && (
                  // Inline reset trigger: delete = red text-only; restore = muted text-only.
                  // Neither shape exists in the 4 variants without adding bg/border — left as raw buttons.
                  <button
                    onClick={() => setConfirmReset(true)}
                    className={`text-[12px] transition-opacity hover:opacity-80 ${
                      p.resetLabel === 'delete' ? 'text-red-500/80' : 'text-text-muted'
                    }`}
                  >
                    {p.resetLabel === 'restore' ? 'Restore default' : 'Delete'}
                  </button>
                )}
                {confirmReset && (
                  <div className="flex items-center gap-2 text-[12px] text-text-muted">
                    <span>
                      {p.resetLabel === 'restore'
                        ? "Restore Koda's version, discarding your edits?"
                        : 'Delete this for good? (recoverable from the timeline)'}
                    </span>
                    {/* Inline confirm micro-buttons in a status message — left as raw buttons. */}
                    <button onClick={reset} className="font-medium text-text transition-opacity hover:opacity-80">
                      {p.resetLabel === 'restore' ? 'Restore' : 'Delete'}
                    </button>
                    <button onClick={() => setConfirmReset(false)} className="transition-colors hover:text-text">
                      Cancel
                    </button>
                  </div>
                )}
                <div className="flex-1" />
                <Button variant="ghost" onClick={() => { setOpen(false); setDraft(p.body) }}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={save} disabled={saving || !dirty}>
                  Save
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** The faint down-chevron shown on an open row (the resting/hover affordance is the "Open ›" hint). */
function Chevron() {
  return (
    <motion.svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-text-muted/40"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: duration.fast, ease: ease.out }}
    >
      <path d="M6 9l6 6 6-6" />
    </motion.svg>
  )
}

/** Provenance chip: a Koda default (optionally edited by you), or your own. */
function Badge({ kind }: { kind: 'koda' | 'koda-edited' | 'yours' }) {
  if (kind === 'yours') {
    return (
      <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] font-medium text-text-muted/80">
        Yours
      </span>
    )
  }
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className="rounded-full bg-text/5 px-1.5 py-px text-[10px] font-medium text-text-muted">
        Koda
      </span>
      {kind === 'koda-edited' && <span className="text-[10.5px] text-text-muted/80">· edited</span>}
    </span>
  )
}
