import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Transcript } from '../transcript/Transcript'
import { ProjectIntake } from '../onboarding/ProjectIntake'
import { ApprovalPrompt } from '../approval/ApprovalPrompt'
import { TranscriptFind } from './TranscriptFind'
import { AnimatePresence, cardVariants, motion } from '../motion'
import { useWorkspace, activeEditor } from '../workspace/store'
import { busyActivity } from '../workspace/activity'
import { ContextReadout } from '../workspace/ContextMeter'
import { ApprovalModeControl, nextApprovalMode } from '../workspace/ApprovalModeControl'
import { ModelControl } from '../workspace/ModelControl'
import { EffortControl } from '../workspace/EffortControl'
import { Button } from '../ui'
import { SessionHeader } from './conversation/SessionHeader'
import { AsideOverlay } from './conversation/AsideOverlay'
import { ComposerError } from './conversation/ComposerError'
import { VoiceInputButton } from './conversation/VoiceInputButton'
import { stagingFromFiles, baseName } from './conversation/imageAttach'

/**
 * The conversation surface (ui-workspace.md §3) — the always-present, premium center of the
 * workspace. A comfortable reading column: structured transcript above, the floating composer below,
 * Ask-me approvals stacked just over it.
 */
export function ConversationSurface() {
  const activeId = useWorkspace((s) => s.activeId)
  const session = useWorkspace((s) => (s.activeId ? s.sessions[s.activeId] : null))
  // Select the stable `pending` ref and filter in render — a selector that returns a fresh array
  // each call makes zustand see a changed snapshot every render (infinite loop).
  const pending = useWorkspace((s) => s.pending)
  // AskUserQuestion rides the pending queue too (it's gate-awaited now), but its UI is the in-transcript
  // QuestionCard — keep it out of the generic ApprovalPrompt stack above the composer.
  const pendingForActive = pending.filter((r) => r.sessionId === activeId && r.toolName !== 'AskUserQuestion')
  const setDraft = useWorkspace((s) => s.setDraft)
  const send = useWorkspace((s) => s.send)
  const answerApproval = useWorkspace((s) => s.answerApproval)
  const interrupt = useWorkspace((s) => s.interrupt)
  const askAside = useWorkspace((s) => s.askAside)
  const dismissAside = useWorkspace((s) => s.dismissAside)
  const promoteAside = useWorkspace((s) => s.promoteAside)
  const retryLastTurn = useWorkspace((s) => s.retryLastTurn)
  const startSession = useWorkspace((s) => s.startSession)
  const intakePending = useWorkspace((s) => s.intakePending)
  const archiveSession = useWorkspace((s) => s.archiveSession)
  const renameSession = useWorkspace((s) => s.renameSession)
  const setSessionApprovalMode = useWorkspace((s) => s.setSessionApprovalMode)
  const addAttachments = useWorkspace((s) => s.addAttachments)
  const removeAttachment = useWorkspace((s) => s.removeAttachment)
  // Click a staged thumbnail to inspect it full-size before sending — at 56px square you can't tell two
  // screenshots apart. The shared lightbox (mounted at the Chassis root) handles the overlay + Esc.
  const setLightbox = useWorkspace((s) => s.setLightbox)
  // The file the user is looking at travels to the agent as ambient context on send (store.send). Show
  // it here so they know it's in view — a doc or a code file, never the preview. `surfaces` is a stable
  // store ref; deriving in render avoids a fresh-array selector (which would loop zustand).
  const editor = useWorkspace(activeEditor)
  const viewingFile = editor.surfaces.find((s) => s.path === editor.activeSurfaceId && s.kind !== 'preview')

  // Stick-to-bottom: follow the conversation as it grows ONLY while the reader is already at the
  // bottom (or just sent) — the moment they scroll up to read, stop yanking them down.
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [findOpen, setFindOpen] = useState(false)
  // `pinnedRef` is a ref (read in effects without re-rendering); the jump-to-bottom button needs a
  // render trigger, so mirror the pinned state here. True while at/near the tail → button hidden.
  const [atBottom, setAtBottom] = useState(true)

  // The composer grows with its content up to a cap (~10 lines), then scrolls — so a pasted paragraph
  // is readable instead of a one-line peephole. The 200px cap is mirrored by max-h on the element.
  const composerRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [session?.draft, activeId])

  // ⌘F opens find-in-transcript — but only when focus isn't in Monaco (the editor keeps its own ⌘F).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.code !== 'KeyF') return
      if ((document.activeElement as HTMLElement | null)?.closest('.monaco-editor')) return
      e.preventDefault()
      setFindOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // "Reply instead" on a question card dismisses it and asks us to hand focus to the composer so the
  // user can type their own answer right away.
  useEffect(() => {
    function onFocus(): void {
      composerRef.current?.focus()
    }
    window.addEventListener('koda:focus-composer', onFocus)
    return () => window.removeEventListener('koda:focus-composer', onFocus)
  }, [])

  function onScroll(): void {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinnedRef.current = nearBottom
    setAtBottom(nearBottom)
  }

  // Jump-to-bottom button: smooth-scroll to the tail and re-pin so streaming follows again.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = true
    setAtBottom(true)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  // After each content change, if pinned, snap to the bottom. Layout effect = no visible jump.
  // `busy` is a dep so the trailing working indicator appearing/clearing keeps the tail in view even
  // when it toggles without an items change.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [session?.items, session?.streaming, session?.busy])

  // A ResizeObserver on the content re-snaps to the tail whenever its height grows while pinned, so
  // late-settling content (images decode, code blocks highlight) can't strand us above the fold.
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const obs = new ResizeObserver(() => {
      const el = scrollRef.current
      if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
    })
    obs.observe(content)
    return () => obs.disconnect()
  }, [])

  // Switching sessions: show the newest message and re-pin. Re-snap across a few frames while still
  // pinned so already-laid-out/cached content (where ResizeObserver never fires) doesn't strand us.
  useLayoutEffect(() => {
    pinnedRef.current = true
    setAtBottom(true)
    let frame = 0
    const snap = (): void => {
      const el = scrollRef.current
      if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
    }
    snap()
    let raf = 0
    const tick = (): void => {
      snap()
      if (++frame < 4) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [activeId])

  // "Btw" / aside: while the agent is BUSY, typing means a side question (answered from context, never
  // entering the conversation) rather than a queued instruction. It tracks busy LIVE — the instant the
  // turn finishes, a half-typed aside becomes a normal message (the banner/placeholder/send button flip,
  // so it's visible, not silent), because with the agent idle there's nothing to avoid interrupting.
  const draftHasText = (session?.draft.trim().length ?? 0) > 0
  // A note staged from "Add to chat" (replyStaged) is a real message, so it stays OUT of aside-mode even
  // while the agent is busy — that's how a side answer flows back to the agent.
  const asideMode = !!session && draftHasText && !session.replyStaged && session.busy

  // The trailing "agent is working" one-liner. Shown whenever the turn is running, EXCEPT while the
  // streaming caret already signals activity or an active thinking line is the tail (no double cue).
  const lastItem = session?.items[session.items.length - 1]
  const working =
    session && session.busy && !session.streaming && !(lastItem?.kind === 'thinking' && lastItem.active)
      ? busyActivity(session)
      : null

  // Submit the composer: an aside while in aside-mode, otherwise a normal turn. (`send` guards empty /
  // image-only / busy itself.) Pin to the tail before a real turn so the new item snaps into view.
  const submitComposer = (): void => {
    if (!activeId || !session) return
    if (asideMode) {
      askAside(activeId, session.draft)
      return
    }
    pinnedRef.current = true
    send()
  }

  // Drag-and-drop feedback: light up the whole surface while a file is dragged over it.
  // dragenter/dragleave fire per child element, so count depth rather than toggle — active while depth > 0.
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const isFileDrag = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')
  const onDragEnter = (e: React.DragEvent): void => {
    if (!isFileDrag(e)) return
    dragDepth.current += 1
    setDragActive(true)
  }
  const onDragLeave = (e: React.DragEvent): void => {
    if (!isFileDrag(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }
  const onSurfaceDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    if (activeId && e.dataTransfer.files.length) attachFiles(activeId, e.dataTransfer.files)
  }

  async function attachFiles(id: string, files: Iterable<File>): Promise<void> {
    const ok = await stagingFromFiles(files)
    if (ok.length) addAttachments(id, ok)
  }

  if (!session) {
    // A project with no guidelines yet (New project, or an existing folder with no CLAUDE.md/AGENTS.md):
    // describe it once → the agent authors the guidelines. Skipping returns to the generic state below.
    if (intakePending) return <ProjectIntake />
    return (
      <div className="flex h-full flex-col items-center justify-center gap-7 px-6 text-center">
        <h2 className="font-display text-[28px] font-medium tracking-tight">What are we building?</h2>
        <Button onClick={startSession}>Start a session</Button>
      </div>
    )
  }

  return (
    <div
      className="relative flex h-full w-full flex-col"
      onDragEnter={onDragEnter}
      onDragOver={(e) => isFileDrag(e) && e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onSurfaceDrop}
    >
      {/* Drop feedback: the whole surface tints + dashes while a file is dragged over it, so there's
          no guessing where a dropped image lands. pointer-events-none so the drag events keep
          reaching the container underneath. */}
      <AnimatePresence>
        {dragActive && (
          <motion.div
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-accent/60 bg-accent/[0.06] backdrop-blur-[1px]"
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.5-3.5a2 2 0 0 0-2.8 0L5 21" />
            </svg>
            <span className="text-sm font-medium text-accent">Drop image to attach</span>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Session title row — top-aligned (h-9) so it lines up with the sidebar/dock headers instead
          of dropping low, but borderless/light (no "bar"). Content centered to the reading column so
          the title + actions sit with the transcript, not floating out at the far panel edge. */}
      <div className="mx-auto flex h-9 w-full max-w-3xl shrink-0 items-center px-3">
        {/* key by session so rename / menu state never carries over when focus moves between sessions. */}
        <SessionHeader
          key={session.id}
          label={session.label}
          onRename={(name) => activeId && renameSession(activeId, name)}
          onArchive={() => activeId && archiveSession(activeId)}
        />
      </div>
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4 px-3 pb-3 pt-1">
      {/* Bleed to the panel edge (-mx-3 cancels the outer px-3) so the scrollbar sits at the true
          right edge, then re-inset the transcript with px-4 — keeps the bar in the gutter off the
          text while content stays aligned with the header/composer. The relative wrapper anchors the
          jump-to-bottom button to the viewport's bottom-center. */}
      <div className="relative -mx-3 min-h-0 flex-1">
        {/* A fresh session gets a composed moment instead of a void: the display-face invitation,
            centered where the transcript will live. An overlay (not a scroll-area swap) so the
            stick-to-bottom machinery underneath never remounts; it fades out as the first turn lands. */}
        <AnimatePresence>
          {session.items.length === 0 && !session.busy && (
            <motion.div
              key="hero"
              variants={cardVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className="pointer-events-none absolute inset-0 flex items-center justify-center px-6"
            >
              <h2 className="font-display text-[28px] font-medium tracking-tight text-text">
                What are we building?
              </h2>
            </motion.div>
          )}
        </AnimatePresence>
        {/* pb-10 keeps the last message clear of the scrim below, so at rest it reads fully crisp;
            overflowing content scrolls up under the scrim and softens instead of hard-clipping. */}
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-4 pb-10">
          <div ref={contentRef}>
            <Transcript items={session.items} streaming={session.streaming} working={working} />
          </div>
        </div>
        {/* Gradient scrim painted over the bottom of the transcript (bg → transparent). Always present
            so the transcript never meets the composer at a hard line, whatever the scroll position. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-12 bg-gradient-to-t from-bg to-transparent" />
        {findOpen && <TranscriptFind containerRef={scrollRef} onClose={() => setFindOpen(false)} />}
        <AnimatePresence>
          {!atBottom && (
            // Centering lives on a plain wrapper: cardVariants animate transform, and motion's inline
            // style would override a class-based -translate-x-1/2 (the button sat 16px off-center).
            <div key="jump" className="absolute bottom-2 left-1/2 z-20 -translate-x-1/2">
            <motion.button
              variants={cardVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              onClick={scrollToBottom}
              title="Jump to latest"
              aria-label="Jump to latest"
              className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface text-text-muted shadow-pop transition-colors hover:text-text"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14M19 12l-7 7-7-7" />
              </svg>
            </motion.button>
            </div>
          )}
        </AnimatePresence>
      </div>

      <div>
        {/* Ask-me approvals for the active session stack above the composer; empty in Auto-approve.
            AnimatePresence so each prompt slides/fades in when raised and out when answered. */}
        <AnimatePresence initial={false}>
          {pendingForActive.map((req) => (
            <motion.div key={req.requestId} variants={cardVariants} initial="hidden" animate="visible" exit="hidden">
              <ApprovalPrompt
                request={req}
                active={pendingForActive.length === 1}
                onAllow={(postPlanMode) => answerApproval(req.requestId, 'allow', postPlanMode)}
                onDeny={() => answerApproval(req.requestId, 'deny')}
              />
            </motion.div>
          ))}
        </AnimatePresence>
        {/* What the agent can see: the file you're looking at rides along as context on the next send.
            A quiet cue so that's never a surprise — shown only when a file (doc or code) is open. */}
        {viewingFile && (
          <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] text-text-muted">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span className="truncate">
              Agent can see <span className="text-text/80">{baseName(viewingFile.path)}</span>
            </span>
          </div>
        )}
        {/* A "btw" / aside answer floats above the composer — clearly NOT part of the transcript. */}
        <AnimatePresence initial={false}>
          {session.aside && (
            <motion.div key={session.aside.id} variants={cardVariants} initial="hidden" animate="visible" exit="hidden">
              <AsideOverlay
                aside={session.aside}
                onDismiss={() => activeId && dismissAside(activeId)}
                onPromote={() => activeId && promoteAside(activeId)}
              />
            </motion.div>
          )}
        </AnimatePresence>
        {/* The input box is the app's hero control: one raised card (soft shadow, generous radius)
            holding the prompt, its attachments, AND the per-session controls strip under a hairline
            divider. In aside mode it shifts to a calm secondary look so a side question never reads
            as an action on the project. */}
        <div
          className={
            asideMode
              ? 'rounded-2xl border border-aside/50 bg-aside-tint px-3 py-2 shadow-soft'
              : 'rounded-2xl border border-border bg-surface px-3 py-2 shadow-soft focus-within:border-accent/50'
          }
        >
          {/* A failed turn (API error / fatal engine stop) reports as a quiet section fused onto the top
              of the composer, under a hairline divider — one object, not a floating alert. Try again
              re-sends the last prompt; sending anything clears it. */}
          {session.error && (
            <div className="mb-2 border-b border-border/60 px-0.5 pb-2">
              <ComposerError error={session.error} onRetry={() => activeId && retryLastTurn(activeId)} />
            </div>
          )}
          {asideMode && (
            <div className="mb-1 flex items-center gap-1.5 px-0.5 pt-0.5 text-[11px] text-aside">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 10h8M8 14h5" />
                <path d="M21 12a9 9 0 1 1-3.6-7.2" />
                <circle cx="20" cy="6" r="2" fill="currentColor" stroke="none" />
              </svg>
              <span>Side question — answers from this chat, won&rsquo;t interrupt or change anything</span>
            </div>
          )}
          {session.attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {session.attachments.map((img, i) => (
                <div key={i} className="group relative">
                  <button
                    type="button"
                    onClick={() => setLightbox(img)}
                    title="Click to view"
                    className="block h-14 w-14 overflow-hidden rounded-lg border border-border bg-bg"
                  >
                    <img
                      src={`data:${img.mediaType};base64,${img.dataBase64}`}
                      alt="attachment"
                      className="h-full w-full object-contain"
                    />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      if (activeId) removeAttachment(activeId, i)
                    }}
                    title="Remove"
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-text text-[10px] leading-none text-bg opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* The prompt row: the text field with dictate + send kept inside the input box. Buttons
              bottom-align (items-end) so they stay anchored as the textarea grows. */}
          <div className="flex items-end gap-2">
            <textarea
              ref={composerRef}
              rows={1}
              value={session.draft}
              // Typing stays enabled while busy — that's how you ask a side question.
              onChange={(e) => {
                if (!activeId) return
                setDraft(activeId, e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && e.shiftKey) {
                  e.preventDefault()
                  if (activeId) setSessionApprovalMode(activeId, nextApprovalMode(session.approvalMode, session.busy))
                  return
                }
                // Enter sends (an aside while in aside-mode, else a turn); Shift+Enter is a newline. Skip
                // while an IME is composing (e.g. Japanese) so confirming a candidate doesn't fire.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submitComposer()
                }
              }}
              onPaste={(e) => {
                const files = [...e.clipboardData.items]
                  .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                  .map((it) => it.getAsFile())
                  .filter((f): f is File => f !== null)
                if (activeId && files.length) {
                  e.preventDefault() // don't also paste the filename text
                  attachFiles(activeId, files)
                }
              }}
              placeholder={asideMode ? "Ask a quick question — won't interrupt or change anything" : 'Message the agent…'}
              className="max-h-[200px] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1.5 text-sm leading-5 outline-none placeholder:text-text-muted"
            />
            <VoiceInputButton
              disabled={session.busy}
              draft={session.draft}
              setText={(t) => activeId && setDraft(activeId, t)}
            />
            {/* Mid-turn, Stop is ALWAYS reachable (graceful interrupt) — so anyone who didn't mean to ask a
                side question can still just stop the agent. When they're typing an aside, the muted
                aside-send appears beside it. Idle → the normal ink Send.
                These stay as plain rounded-full buttons — <Button> is rounded-lg and would change the shape. */}
            {session.busy ? (
              <>
                <button
                  onClick={() => activeId && interrupt(activeId)}
                  title="Stop"
                  aria-label="Stop"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-text/8 text-text transition-colors hover:bg-text/15"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
                {asideMode && (
                  <button
                    onClick={submitComposer}
                    title="Ask aside"
                    aria-label="Ask aside"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-aside text-white transition-colors hover:opacity-90"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M12 19V5M5 12l7-7 7 7" />
                    </svg>
                  </button>
                )}
              </>
            ) : (
              <button
                onClick={submitComposer}
                disabled={!session.draft.trim() && session.attachments.length === 0}
                title="Send"
                aria-label="Send"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-colors hover:opacity-90 disabled:bg-text/10 disabled:text-text-muted"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
          {/* Per-session controls ride inside the card under a hairline divider: defaults on the
              left, how full the conversation is on the right. */}
          <div
            className={`mt-1.5 flex items-center justify-between gap-2 border-t px-1 pt-1.5 ${
              asideMode ? 'border-aside/25' : 'border-border/60'
            }`}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <ApprovalModeControl sessionId={session.id} mode={session.approvalMode} busy={session.busy} />
              <ModelControl
                sessionId={session.id}
                model={session.model}
                activeModel={session.activeModel}
                busy={session.busy}
              />
              <EffortControl sessionId={session.id} effort={session.effort} busy={session.busy} />
            </div>
            <ContextReadout context={session.context} openUpward />
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
