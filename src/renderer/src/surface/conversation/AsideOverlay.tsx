import { type AsideState } from '../../workspace/store'
import { Button, IconButton, BusyText } from '../../ui'

/* ── Aside overlay ────────────────────────────────────────────────────────────────────────────
 * A "btw" side question's answer, floating above the composer — visibly NOT the transcript (the calm
 * aside tint + a "not saved to your chat" label), dismissible, with a quiet "promote to a real
 * message" escape hatch for when the aside turns out to matter. Plain text: an aside answers from
 * context, so it's short prose, not a full rich turn. */
export function AsideOverlay({
  aside,
  onDismiss,
  onPromote,
}: {
  aside: AsideState
  onDismiss: () => void
  onPromote: () => void
}) {
  const waiting = aside.status === 'streaming' && aside.answer.length === 0
  const emptyDone = aside.status === 'done' && aside.answer.length === 0
  // Offer "Add to chat" once there's a real answer to carry. Staging works while the agent is busy (it
  // waits in the composer as a real reply), so this isn't gated on idle.
  const canAddToChat = aside.status === 'done' && aside.answer.trim().length > 0
  return (
    <div className="relative mb-2 rounded-lg border border-aside/40 bg-aside-tint px-3 py-2.5 shadow-pop">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-aside">Aside · not saved to your chat</span>
        <IconButton
          label="Dismiss"
          size="sm"
          onClick={onDismiss}
          className="text-text-muted hover:text-text"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </IconButton>
      </div>
      <div className="mb-1.5 text-[12px] text-text-muted">
        <span className="font-semibold text-aside">You asked · </span>
        {aside.question}
      </div>
      {aside.status === 'error' ? (
        <div className="text-[13px] text-text-muted">{aside.answer || "couldn't answer that"}</div>
      ) : emptyDone ? (
        <div className="text-[13px] text-text-muted">No answer came back — try asking in the main chat.</div>
      ) : waiting ? (
        <BusyText size={12} className="text-[12.5px] text-text-muted [&_.grid]:text-aside">
          Thinking…
        </BusyText>
      ) : (
        <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-text">{aside.answer}</div>
      )}
      {canAddToChat && (
        <div className="mt-2 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={onPromote}
            title="Bring this question and answer into the chat so the agent has it"
            className="text-aside hover:text-aside hover:opacity-80"
          >
            Add to chat
          </Button>
        </div>
      )}
    </div>
  )
}
