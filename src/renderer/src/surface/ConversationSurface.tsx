import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Transcript } from '../transcript/Transcript'
import { ProjectIntake } from '../onboarding/ProjectIntake'
import { ApprovalPrompt } from '../approval/ApprovalPrompt'
import { TranscriptFind } from './TranscriptFind'
import { anchorPlan } from './transcript-scroll'
import { AnimatePresence, cardVariants, motion } from '../motion'
import { useWorkspace } from '../workspace/store'
import { busyActivity } from '../workspace/activity'
import { ContextReadout, ContinueFreshButton } from '../workspace/ContextMeter'
import { ApprovalModeControl, nextApprovalMode } from '../workspace/ApprovalModeControl'
import { ModelControl } from '../workspace/ModelControl'
import { EffortControl } from '../workspace/EffortControl'
import { Button } from '../ui'
import { SessionHeader } from './conversation/SessionHeader'
import { AsideOverlay } from './conversation/AsideOverlay'
import { ComposerError, ComposerNotice } from './conversation/ComposerError'
import { ComposerPrimaryButton } from './conversation/ComposerPrimaryButton'
import { AttachMenu } from './conversation/AttachMenu'
import { useMentionPicker, inkTokens } from './conversation/useMentionPicker'
import { stagingFromFiles, refusedAttachmentMessage } from './conversation/attach'
import { FileChip } from '../transcript/FileChip'
import { hasRunningDelegation } from '@shared/delegation'
import { windowHasOpenModal } from '../window-modal'

/**
 * The conversation surface (ui-workspace.md §3) — the always-present, premium center of the
 * workspace. A comfortable reading column: structured transcript above, the floating composer below,
 * Ask-me approvals stacked just over it.
 */
/** Breathing room kept under an anchored turn, so its answer never starts flush against the composer. */
const ANCHOR_GAP = 24

export function ConversationSurface() {
  const activeId = useWorkspace((s) => s.activeId)
  const session = useWorkspace((s) => (s.activeId ? s.sessions[s.activeId] : null))
  const postureLocked = !!session && (session.busy || hasRunningDelegation(session.items))
  // Select the stable `pending` ref and filter in render — a selector that returns a fresh array
  // each call makes zustand see a changed snapshot every render (infinite loop).
  const pending = useWorkspace((s) => s.pending)
  // AskUserQuestion rides the pending queue too (it's gate-awaited now), but its UI is the in-transcript
  // QuestionCard — keep it out of the generic ApprovalPrompt stack above the composer.
  const pendingForActive = pending.filter((r) => r.sessionId === activeId && r.toolName !== 'AskUserQuestion')
  const setDraft = useWorkspace((s) => s.setDraft)
  const send = useWorkspace((s) => s.send)
  const queueSend = useWorkspace((s) => s.queueSend)
  const cancelQueued = useWorkspace((s) => s.cancelQueued)
  const answerApproval = useWorkspace((s) => s.answerApproval)
  const interrupt = useWorkspace((s) => s.interrupt)
  const openAgents = useWorkspace((s) => s.openAgents)
  const askAside = useWorkspace((s) => s.askAside)
  const dismissAside = useWorkspace((s) => s.dismissAside)
  const promoteAside = useWorkspace((s) => s.promoteAside)
  const continueInFreshChat = useWorkspace((s) => s.continueInFreshChat)
  const retryLastTurn = useWorkspace((s) => s.retryLastTurn)
  const startSession = useWorkspace((s) => s.startSession)
  const intakePending = useWorkspace((s) => s.intakePending)
  const archiveSession = useWorkspace((s) => s.archiveSession)
  const renameSession = useWorkspace((s) => s.renameSession)
  const setSessionApprovalMode = useWorkspace((s) => s.setSessionApprovalMode)
  const addAttachments = useWorkspace((s) => s.addAttachments)
  const setAttachNotice = useWorkspace((s) => s.setAttachNotice)
  const removeAttachment = useWorkspace((s) => s.removeAttachment)
  // Click a staged thumbnail to inspect it full-size before sending — at 56px square you can't tell two
  // screenshots apart. The shared lightbox (mounted at the Chassis root) handles the overlay + Esc.
  const setLightbox = useWorkspace((s) => s.setLightbox)
  const filesRev = useWorkspace((s) => s.filesRev)

  // Stick-to-bottom: follow the conversation as it grows ONLY while the reader is already at the
  // bottom (or just sent) — the moment they scroll up to read, stop yanking them down.
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const modeRef = useRef<'follow' | 'anchor' | 'free'>('follow')
  /** The last scrollTop we wrote, so our own scrolls aren't mistaken for the reader's. */
  const lastSetTopRef = useRef(0)
  /** Room below the newest turn for it to scroll up into while anchored. Zero the rest of the time. */
  const [anchorPad, setAnchorPad] = useState(0)
  const [findOpen, setFindOpen] = useState(false)
  // `pinnedRef` is a ref (read in effects without re-rendering); the jump-to-bottom button needs a
  // render trigger, so mirror the pinned state here. True while at/near the tail → button hidden.
  const [atBottom, setAtBottom] = useState(true)

  // The composer grows with its content up to a cap (~10 lines), then scrolls — so a pasted paragraph
  // is readable instead of a one-line peephole. The 200px cap is mirrored by max-h on the element.
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // The ink layer: a div painted exactly over the textarea that renders `@` references in accent
  // (everything else transparent). Kept in scroll-register with the textarea here and on its onScroll.
  const inkRef = useRef<HTMLDivElement>(null)
  // Grow the composer to fit its draft (capped at 200px). Bail while the textarea isn't laid out
  // (offsetParent null = an ancestor is display:none — e.g. hidden behind the App face or an expanded
  // preview): scrollHeight reads 0 there, and writing height:0px collapses the box so the placeholder
  // shows only its top sliver when the surface returns. Skipping keeps the last good height instead.
  const resizeComposer = useCallback(() => {
    const el = composerRef.current
    if (!el || el.offsetParent === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
    if (inkRef.current) inkRef.current.scrollTop = el.scrollTop
  }, [])
  useLayoutEffect(() => {
    resizeComposer()
  }, [resizeComposer, session?.draft, activeId])
  // Recompute when the composer's box changes size — covers becoming visible again (0 → real width)
  // and the surface being resized, neither of which is a draft/activeId change. Observe the wrapper
  // (not the textarea, whose height we mutate) so setting height can't feed back into the observer.
  const composerWrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = composerWrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => resizeComposer())
    ro.observe(el)
    return () => ro.disconnect()
  }, [resizeComposer])

  // The "@" file picker: type @ to reference a project document. Owns its own menu + keyboard nav; the
  // textarea's handlers below defer to it (onKeyDown consumes nav/select keys, sync re-detects the token).
  const mentions = useMentionPicker({
    activeId,
    draft: session?.draft ?? '',
    setDraft,
    textareaRef: composerRef,
    revision: filesRev,
  })

  // ⌘F opens find-in-transcript — but only when focus isn't in Monaco (its own ⌘F) or a doc
  // editor (which mounts this same find bar over the doc instead).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (windowHasOpenModal()) return
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.code !== 'KeyF') return
      if ((document.activeElement as HTMLElement | null)?.closest('.monaco-editor, [data-doc-editor]')) return
      e.preventDefault()
      // One find bar at a time: both bars share the global CSS highlight registry, so an already-open
      // doc find bar closes (synchronously) before this one opens — and vice versa.
      window.dispatchEvent(new CustomEvent('koda:find-open'))
      setFindOpen(true)
    }
    function onOtherFind(): void {
      setFindOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('koda:find-open', onOtherFind)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('koda:find-open', onOtherFind)
    }
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
    // Our own writes fire this too. Ignoring them is what keeps an anchored turn from reading as the
    // user scrolling away from it the instant we place it.
    if (Math.abs(el.scrollTop - lastSetTopRef.current) < 2) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    // Scrolling back to the tail resumes following; scrolling anywhere else is the user reading, and
    // nothing moves under them until they come back down.
    modeRef.current = nearBottom ? 'follow' : 'free'
    if (!nearBottom) setAnchorPad(0)
    pinnedRef.current = nearBottom
    setAtBottom(nearBottom)
  }

  /** Measure, then apply what `anchorPlan` decides (see transcript-scroll.ts for the rule itself). */
  const settle = useCallback(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return
    const turn = content.lastElementChild
    const elTop = el.getBoundingClientRect().top
    const turnBox = turn?.getBoundingClientRect()
    const plan = anchorPlan(modeRef.current, {
      viewport: el.clientHeight,
      contentHeight: el.scrollHeight,
      turnTop: turnBox ? turnBox.top - elTop + el.scrollTop : 0,
      turnHeight: turnBox ? content.getBoundingClientRect().bottom - turnBox.top : 0,
      gap: ANCHOR_GAP,
    })
    if (!plan || (modeRef.current === 'anchor' && !turnBox)) return
    modeRef.current = plan.mode
    setAnchorPad(plan.pad)
    lastSetTopRef.current = plan.top
    el.scrollTop = plan.top
  }, [])

  // Stable across renders on purpose: the transcript's items are memoized, and an inline arrow here
  // would be a fresh prop on every streamed event — missing every compare and re-rendering the whole
  // conversation, which is exactly the cost the memoization exists to remove.
  const sessionId = session?.id
  const handleOpenAgents = useCallback(() => {
    if (sessionId) openAgents(sessionId)
  }, [sessionId, openAgents])

  // Jump-to-bottom button: smooth-scroll to the tail and follow again.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    modeRef.current = 'follow'
    setAnchorPad(0)
    pinnedRef.current = true
    setAtBottom(true)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  // After each content change, re-settle. Layout effect = no visible jump. `postureLocked` is a dep so
  // the trailing working indicator appearing/clearing keeps the tail in view even when it toggles
  // without an items change.
  useLayoutEffect(() => {
    settle()
  }, [session?.items, session?.streaming, postureLocked, anchorPad, settle])

  // A ResizeObserver on the content re-settles whenever its height changes, so late-settling content
  // (images decode, code blocks highlight) can't strand us — and a turn folding shut on completion
  // doesn't leave the view hanging in the space its plumbing used to fill.
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const obs = new ResizeObserver(() => settle())
    obs.observe(content)
    return () => obs.disconnect()
  }, [settle])

  // Switching sessions: show the newest message and follow. Re-snap across a few frames while still
  // following so already-laid-out/cached content (where ResizeObserver never fires) doesn't strand us.
  useLayoutEffect(() => {
    modeRef.current = 'follow'
    setAnchorPad(0)
    pinnedRef.current = true
    setAtBottom(true)
    let frame = 0
    settle()
    let raf = 0
    const tick = (): void => {
      settle()
      if (++frame < 4) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [activeId, settle])

  // Queued-send: while the agent is BUSY, typing queues by default — the message is delivered as a normal
  // turn the instant this turn ends (main owns the slot). Enter and the accent primary button queue; the
  // side question ("btw" / aside, answered from context without entering the conversation) becomes an
  // explicit muted secondary button. A stale dev-HMR preload without the queue API falls back to the old
  // aside-first behavior so typing-while-busy still does something.
  const draftHasText = (session?.draft.trim().length ?? 0) > 0
  // Composer content = text OR attachments, so an attachment-only follow-up can queue too (its Enter used
  // to fall into send()'s silent busy guard). A side question stays text-only — there's nothing to ask
  // about with no words.
  const hasComposerContent = !!session && (draftHasText || session.attachments.length > 0)
  const queueAvailable = typeof window.koda.queueTurn === 'function'
  const busyWithContent = !!session && session.busy && hasComposerContent
  const canQueue = busyWithContent && queueAvailable

  // The trailing "agent is working" one-liner. Shown whenever work is in flight, EXCEPT while the
  // streaming caret already signals activity or an active thinking line is the tail (no double cue).
  // `postureLocked`, not `busy`: a backgrounded delegate keeps running after its parent turn ends,
  // and dropping the line there would read as finished while the fan-out is still going.
  const lastItem = session?.items[session.items.length - 1]
  const working =
    session && postureLocked && !session.streaming && !(lastItem?.kind === 'thinking' && lastItem.active)
      ? busyActivity(session)
      : null

  // Submit the composer's primary action: queue while busy (delivered when the turn ends), otherwise a
  // normal turn. Without the queue API, busy+draft falls back to an aside so typing still does something.
  // (`send`/`queueSend` guard empty / image-only / busy themselves.)
  const submitComposer = (): void => {
    if (!activeId || !session) return
    if (session.busy && hasComposerContent) {
      if (queueAvailable) queueSend()
      // Fallback for a stale dev-HMR preload without the queue API: an aside if there's text, otherwise
      // leave attachment-only content in the composer rather than dropping it into send()'s busy guard.
      else if (draftHasText) askAside(activeId, session.draft)
      return
    }
    // A turn you just sent belongs at the top of the viewport, with its answer filling the room below.
    // (There's a millisecond window where the turn just ended for the renderer but main still has a
    // queued dispatch's admission claimed; a fast Enter here does an ordinary send that main rejects into
    // the calm retryable banner — an accepted, deliberately-unfixed edge, not a lost message.)
    pinnedRef.current = true
    modeRef.current = 'anchor'
    setAtBottom(true)
    send()
  }

  // The explicit secondary action while busy: ask a side question from this chat's context.
  const submitAside = (): void => {
    if (!activeId || !session) return
    askAside(activeId, session.draft)
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
    const dropped = [...files]
    // Say what can't come in BEFORE staging the rest: a drop of nothing but HEICs would otherwise read
    // as the app ignoring it. Also clears a stale notice when the next drop is clean.
    setAttachNotice(id, refusedAttachmentMessage(dropped))
    const ok = await stagingFromFiles(dropped)
    if (ok.length) addAttachments(id, ok)
  }

  if (!session) {
    // A project with no guidelines yet (New project, or an existing folder with no CLAUDE.md/AGENTS.md):
    // describe it once → the agent authors the guidelines. Skipping returns to the generic state below.
    if (intakePending) return <ProjectIntake />
    return (
      <div className="flex h-full flex-col items-center justify-center gap-7 px-6 text-center">
        <h2 className="font-display text-[28px] font-medium tracking-tight">What are we building?</h2>
        <Button onClick={() => startSession()}>Start a session</Button>
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
            <span className="text-sm font-medium text-accent">Drop to attach</span>
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
            <Transcript
              items={session.items}
              streaming={session.streaming}
              working={working}
              live={postureLocked}
              turnStartedAt={session.turnStartedAt}
              onOpenAgents={handleOpenAgents}
            />
          </div>
          {/* Room for the newest turn to sit at the top of the viewport. A sibling of the measured
              content on purpose: inside it, it would feed its own height back into the anchor. */}
          <div aria-hidden style={{ height: anchorPad }} />
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
        {/* Queued-send: the message waiting to go out the instant this turn finishes. Main owns the slot,
            so the chip reflects the real queued message (not an optimistic guess). Cancel returns its text
            to the composer. */}
        <AnimatePresence initial={false}>
          {session.queuedTurn && (
            <motion.div key="queued-turn" variants={cardVariants} initial="hidden" animate="visible" exit="hidden">
              <div className="mb-2 flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 shadow-soft">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent" aria-hidden>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] leading-5 text-text">{session.queuedTurn.text || '(attachment)'}</div>
                  <div className="text-[11px] text-text-muted">
                    Queued. Sends when this turn finishes.
                    {session.queuedTurn.attachmentCount > 0 &&
                      ` · ${session.queuedTurn.attachmentCount} attachment${session.queuedTurn.attachmentCount === 1 ? '' : 's'}`}
                  </div>
                </div>
                <button
                  onClick={cancelQueued}
                  title="Cancel queued message"
                  aria-label="Cancel queued message"
                  className="shrink-0 text-[13px] text-text-muted underline decoration-text-muted/40 underline-offset-2 transition-colors hover:text-text"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {/* The input box is the app's hero control: one raised card (soft shadow, generous radius)
            holding the prompt, its attachments, AND the per-session controls strip under a hairline
            divider. */}
        <div className="relative rounded-2xl border border-border bg-surface px-3 py-2 shadow-soft focus-within:border-accent/50">
          {mentions.menu}
          {/* A failed turn (API error / fatal engine stop) reports as a quiet section fused onto the top
              of the composer, under a hairline divider — one object, not a floating alert. Try again
              re-sends the last prompt; sending anything clears it. */}
          {session.error && (
            <div className="mb-2 border-b border-border/60 px-0.5 pb-2">
              <ComposerError error={session.error} onRetry={() => activeId && retryLastTurn(activeId)} />
            </div>
          )}
          {/* A file that couldn't be attached reports in the same fused row. Transient by design: the
              user dismisses it, the next drop replaces it, and sending clears it. */}
          {session.attachNotice && (
            <div className="mb-2 border-b border-border/60 px-0.5 pb-2">
              <ComposerNotice
                text={session.attachNotice}
                onDismiss={() => activeId && setAttachNotice(activeId, null)}
              />
            </div>
          )}
          {session.attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {session.attachments.map((img, i) => (
                <div key={i} className="group relative">
                  {img.mediaType.startsWith('image/') ? (
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
                  ) : (
                    <FileChip name={img.name ?? 'file'} />
                  )}
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
          {/* The prompt row: the text field, then + (attach) and the ONE primary button — mic when
              empty, morphs to Send once anything is staged (see ComposerPrimaryButton) — clustered
              on the right so the controls read as one group even when the draft grows tall. Buttons
              bottom-align (items-end) so they stay anchored as the textarea grows. */}
          <div className="flex items-end gap-2">
            <div ref={composerWrapRef} className="relative min-w-0 flex-1">
            <textarea
              ref={composerRef}
              rows={1}
              value={session.draft}
              // Typing stays enabled while busy — that's how you ask a side question.
              onChange={(e) => {
                if (!activeId) return
                setDraft(activeId, e.target.value)
                mentions.sync()
              }}
              onKeyDown={(e) => {
                // The @ file picker gets first refusal on nav/select/dismiss keys while it's open — so
                // Enter picks a file instead of sending, arrows move the list, Esc closes it.
                if (mentions.onKeyDown(e)) return
                if (e.key === 'Tab' && e.shiftKey) {
                  e.preventDefault()
                  if (activeId)
                    setSessionApprovalMode(activeId, nextApprovalMode(session.approvalMode, postureLocked))
                  return
                }
                // Enter sends (an aside while in aside-mode, else a turn); Shift+Enter is a newline. Skip
                // while an IME is composing (e.g. Japanese) so confirming a candidate doesn't fire.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submitComposer()
                }
              }}
              // Caret moved by click or arrow keys — re-detect whether we're in an @ token.
              onKeyUp={() => mentions.sync()}
              onClick={() => mentions.sync()}
              onBlur={() => mentions.close()}
              onScroll={(e) => {
                if (inkRef.current) inkRef.current.scrollTop = e.currentTarget.scrollTop
              }}
              onPaste={(e) => {
                const files = [...e.clipboardData.items]
                  .filter((it) => it.kind === 'file')
                  .map((it) => it.getAsFile())
                  .filter((f): f is File => f !== null)
                if (activeId && files.length) {
                  // We own a file paste either way now — staged, or refused with a reason. (Text pastes
                  // are `kind: 'string'` and never land here.)
                  e.preventDefault() // don't also paste the filename text
                  attachFiles(activeId, files)
                }
              }}
              placeholder={
                session.busy && queueAvailable
                  ? 'Queue a message for when this turn finishes…'
                  : 'Message the agent…'
              }
              className="block max-h-[200px] w-full resize-none overflow-y-auto bg-transparent px-1 py-1.5 text-sm leading-5 outline-none placeholder:text-text-muted"
            />
            {/* Color only, never weight — a bolder glyph has a different advance and would drift out
                of register with the textarea's own text underneath. */}
            <div
              ref={inkRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-1 py-1.5 text-sm leading-5 text-transparent"
            >
              {inkTokens(session.draft)}
            </div>
            </div>
            <AttachMenu
              onAttach={(staged) => {
                if (activeId) addAttachments(activeId, staged)
              }}
              onRefused={(message) => {
                if (activeId) setAttachNotice(activeId, message)
              }}
              onInsertPaths={(paths) => {
                if (!activeId) return
                const d = session.draft
                const refs = paths.map((p) => `\`${p}\``).join(' ')
                setDraft(activeId, d && !d.endsWith(' ') ? `${d} ${refs} ` : `${d}${refs} `)
                composerRef.current?.focus()
              }}
            />
            {/* Mid-turn, Stop is ALWAYS reachable (graceful interrupt). With a draft, the accent primary
                QUEUES it (delivered when the turn ends) and a muted aside button stays beside it for a
                side question. Idle → the one morphing mic/Send button.
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
                {/* Secondary, muted: ask a side question from this chat's context. Keeps its bg-aside
                    identity; sits before the accent primary so queue reads as the default action. Text
                    only — an aside needs words. */}
                {session.busy && draftHasText && (
                  <button
                    onClick={submitAside}
                    title="Ask aside"
                    aria-label="Ask aside"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-aside/80 text-white transition-opacity hover:opacity-90"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M8 10h8M8 14h5" />
                      <path d="M21 12a9 9 0 1 1-3.6-7.2" />
                    </svg>
                  </button>
                )}
                {/* Primary while busy: queue the draft. Accent send-style, matching the idle Send button. */}
                {canQueue && (
                  <button
                    onClick={submitComposer}
                    title="Queue message"
                    aria-label="Queue message"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-opacity hover:opacity-90"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M12 19V5M5 12l7-7 7 7" />
                    </svg>
                  </button>
                )}
              </>
            ) : (
              <ComposerPrimaryButton
                hasContent={!!session.draft.trim() || session.attachments.length > 0}
                draft={session.draft}
                setText={(t) => activeId && setDraft(activeId, t)}
                onSend={submitComposer}
              />
            )}
          </div>
          {/* Per-session controls ride inside the card under a hairline divider: defaults on the
              left, how full the conversation is on the right. */}
          <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-border/60 px-1 pt-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <ApprovalModeControl
                sessionId={session.id}
                mode={session.approvalMode}
                busy={postureLocked}
              />
              <ModelControl
                sessionId={session.id}
                model={session.model}
                activeModel={session.activeModel}
                busy={postureLocked}
              />
              <EffortControl sessionId={session.id} effort={session.effort} busy={postureLocked} />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ContinueFreshButton
                context={session.context}
                busy={session.busy}
                onClick={continueInFreshChat}
              />
              <ContextReadout context={session.context} openUpward />
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
