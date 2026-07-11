import { useCallback, useEffect, useRef, useState } from 'react'

/* ── Voice input ──────────────────────────────────────────────────────────────────────────────
 * A mic button that dictates LIVE into the composer via the on-device macOS Speech helper (main
 * process, over the voice IPC bridge). Push-to-talk: click to start, click to stop. The recognizer
 * reports the WHOLE running transcript on every event (a growing hypothesis, not per-pause deltas),
 * so we compose `base + latest transcript` and REPLACE the draft each event — words appear in the
 * box as you speak. `base` is whatever was in the composer when dictation began, so re-recording
 * naturally appends. Nothing auto-sends; the text just lands in the box to edit + send. The UI
 * clears on `final`/`error`/`end`. If there's no on-device backend (non-mac / not built / permission
 * denied), start returns `started:false` and the button flashes an "unavailable" hint. */

export function VoiceInputButton({
  disabled,
  draft,
  setText,
}: {
  disabled: boolean
  draft: string
  setText: (text: string) => void
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

  // Tear down a live dictation when the button unmounts (session switch / archive).
  useEffect(
    () => () => {
      unsubRef.current?.()
      if (recordingRef.current) void window.koda.stopVoice()
    },
    [],
  )

  async function toggle(): Promise<void> {
    if (recording) {
      stop()
      return
    }
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

  return (
    <button
      onClick={() => void toggle()}
      disabled={disabled}
      title={
        unavailable
          ? "Voice input isn't available here"
          : recording
            ? 'Stop dictating'
            : 'Dictate a message'
      }
      aria-label={recording ? 'Stop dictating' : 'Dictate a message'}
      aria-pressed={recording}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-30 ${
        recording ? 'bg-red-500/15 text-red-500' : 'text-text-muted hover:bg-surface hover:text-text'
      }`}
    >
      <IconMic active={recording} />
    </button>
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
