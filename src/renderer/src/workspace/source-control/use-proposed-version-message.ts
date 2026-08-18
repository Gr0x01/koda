import { useCallback, useRef, useState } from 'react'
import type { GitStatusFile } from '@shared/ipc'
import { fallbackVersionMessage } from '@shared/version-message'

/**
 * The save composer's description, proposed rather than demanded. Both save surfaces (the Changes
 * footer and the Versions working tip) open with a real sentence in the box instead of an empty
 * field and a disabled button.
 *
 * The order is the whole point:
 *
 *   1. The DETERMINISTIC floor lands first, synchronously, from the file list the surface already
 *      holds. The user can save this instant, every instant. Nothing about the engine is on the path
 *      between "I want to save" and a saved version.
 *   2. The engine's description replaces it when it arrives, and ONLY if the user hasn't typed. A
 *      proposal that overwrites what someone is writing is worse than no proposal.
 *   3. A miss — local model unavailable, Claude not signed in, timeout, toggle off, no bridge at all —
 *      is silent. The floor is already in the box, so there is nothing to report and nothing to retry.
 *
 * The text is selected on open (`selectOnFocus`), so a user who wants their own words replaces the
 * proposal by typing, the way a suggested filename behaves.
 */
export interface ProposedVersionMessage {
  /** What is in the box now. Never empty once `begin` has run. */
  message: string
  setMessage: (next: string) => void
  /** True while the engine turn is out. Saving is available throughout. */
  proposing: boolean
  /** Open the composer: seed the floor, then ask for a better line. */
  begin: (files: GitStatusFile[], truncated?: boolean) => void
  /** Close it and forget the draft. */
  reset: () => void
}

export function useProposedVersionMessage(): ProposedVersionMessage {
  const [message, setMessageState] = useState('')
  const [proposing, setProposing] = useState(false)
  /** Only the newest open may fill the box; an answer to a cancelled composer is dropped. */
  const epoch = useRef(0)

  const setMessage = useCallback((next: string) => setMessageState(next), [])

  const begin = useCallback(
    (files: GitStatusFile[], truncated = false) => {
      const floor = fallbackVersionMessage(files, truncated)
      setMessageState(floor)
      const mine = ++epoch.current
      setProposing(true)
      // Optional-chained and wrapped: after a dev reload the renderer can outlive its preload, and a
      // bridge method that throws (or is simply missing) inside the click handler would leave the
      // "writing" spinner on forever. A miss has to be as quiet here as it is in main.
      void Promise.resolve(window.koda.gitProposeMessage?.({}))
        .then((res) => {
          if (epoch.current !== mine) return
          const better = res?.message?.trim()
          if (!better) return
          // The don't-overwrite-the-user guard: replace only while the box still holds the exact
          // floor this open seeded, captured before the await. Any other content means they typed.
          setMessageState((current) => (current === floor ? better : current))
        })
        .catch((err) => console.error('propose version message failed', err))
        .finally(() => {
          if (epoch.current === mine) setProposing(false)
        })
    },
    [],
  )

  const reset = useCallback(() => {
    epoch.current++
    setProposing(false)
    setMessageState('')
  }, [])

  return { message, setMessage, proposing, begin, reset }
}

/** Select a freshly seeded proposal so typing replaces it wholesale. */
export function selectOnFocus(el: HTMLInputElement | HTMLTextAreaElement | null): void {
  el?.select()
}
