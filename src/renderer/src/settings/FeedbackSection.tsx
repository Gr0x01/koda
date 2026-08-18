import { useRef, useState } from 'react'
import type { FeedbackRequest, FeedbackResult } from '@shared/ipc'
import { Button, Field, Input } from '../ui'
import { SettingsSection, SegmentedControl, Toggle } from './controls'

type Kind = FeedbackRequest['kind']

const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'idea', label: 'Idea' },
  { value: 'question', label: 'Question' },
]

/** Downscale an attached image to a compact JPEG data URL — keeps the IPC payload small and gives an
 *  instant thumbnail. Main downsizes again authoritatively before upload; this just bounds what we
 *  hand across the boundary. Resolves null if the file isn't a readable image. */
function downscaleImage(file: File, maxWidth = 1800): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxWidth / img.width)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

/**
 * Send feedback → a PRIVATE Supabase inbox (main/feedback.ts → the `feedback` edge fn). Feedback is
 * far more useful with a screenshot + recent logs, and those can carry the user's paths/prompts, so it
 * goes to a private sink, never a public tracker. The copy says "private", and the attachments are
 * opt-in and shown before they're sent (the thumbnail is exactly what leaves).
 */
export function FeedbackSection() {
  const [kind, setKind] = useState<Kind>('bug')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [includeLogs, setIncludeLogs] = useState(false)
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const canSend = message.trim().length > 0 && state !== 'sending'

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    const dataUrl = await downscaleImage(file)
    if (dataUrl) setScreenshot(dataUrl)
  }

  const submit = async () => {
    if (!canSend) return
    setState('sending')
    setError(null)
    const r: FeedbackResult = await window.koda.submitFeedback({
      kind,
      message: message.trim(),
      email: email.trim() || undefined,
      screenshot: screenshot || undefined,
      includeLogs,
    })
    if (r.ok) {
      setState('sent')
      setKind('bug')
      setMessage('')
      setEmail('')
      setScreenshot(null)
      setIncludeLogs(false)
    } else {
      setError(r.error)
      setState('error')
    }
  }

  if (state === 'sent') {
    return (
      <SettingsSection title="Send feedback">
        <div className="flex flex-col items-start gap-3 py-3 text-[13px] text-text">
          <p>Thanks, that's in. It helps more than you'd think.</p>
          <Button variant="secondary" onClick={() => setState('idle')}>
            Send more
          </Button>
        </div>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection
      title="Send feedback"
      note="Hit a bug or want something? This comes straight to us, privately. A screenshot or your recent logs makes a bug much easier to fix."
    >
      <div className="flex flex-col gap-3.5 py-3">
        <SegmentedControl value={kind} options={KIND_OPTIONS} onChange={setKind} ariaLabel="Feedback type" />

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          maxLength={5000}
          placeholder="What's on your mind?"
          className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-[12.5px] text-text placeholder:text-text-muted/60 focus:border-accent focus:outline-none"
        />

        {/* Screenshot: attach a file the user picks (not an auto-capture, which would just grab this
            form). The thumbnail is exactly what gets sent. */}
        <input ref={fileRef} type="file" accept="image/*" onChange={onPickFile} className="hidden" />
        {screenshot ? (
          <div className="flex items-center gap-3">
            <img
              src={screenshot}
              alt="Attached screenshot"
              className="h-14 w-14 rounded-lg border border-border object-cover"
            />
            <button
              onClick={() => setScreenshot(null)}
              className="text-[12.5px] text-text-muted transition-colors hover:text-text"
            >
              Remove
            </button>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => fileRef.current?.click()}>
            Add a screenshot
          </Button>
        )}

        <label className="flex cursor-pointer items-center justify-between gap-6">
          <span className="text-[12.5px] leading-snug text-text-muted">
            Include your recent logs, which stay just as private and make a bug much easier to place.
          </span>
          <Toggle checked={includeLogs} onChange={setIncludeLogs} label="Include recent logs" />
        </label>

        <Field label="Email (optional)" description="Only if you'd like a reply.">
          <Input
            mono={false}
            type="email"
            maxLength={200}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>

        {error && <p className="text-[12px] text-red-500">{error}</p>}
        <div>
          <Button variant="primary" onClick={submit} disabled={!canSend}>
            {state === 'sending' ? 'Sending…' : 'Send feedback'}
          </Button>
        </div>
      </div>
    </SettingsSection>
  )
}
