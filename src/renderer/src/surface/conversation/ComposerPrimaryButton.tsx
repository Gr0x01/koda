import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { duration, ease } from '../../motion/tokens'

/* ── The composer's one primary button ────────────────────────────────────────────────────────
 * Empty composer → a mic (tap to dictate); anything staged (text or attachments) → morphs into
 * Send. One circle the whole time — only the glyph and fill crossfade — so send never "appears",
 * it grows out of the mic. The state machine, highest priority first:
 *
 *   recording   → stop-dictation control. Dictation streams words into the draft, which would
 *                 otherwise flip the button to Send under the pointer mid-sentence — recording
 *                 OWNS the button until the user stops.
 *   hasContent  → Send.
 *   otherwise   → mic (start dictating).
 *
 * (While a turn runs the composer row shows Stop instead — this button only renders idle.)
 *
 * Dictation is the on-device macOS Speech helper (main process, voice IPC bridge). Push-to-talk:
 * click to start, click to stop. The recognizer reports the WHOLE running transcript on every
 * event (a growing hypothesis, not per-pause deltas), so we compose `base + latest transcript`
 * and REPLACE the draft each event — words appear in the box as you speak. `base` is whatever
 * was in the composer when dictation began, so re-recording naturally appends. Nothing
 * auto-sends; the text just lands in the box to edit + send. If there's no on-device backend
 * (non-mac / not built / permission denied), start returns `started:false` and the button
 * flashes an "unavailable" hint. */

export function ComposerPrimaryButton({
  hasContent,
  draft,
  setText,
  onSend,
}: {
  hasContent: boolean
  draft: string
  setText: (text: string) => void
  onSend: () => void
}) {
  const [recording, setRecording] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const recordingRef = useRef(false)
  const unsubRef = useRef<(() => void) | null>(null)
  // Live mirror of the draft so we can snapshot the pre-dictation text as the base at start time.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const baseRef = useRef('')

  const stop = useCallback((): void => {
    recordingRef.current = false
    setRecording(false)
    unsubRef.current?.()
    unsubRef.current = null
    void window.koda.stopVoice()
  }, [])

  // Tear down a live dictation when the button unmounts (session switch / send / archive).
  useEffect(
    () => () => {
      unsubRef.current?.()
      if (recordingRef.current) void window.koda.stopVoice()
    },
    [],
  )

  async function startDictation(): Promise<void> {
    // Snapshot the text already in the box — speech is composed onto it (so re-recording appends).
    baseRef.current = draftRef.current.trimEnd()
    const compose = (transcript: string): string => {
      const t = transcript.trim()
      if (!t) return baseRef.current
      return baseRef.current ? `${baseRef.current} ${t}` : t
    }
    // Subscribe BEFORE starting so the first transcript line can't be missed.
    const unsub = window.koda.onVoiceEvent((e) => {
      if (e.type === 'partial' || e.type === 'final') setText(compose(e.text ?? ''))
      if (e.type === 'final' || e.type === 'error' || e.type === 'end') stop()
    })
    unsubRef.current = unsub
    const res = await window.koda.startVoice()
    if (!res.started) {
      unsub()
      unsubRef.current = null
      setUnavailable(true)
      setTimeout(() => setUnavailable(false), 2500)
      return
    }
    recordingRef.current = true
    setRecording(true)
  }

  const mode = recording ? 'record' : hasContent ? 'send' : 'mic'
  const label =
    mode === 'record' ? 'Stop dictating' : mode === 'send' ? 'Send' : 'Dictate a message'

  return (
    <button
      onClick={() => {
        if (mode === 'record') stop()
        else if (mode === 'send') onSend()
        else void startDictation()
      }}
      title={unavailable ? "Voice input isn't available here" : label}
      aria-label={label}
      aria-pressed={mode === 'record'}
      className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
        mode === 'record'
          ? 'bg-red-500/15 text-red-500'
          : mode === 'send'
            ? 'bg-accent text-white hover:opacity-90'
            : 'text-text-muted hover:bg-surface hover:text-text'
      }`}
    >
      <AnimatePresence initial={false}>
        <motion.span
          key={mode === 'send' ? 'send' : 'mic'}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={{ duration: duration.fast, ease: ease.out }}
          className="absolute inset-0 flex items-center justify-center"
        >
          {mode === 'send' ? <IconSend /> : <IconMic active={recording} />}
        </motion.span>
      </AnimatePresence>
    </button>
  )
}

function IconSend() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  )
}

function IconMic({ active }: { active: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${active ? 'animate-pulse' : ''}`}
      aria-hidden
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  )
}
