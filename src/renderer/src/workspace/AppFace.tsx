import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, duration, ease } from '../motion'
import { Button, BusyText, Input } from '../ui'
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
    if (landed) setReloadNonce((n) => n + 1)
  }, [busyIds])

  // A crashed app auto-restarts on a fresh port; the captured URL is then dead. The supervisor's
  // miniApps:changed refresh updates `app.url` — re-resolve instead of showing a dead frame.
  useEffect(() => {
    if (!url || !app?.url) return
    if (app.url !== url) setStartNonce((n) => n + 1)
  }, [url, app?.url])

  useEffect(() => {
    if (!faceDir) return
    let stale = false
    setPhase('starting')
    setError(null)
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

  if (!app || !faceDir) return null

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-bg">
      {phase === 'starting' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <Monogram name={app.name} size="lg" />
          <BusyText className="text-sm text-text-muted">Starting {app.name}…</BusyText>
        </div>
      )}

      {phase === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <Monogram name={app.name} size="lg" />
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
          src={url}
          title={app.name}
          className="h-full w-full flex-1 border-0 bg-white"
          // Same isolation posture as the Preview surface: cross-origin to Koda's renderer, no preload
          // in subframes, no top-navigation — the app can never drive Koda's window.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        />
      )}

      {phase === 'ready' && <Summon appName={app.name} />}
    </div>
  )
}

/** The app's identity tile while it has no pixels of its own (warming/error) — manifest icons are a
 *  later seam; the monogram is the v0 face-of-the-face. */
function Monogram({ name, size }: { name: string; size: 'lg' }) {
  void size
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
  const busy = useWorkspace((s) => (s.activeId ? (s.sessions[s.activeId]?.busy ?? false) : false))
  // The turn hit the approval gate or an AskUserQuestion — busy stays high and the answer lives in the
  // workshop's transcript, which isn't visible. The summon must say so, not shimmer forever.
  const needsUser = useWorkspace((s) =>
    s.activeId ? s.pending.some((p) => p.sessionId === s.activeId) : false,
  )
  const setFaceView = useWorkspace((s) => s.setFaceView)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [working, setWorking] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const wasBusy = useRef(false)
  const lastSent = useRef('')

  // The busy true→false edge while we're waiting = the summoned turn finished. The face-level watcher
  // owns the reload (it fires for every landed turn, this one included); the summon's job is the
  // failure UX — a failed turn reopens the compose line with the message restored, because a reload
  // alone would swallow a dropped data entry.
  useEffect(() => {
    if (working && wasBusy.current && !busy) {
      setWorking(false)
      const s = useWorkspace.getState()
      const sess = s.activeId ? s.sessions[s.activeId] : undefined
      if (sess?.errored || sess?.error) {
        setText(lastSent.current)
        setOpen(true)
        setHint("That didn't go through — the workshop has the details (⌘\\). Your message is kept here.")
      }
    }
    wasBusy.current = busy
  }, [busy, working])

  async function submit(): Promise<void> {
    const msg = text.trim()
    if (!msg) return
    let dispatched: boolean
    try {
      dispatched = await sendFaceTurn({ text: msg })
    } catch {
      setHint("Couldn't reach the agent — the workshop has the details (⌘\\).")
      return
    }
    if (!dispatched) {
      setHint('The agent is mid-task right now — try again in a moment.')
      return
    }
    lastSent.current = msg
    setText('')
    setHint(null)
    setOpen(false)
    setWorking(true)
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 flex justify-center px-6">
      <AnimatePresence mode="wait" initial={false}>
        {working && needsUser ? (
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
