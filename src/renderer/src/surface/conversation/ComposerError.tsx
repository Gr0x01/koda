import { friendlyEngineError } from '@shared/engine-error'
import { PixelGlyph } from '../../ui/PixelGlyph'
import { useWorkspace, type EngineErrorBanner } from '../../workspace/store'

/**
 * A failed turn reported as one quiet row fused onto the top of the composer card (under a hairline
 * divider — the call site owns placement). No alarm-red (red belongs to the context meter) and a neutral
 * pixel glyph (amber stays the Stage's "changes" colour): a server hiccup reads as the conversation
 * pausing, not breaking. Retryable failures get an understated "Try again"; must-act ones (auth/billing)
 * get a one-click button straight to the fix, so a signed-out user never has to go hunting for Settings.
 */
export function ComposerError({ error, onRetry }: { error: EngineErrorBanner; onRetry: () => void }) {
  const { title, detail, retryable, action } = friendlyEngineError(error.message, error.fatal)
  const openSettingsTo = useWorkspace((s) => s.openSettingsTo)
  return (
    <div className="flex items-center gap-2 text-[13px] leading-5">
      <PixelGlyph glyph="cross" size={13} className="text-amber-500" label="Turn failed" />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-text">{title}.</span>
        {/* The button carries the instruction for auth/billing, so drop the redundant detail then. */}
        {!retryable && !action && <span className="text-text-muted"> {detail}</span>}
      </span>
      {action ? (
        <button
          onClick={() => openSettingsTo('providers')}
          className="shrink-0 rounded-md bg-accent/15 px-2 py-0.5 font-medium text-accent transition-colors hover:bg-accent/25"
        >
          {action === 'signin' ? 'Sign in' : 'Open settings'}
        </button>
      ) : retryable ? (
        <button
          onClick={onRetry}
          className="shrink-0 text-text-muted underline decoration-text-muted/40 underline-offset-2 transition-colors hover:text-text"
        >
          Try again
        </button>
      ) : null}
    </div>
  )
}

/**
 * The composer's other quiet row: copy the app already wrote, shown verbatim (today: a file that
 * couldn't be attached). Deliberately NOT routed through `friendlyEngineError` — that classifier only
 * speaks engine failure, and a refused file is nothing to do with the engine's health. Same shape and
 * placement as ComposerError so the composer has one notice language rather than two. A `bang` glyph
 * rather than the `cross`: nothing broke, there's just something for the user to do. The text wraps
 * instead of truncating, because the second sentence IS the fix.
 */
export function ComposerNotice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2 text-[13px] leading-5">
      <PixelGlyph glyph="bang" size={13} className="shrink-0 text-amber-500" label="Not attached" />
      <span className="min-w-0 flex-1 text-text">{text}</span>
      <button
        onClick={onDismiss}
        className="shrink-0 text-text-muted underline decoration-text-muted/40 underline-offset-2 transition-colors hover:text-text"
      >
        Dismiss
      </button>
    </div>
  )
}
