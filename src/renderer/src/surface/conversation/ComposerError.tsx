import { friendlyEngineError } from '@shared/engine-error'
import { PixelGlyph } from '../../ui/PixelGlyph'
import type { EngineErrorBanner } from '../../workspace/store'

/**
 * A failed turn reported as one quiet row fused onto the top of the composer card (under a hairline
 * divider — the call site owns placement). No alarm-red (red belongs to the context meter) and a neutral
 * pixel glyph (amber stays the Stage's "changes" colour): a server hiccup reads as the conversation
 * pausing, not breaking. Retryable failures get an understated "Try again"; must-act ones (auth/billing)
 * show the fix inline instead.
 */
export function ComposerError({ error, onRetry }: { error: EngineErrorBanner; onRetry: () => void }) {
  const { title, detail, retryable } = friendlyEngineError(error.message, error.fatal)
  return (
    <div className="flex items-center gap-2 text-[13px] leading-5">
      <PixelGlyph glyph="cross" size={13} className="text-amber-500" label="Turn failed" />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-text">{title}.</span>
        {!retryable && <span className="text-text-muted"> {detail}</span>}
      </span>
      {retryable && (
        <button
          onClick={onRetry}
          className="shrink-0 text-text-muted underline decoration-text-muted/40 underline-offset-2 transition-colors hover:text-text"
        >
          Try again
        </button>
      )}
    </div>
  )
}
