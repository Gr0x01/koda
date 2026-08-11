import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, duration, ease } from '../motion'
import { Markdown } from '../output/Markdown'
import { QuestionCard } from '../transcript/QuestionCard'
import { Button, BusyText, Input } from '../ui'
import { themeStyle } from './face-theme'
import { useWorkspace } from './store'

/**
 * The mini-app FACE (mini-apps-plan.md "Desktop FACE model") — the fronted app filling the window's
 * main area, figure-ground inverted over the workshop. The face IS the running app: the same
 * supervisor-owned process the Preview surface can show, embedded full-bleed. Chrome is deliberately
 * minimal (the app designed its own surface): just the summon — the in-place "Ask or fix this app"
 * line to this project's agent — floating at the bottom. The App/Workshop flip lives in the TitleBar.
 */
export function AppFace() {
  const faceDir = useWorkspace((s) => s.faceDir)
  const app = useWorkspace((s) => (s.faceDir ? s.miniApps.find((a) => a.dir === s.faceDir) : undefined))
  const [phase, setPhase] = useState<'starting' | 'ready' | 'error'>('starting')
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [startNonce, setStartNonce] = useState(0) // bumped by "Try again" to re-run the start effect
  // A cold first open (window + engine warm-up) can sit here for several seconds; without this the
  // spinner is indistinguishable from a hang, so people give up and retry. After a beat we surface
  // that it's still working plus an escape hatch, instead of a featureless "Starting…".
  const [slow, setSlow] = useState(false)
  // The app can host its OWN agent line (folded into its UI) instead of wearing Koda's summon — it
  // claims the line over the face bridge and Koda stands its summon down. False until an app claims it,
  // so an app that says nothing keeps the summon exactly as before.
  const [appOwnsAgentLine, setAppOwnsAgentLine] = useState(false)
  // The bridge-dispatched turn in flight: which session it landed in + the item count at dispatch, so
  // the reply is provably from THIS turn (never an earlier message) and the watchers below track the
  // dispatched session — not `activeId`, which the user can move mid-turn via the workshop flip.
  const [bridgeTurn, setBridgeTurn] = useState<{ id: string; base: number } | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const sendFaceTurn = useWorkspace((s) => s.sendFaceTurn)
  // Fed to an app that hosts its own line so it can show turn progress (the bridge status effect below).
  const bridgeBusy = useWorkspace((s) => (bridgeTurn ? !!s.sessions[bridgeTurn.id]?.busy : false))
  const bridgeNeedsUser = useWorkspace((s) =>
    bridgeTurn ? s.pending.some((p) => p.sessionId === bridgeTurn.id) : false,
  )

  // Any finished turn in this project may have changed the app's code or data — the face keeps up with
  // ALL of them (workshop chat, summon, phone), not just summon turns; a face that only tracks its own
  // pill goes stale the moment the user builds from the chat. Errored turns don't reload: nothing
  // landed, and the summon's restore-the-message UX handles telling the user.
  const busyIds = useWorkspace((s) =>
    Object.keys(s.sessions)
      .filter((id) => s.sessions[id]?.busy)
      .join(','),
  )
  const prevBusy = useRef<Set<string>>(new Set())
  useEffect(() => {
    const now = new Set(busyIds ? busyIds.split(',') : [])
    const s = useWorkspace.getState()
    const landed = [...prevBusy.current].some((id) => {
      if (now.has(id)) return false
      const sess = s.sessions[id]
      return !!sess && !sess.errored && !sess.error
    })
    prevBusy.current = now
    if (!landed || !url) return
    // A turn may also have RESTARTED the server (port moved) — a blind remount would revive the
    // frame on a dead origin, the "stuck Reconnecting" failure. Probe before trusting the captured
    // URL: no-cors resolves opaquely if anything answers, rejects on a dead port.
    fetch(url, { mode: 'no-cors', cache: 'no-store' })
      .then(() => setReloadNonce((n) => n + 1))
      .catch(() => setStartNonce((n) => n + 1))
  }, [busyIds, url])

  // A crashed app auto-restarts on a fresh port; the captured URL is then dead. The supervisor's
  // miniApps:changed refresh updates `app.url` — re-resolve instead of showing a dead frame.
  useEffect(() => {
    if (!url || !app?.url) return
    if (app.url !== url) setStartNonce((n) => n + 1)
  }, [url, app?.url])

  // The listing only carries `url` while running, so the compare above goes blind the moment the app
  // stops or crash-loops — the fronted frame would sit 'ready' on a dead origin forever. A fronted
  // face means "run this app": re-resolve through the idempotent start. One attempt only — if it
  // can't come back, the start effect lands in phase 'error' (the honest card), not a retry loop.
  // 'starting' is deliberately excluded: the in-flight start reports its own success or failure.
  useEffect(() => {
    if (phase !== 'ready') return
    if (app?.state === 'crashed' || app?.state === 'stopped') setStartNonce((n) => n + 1)
  }, [phase, app?.state])

  useEffect(() => {
    if (!faceDir) return
    let stale = false
    setPhase('starting')
    setError(null)
    setAppOwnsAgentLine(false) // a fresh/other app re-claims the line on load; until then, Koda's summon
    // Idempotent under the supervisor: already running resolves immediately with the live URL;
    // stopped/crashed apps get a fresh start (registry-validated in main).
    window.koda
      .miniAppsStart({ dir: faceDir })
      .then(({ url }) => {
        if (stale) return
        setUrl(url)
        setPhase('ready')
      })
      .catch((err) => {
        if (stale) return
        setError(friendlyStartError(String(err)))
        setPhase('error')
      })
    return () => {
      stale = true
    }
  }, [faceDir, startNonce])

  // Flip to the "taking longer than usual" affordance if a start hasn't landed within a few seconds.
  useEffect(() => {
    if (phase !== 'starting') return
    setSlow(false)
    const t = setTimeout(() => setSlow(true), 6000)
    return () => clearTimeout(t)
  }, [phase, startNonce])

  // The face bridge: a mini app can drive its OWN agent line instead of Koda's summon. It posts across
  // the iframe boundary; Koda runs the turn (same grounded path as the summon) and posts status back.
  // Only THIS app's frame at its known origin is trusted — origin AND source are pinned, so no other
  // localhost page can trigger a turn. The app is the owner's own code, so an agent turn from it is the
  // owner acting; the per-app token/consent model (mini-apps-plan Lane B) is for shared apps, not this.
  useEffect(() => {
    if (!url) return
    const appOrigin = safeOrigin(url)
    if (!appOrigin) return
    const post = (msg: unknown): void =>
      iframeRef.current?.contentWindow?.postMessage(msg, appOrigin)
    const onMessage = (e: MessageEvent): void => {
      if (e.origin !== appOrigin || e.source !== iframeRef.current?.contentWindow) return
      const data = e.data as { type?: unknown; text?: unknown } | null
      if (!data || typeof data.type !== 'string') return
      switch (data.type) {
        case 'koda:ready':
          // Announce the bridge so the app renders its own line only where it works — on a surface
          // without the bridge it hears nothing and falls back to Koda's summon (never a dead control).
          post({ type: 'koda:host', agentBridge: true })
          // A landed turn reloads the face at the same moment its reply is ready, so a reply posted
          // then would die with the old document. Deliver it here instead — the reloaded app's own
          // ready announce is the proof there's a live document to receive it.
          if (pendingBridgeReply.current) {
            post({ type: 'koda:reply', text: pendingBridgeReply.current })
            pendingBridgeReply.current = null
          }
          break
        case 'koda:claim-agent-line':
          setAppOwnsAgentLine(true) // the app wears its own line — stand Koda's summon down
          break
        case 'koda:ask':
          if (typeof data.text === 'string') {
            void sendFaceTurn({ text: data.text })
              .then((sessionId) => {
                if (sessionId) {
                  const items = useWorkspace.getState().sessions[sessionId]?.items.length ?? 0
                  setBridgeTurn({ id: sessionId, base: items })
                }
                post({ type: 'koda:ask-result', dispatched: !!sessionId })
              })
              .catch(() => post({ type: 'koda:ask-result', dispatched: false }))
          }
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [url, sendFaceTurn])

  // Push turn status to an app that owns its line so its own control can shimmer/point at an approval.
  useEffect(() => {
    if (!appOwnsAgentLine || !url) return
    const appOrigin = safeOrigin(url)
    if (!appOrigin) return
    const state = bridgeNeedsUser ? 'needs-user' : bridgeBusy ? 'working' : 'idle'
    iframeRef.current?.contentWindow?.postMessage({ type: 'koda:status', state }, appOrigin)
  }, [appOwnsAgentLine, url, bridgeBusy, bridgeNeedsUser])

  // When the bridge-dispatched turn lands, capture the agent's closing message (koda:reply) so an app
  // that asked can show the confirmation/answer in its own voice — the same reply Koda's summon shows
  // as a bubble. Stashed, not posted here: the landed turn also reloads the face, so delivery waits
  // for the reloaded app's koda:ready (above). Errored turns hand over nothing — an old message must
  // never masquerade as a failed ask's confirmation.
  const pendingBridgeReply = useRef<string | null>(null)
  const wasBridgeBusy = useRef(false)
  useEffect(() => {
    if (wasBridgeBusy.current && !bridgeBusy && bridgeTurn) {
      const sess = useWorkspace.getState().sessions[bridgeTurn.id]
      if (sess && !sess.errored && !sess.error) {
        pendingBridgeReply.current = lastAssistantReply(bridgeTurn.id, bridgeTurn.base)
      }
      setBridgeTurn(null)
    }
    wasBridgeBusy.current = bridgeBusy
  }, [bridgeBusy, bridgeTurn])

  if (!app || !faceDir) return null

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-bg">
      {phase === 'starting' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <Monogram name={app.name} icon={app.iconDataUrl} size="lg" />
          <BusyText className="text-sm text-text-muted">Starting {app.name}…</BusyText>
          {slow && (
            <div className="flex flex-col items-center gap-3">
              <p className="max-w-md text-sm leading-relaxed text-text-muted">
                This is taking longer than usual. It is still working. You can wait, or try again.
              </p>
              <div className="flex items-center gap-2.5">
                <Button variant="primary" onClick={() => setStartNonce((n) => n + 1)}>
                  Try again
                </Button>
                <Button variant="secondary" onClick={() => useWorkspace.getState().setFaceView('workshop')}>
                  Open the workshop
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {phase === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <Monogram name={app.name} icon={app.iconDataUrl} size="lg" />
          <p className="max-w-md text-sm leading-relaxed text-text-muted">{error}</p>
          <div className="flex items-center gap-2.5">
            <Button variant="primary" onClick={() => setStartNonce((n) => n + 1)}>
              Try again
            </Button>
            <Button variant="secondary" onClick={() => useWorkspace.getState().setFaceView('workshop')}>
              Open the workshop
            </Button>
          </div>
        </div>
      )}

      {phase === 'ready' && url && (
        <iframe
          key={`${url}:${reloadNonce}`}
          ref={iframeRef}
          src={url}
          title={app.name}
          className="h-full w-full flex-1 border-0 bg-white"
          // Same isolation posture as the Preview surface: cross-origin to Koda's renderer, no preload
          // in subframes, no top-navigation — the app can never drive Koda's window.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          // Camera delegation for faces that capture photos (parity with the phone face — the Mac has a
          // camera too); macOS still gates it behind the system permission prompt.
          allow="camera; microphone"
        />
      )}

      {/* When the app hosts its own agent line, Koda stands its summon down — but still surfaces the one
          thing the app can't: an approval the turn is blocked on. That's the recessive fallback.
          The wrapper maps the app's declared theme tokens onto Koda's CSS vars (display:contents keeps
          it out of layout; custom properties still inherit through), so the overlay chrome wears the
          app's design instead of reading as foreign chrome. */}
      {phase === 'ready' && (
        <div style={themeStyle(app.theme)} className="contents">
          {appOwnsAgentLine ? <AgentNeedsYou /> : <Summon appName={app.name} />}
        </div>
      )}
    </div>
  )
}

/** Parse an origin for postMessage targeting/validation; null if the URL is somehow unparseable. */
function safeOrigin(u: string): string | null {
  try {
    return new URL(u).origin
  } catch {
    return null
  }
}

/** The dispatched session's final assistant message — the reply the face shows/forwards. `after` is
 *  the item count at dispatch: only a message this turn produced counts, so an interrupted or
 *  silent turn yields null instead of resurfacing an earlier answer as this turn's confirmation. */
function lastAssistantReply(sessionId: string, after: number): string | null {
  const sess = useWorkspace.getState().sessions[sessionId]
  if (!sess) return null
  for (let i = sess.items.length - 1; i >= after; i--) {
    const it = sess.items[i]
    if (it.kind === 'assistant') return it.markdown
  }
  return null
}

/** The recessive fallback shown when the app owns its agent line: silent until a turn blocks on
 *  something Koda, not the app, must resolve. An AskUserQuestion renders answerable in place (same
 *  chips as the summon); only a real approval still points at the workshop. */
function AgentNeedsYou() {
  const pendingReq = useWorkspace((s) =>
    s.activeId ? s.pending.find((p) => p.sessionId === s.activeId) : undefined,
  )
  const setFaceView = useWorkspace((s) => s.setFaceView)
  const showingQuestion = useRef(false)
  showingQuestion.current = pendingReq?.toolName === 'AskUserQuestion'
  // "Reply instead" dismisses the question and asks for a composer — this branch has no compose line
  // of its own (the app owns the agent line), so the workshop IS the reply path; without this the
  // dismissal would strand the user with a waiting engine and nowhere to type.
  useEffect(() => {
    const onFocusComposer = (): void => {
      if (showingQuestion.current) setFaceView('workshop')
    }
    window.addEventListener('koda:focus-composer', onFocusComposer)
    return () => window.removeEventListener('koda:focus-composer', onFocusComposer)
  }, [setFaceView])
  if (!pendingReq) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 flex justify-center px-6">
      {pendingReq.toolName === 'AskUserQuestion' ? (
        <div className="pointer-events-auto max-h-[60vh] w-full max-w-xl overflow-y-auto">
          <QuestionCard toolUseId={pendingReq.requestId} input={pendingReq.input} />
        </div>
      ) : (
        <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-surface py-1.5 pl-5 pr-1.5 shadow-pop">
          <span className="text-sm text-text-muted">The agent needs you</span>
          <Button variant="primary" size="sm" onClick={() => setFaceView('workshop')}>
            Open the workshop
          </Button>
        </div>
      )}
    </div>
  )
}

/** The app's identity tile while it has no pixels of its own (warming/error): the manifest icon when
 *  the app declares one, the monogram otherwise. */
function Monogram({ name, icon, size }: { name: string; icon?: string; size: 'lg' }) {
  void size
  if (icon) {
    return <img src={icon} alt="" className="h-14 w-14 rounded-2xl object-cover shadow-soft" />
  }
  return (
    <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent font-display text-2xl font-semibold text-white shadow-soft">
      {(name[0] ?? '?').toUpperCase()}
    </span>
  )
}

/**
 * The summon — collapsed pill → in-place compose line → working shimmer → done (face reloads).
 * Quick data turns ("5x5 squats at 225") and build turns ("this chart is wrong") both go to the
 * project's agent grounded in which app the user is inside; the workshop flip is never required.
 */
function Summon({ appName }: { appName: string }) {
  const sendFaceTurn = useWorkspace((s) => s.sendFaceTurn)
  // The turn this summon dispatched: session id + item count at dispatch. Every watcher below keys off
  // THIS session — never `activeId`, which the user can move mid-turn by flipping to the workshop and
  // selecting another chat (that would fire a false landing edge and bubble an unrelated message).
  const [turn, setTurn] = useState<{ id: string; base: number } | null>(null)
  const busy = useWorkspace((s) => (turn ? (s.sessions[turn.id]?.busy ?? false) : false))
  // The turn hit the approval gate or an AskUserQuestion — busy stays high and the answer lives in the
  // workshop's transcript, which isn't visible. An AskUserQuestion renders right here as the same
  // option chips the workshop shows (answered through the same store path); only a real approval —
  // something the face can't safely resolve — still points at the workshop.
  const pendingReq = useWorkspace((s) =>
    turn ? s.pending.find((p) => p.sessionId === turn.id) : undefined,
  )
  const needsUser = !!pendingReq
  const question = pendingReq?.toolName === 'AskUserQuestion' ? pendingReq : undefined
  const setFaceView = useWorkspace((s) => s.setFaceView)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [working, setWorking] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  // The agent's closing message, shown in-place when the turn lands — the loop's answer half. Without
  // it the line invites "ask a question" but the answer only exists in the workshop (dogfood 08-03).
  const [reply, setReply] = useState<string | null>(null)
  const wasBusy = useRef(false)
  const lastSent = useRef('')
  const showingQuestion = useRef(false)
  showingQuestion.current = working && !!question

  // The busy true→false edge while we're waiting = the summoned turn finished. The face-level watcher
  // owns the reload (it fires for every landed turn, this one included); the summon's job is the
  // outcome UX — a failed turn reopens the compose line with the message restored (a reload alone
  // would swallow a dropped data entry), a landed one surfaces the agent's closing message in-place.
  useEffect(() => {
    if (working && turn && wasBusy.current && !busy) {
      setWorking(false)
      const sess = useWorkspace.getState().sessions[turn.id]
      if (sess?.errored || sess?.error) {
        setText(lastSent.current)
        setOpen(true)
        setHint("That didn't go through — the workshop has the details (⌘\\). Your message is kept here.")
      } else {
        setReply(lastAssistantReply(turn.id, turn.base))
      }
      setTurn(null)
    }
    wasBusy.current = busy
  }, [busy, working, turn])

  // QuestionCard's "Reply instead" asks for the composer; in the face that's the compose line. Scoped
  // to when OUR question card is the one showing (the same event fires from workshop transcript cards
  // for other sessions). The dismissal ends the turn, so drop out of `working` before the busy edge
  // can surface a stale reply.
  useEffect(() => {
    const onFocusComposer = (): void => {
      if (!showingQuestion.current) return
      setWorking(false)
      setTurn(null)
      setReply(null)
      setOpen(true)
    }
    window.addEventListener('koda:focus-composer', onFocusComposer)
    return () => window.removeEventListener('koda:focus-composer', onFocusComposer)
  }, [])

  async function submit(): Promise<void> {
    const msg = text.trim()
    if (!msg) return
    let sessionId: string | null
    try {
      sessionId = await sendFaceTurn({ text: msg })
    } catch {
      setHint("Couldn't reach the agent — the workshop has the details (⌘\\).")
      return
    }
    if (!sessionId) {
      setHint('The agent is mid-task right now — try again in a moment.')
      return
    }
    setTurn({ id: sessionId, base: useWorkspace.getState().sessions[sessionId]?.items.length ?? 0 })
    lastSent.current = msg
    setText('')
    setHint(null)
    setReply(null)
    setOpen(false)
    setWorking(true)
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 flex justify-center px-6">
      <AnimatePresence mode="wait" initial={false}>
        {working && question ? (
          <motion.div
            key="question"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: duration.base, ease: ease.out }}
            className="pointer-events-auto max-h-[60vh] w-full max-w-xl overflow-y-auto"
          >
            <QuestionCard toolUseId={question.requestId} input={question.input} />
          </motion.div>
        ) : working && needsUser ? (
          <motion.div
            key="needs-user"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: duration.base, ease: ease.out }}
            className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-surface py-1.5 pl-5 pr-1.5 shadow-pop"
          >
            <span className="text-sm text-text-muted">The agent needs you</span>
            <Button variant="primary" size="sm" onClick={() => setFaceView('workshop')}>
              Open the workshop
            </Button>
          </motion.div>
        ) : working ? (
          <motion.div
            key="working"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: duration.base, ease: ease.out }}
            className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-border bg-surface px-5 py-2.5 shadow-pop"
          >
            <BusyText className="text-sm text-text-muted">Working on it — the app reloads when done</BusyText>
          </motion.div>
        ) : open ? (
          <motion.div
            key="panel"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: duration.base, ease: ease.out }}
            className="pointer-events-auto w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-pop"
          >
            <div className="border-b border-border px-4 py-2 text-[11px] text-text-muted">
              ✦ {appName} — goes to this project's agent, with the app as context
            </div>
            <div className="flex items-center gap-2.5 p-3">
              <Input
                autoFocus
                mono={false}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit()
                  if (e.key === 'Escape') setOpen(false)
                }}
                placeholder="Log something, ask a question, or say what to fix…"
                className="flex-1"
              />
              <Button variant="primary" onClick={() => void submit()} disabled={!text.trim()}>
                Send
              </Button>
            </div>
            {hint && <p className="px-4 pb-3 text-xs text-text-muted">{hint}</p>}
          </motion.div>
        ) : reply ? (
          <motion.div
            key="reply"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: duration.base, ease: ease.out }}
            className="pointer-events-auto w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-pop"
          >
            <div className="border-b border-border px-4 py-2 text-[11px] text-text-muted">
              ✦ {appName} — from this project's agent
            </div>
            <div className="max-h-48 overflow-y-auto px-4 py-3 text-sm leading-relaxed text-text">
              <Markdown>{reply}</Markdown>
            </div>
            <div className="flex items-center justify-end gap-2 px-3 pb-2.5">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setReply(null)
                  setOpen(true)
                }}
              >
                Reply
              </Button>
              <Button variant="primary" size="sm" onClick={() => setReply(null)}>
                Done
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.button
            key="pill"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: duration.base, ease: ease.out }}
            onClick={() => setOpen(true)}
            className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-surface px-5 py-2.5 text-sm text-text-muted shadow-pop transition-colors hover:border-accent hover:text-text"
          >
            <span className="text-accent">✦</span> Ask or fix this app
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Electron wraps IPC throws as "Error: Error invoking remote method '…': Error: <msg>" — keep the msg. */
function friendlyStartError(raw: string): string {
  const msg = raw.replace(/^Error:\s*/, '').replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
  return `${msg} — the workshop can help you fix it.`
}
