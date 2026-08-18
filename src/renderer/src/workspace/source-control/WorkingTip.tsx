import { useState } from 'react'
import type { GitStatusFile } from '@shared/ipc'
import { Button, PixelGlyph } from '../../ui'
import { gitErrorCopy } from '../../git-error-copy'
import { FileButton } from './shared'
import { selectOnFocus, useProposedVersionMessage } from './use-proposed-version-message'

/**
 * The working tip — the newest moment on the timeline, which is the work you haven't saved yet. It
 * carries the changed files AND the save action in one card, because "2 changes" used to be stated
 * three times (footer chip, Save button, Changes section) and a user counting them had no way to know
 * it was one fact. Saving turns this card calm and the work becomes the newest dot below it.
 *
 * The composer opens already describing the change (`useProposedVersionMessage`): the deterministic
 * floor immediately, the selected generated-text writer's line when it lands. An empty box with a
 * disabled Save was asking the one participant who did not read the diff to summarise it.
 */
export function WorkingTip({
  files,
  truncated,
  activePath,
  onOpenChange,
  onCommitted,
}: {
  files: GitStatusFile[]
  /** The changed count exceeded the status cap, so the list below is clipped. */
  truncated: boolean
  activePath: string | null
  onOpenChange: (path: string) => void
  onCommitted: () => void
}) {
  const [composing, setComposing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { message, setMessage, proposing, begin, reset } = useProposedVersionMessage()
  const dirty = files.length > 0

  function openComposer(): void {
    setComposing(true)
    setError(null)
    begin(files, truncated)
  }

  function cancelComposer(): void {
    setComposing(false)
    setError(null)
    reset()
  }

  async function save(): Promise<void> {
    const msg = message.trim()
    if (!msg || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.koda.gitCommit({ message: msg })
      if (res.ok) {
        reset()
        setComposing(false)
        onCommitted()
      } else {
        setError(gitErrorCopy(res.code, 'save'))
      }
    } catch (err) {
      setError('Could not save a version.')
      console.error('git commit failed', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    // Surface tone and radius, no border: DESIGN.md's card lifts on depth, and a bordered box here
    // stacks a third wall onto a panel that already has a header rule under it.
    <div className="mx-3 mb-1 mt-2 rounded-xl bg-surface px-3 py-2.5 shadow-soft">
      <div className="flex items-center gap-2">
        <PixelGlyph
          glyph={dirty ? 'dotRound' : 'check'}
          size={11}
          className={dirty ? 'text-accent' : 'text-emerald-500'}
        />
        <span className="font-display text-[13px] font-semibold text-text">Right now</span>
        <span className="ml-auto text-[11px] text-text-muted">
          {dirty
            ? `${files.length} ${files.length === 1 ? 'change' : 'changes'} not yet saved`
            : 'all changes saved'}
        </span>
      </div>

      {!dirty ? (
        <p className="mt-1.5 pl-[19px] text-[12px] text-text-muted">
          Nothing waiting. New work shows up here.
        </p>
      ) : (
        <>
          <ul className="mt-1.5 flex flex-col pl-3">
            {files.map((f) => (
              <li key={f.path}>
                <FileButton
                  file={f}
                  mono
                  active={activePath === f.path}
                  onClick={() => onOpenChange(f.path)}
                  title={`See what changed in ${f.path}`}
                />
              </li>
            ))}
            {truncated && (
              <li className="px-1.5 py-1 text-[11px] text-text-muted/70">
                + more changes. Save from chat for very large changes.
              </li>
            )}
          </ul>

          {!composing ? (
            <>
              <Button variant="primary" onClick={openComposer} className="mt-2.5 w-full">
                Save a version
              </Button>
              <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted/80">
                or ask Claude to <span className="text-text">“save a version.”</span>
              </p>
            </>
          ) : (
            <div className="mt-2.5">
              <textarea
                autoFocus
                ref={selectOnFocus}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    void save()
                  } else if (e.key === 'Escape' && !busy) {
                    // Same busy guard as the Cancel button: a mid-save reset would clear the draft
                    // a failing commit still needs to show beside its error.
                    cancelComposer()
                  }
                }}
                rows={2}
                placeholder="Describe this version, e.g. “add the login page”"
                className="w-full resize-none rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text placeholder:text-text-muted/60 focus:border-accent focus:outline-none"
              />
              <div className="mt-2 flex items-center gap-2">
                <Button variant="primary" size="sm" onClick={save} disabled={busy || !message.trim()}>
                  {busy ? 'Saving…' : 'Save version'}
                </Button>
                <Button variant="ghost" size="sm" onClick={cancelComposer} disabled={busy}>
                  Cancel
                </Button>
                {proposing && (
                  <span className="ml-auto flex items-center gap-1.5 text-[11px] text-text-muted/80">
                    <PixelGlyph loader variant="diamond" size={11} className="text-accent" />
                    Writing a description
                  </span>
                )}
              </div>
            </div>
          )}
          {error && <p className="mt-1.5 text-[11px] leading-relaxed text-red-400">{error}</p>}
        </>
      )}
    </div>
  )
}
