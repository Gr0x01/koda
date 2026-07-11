/**
 * Shared shapes for preview-over-relay (input-streaming), imported by both the Mac main process
 * (offscreen render + input replay) and the phone client (canvas draw + input capture).
 * See architecture/preview-over-relay.md.
 *
 * Coordinates are NORMALIZED (0..1) relative to the preview viewport, so the phone never has to know
 * the Mac's render size or DPR — the Mac scales to its offscreen content on replay.
 */

/** The phone's preview canvas size (CSS px). The Mac renders its offscreen window at this size so the
 *  stream is already phone-shaped (no downscale on the common path). Clamped Mac-side to sane bounds. */
export interface PreviewViewport {
  w: number
  h: number
}

/** One input gesture the phone forwards to the Mac to replay on the real page. */
export type PreviewInputEvent =
  | { t: 'down'; x: number; y: number }
  | { t: 'move'; x: number; y: number }
  | { t: 'up'; x: number; y: number }
  /** Scroll: dx/dy are pixel deltas (already in device-independent px; Mac forwards as a wheel). */
  | { t: 'wheel'; x: number; y: number; dx: number; dy: number }
  /** A key press. `key` is a DOM-style key ("a", "Backspace", "Enter", " "). Mac emits keyDown+char+keyUp. */
  | { t: 'key'; key: string }

/** One chunk of an encoded frame. A frame is split into `n` chunks (i = 0..n-1) to stay under the
 *  relay's ~256KB broadcast cap; the phone reassembles by `frameId`. Most frames are a single chunk. */
export interface PreviewFrameChunk {
  frameId: number
  i: number
  n: number
  /** Pixel dimensions of the full encoded frame (for the phone to size its canvas). */
  w: number
  h: number
  mime: string
  /** base64 slice of the encoded image. */
  data: string
}

/** The channel name preview frames fan out on (Mac → phone), alongside worklog/usage/changes. */
export const PREVIEW_CHANNEL = 'preview'
