/**
 * face-kit/Pressable.jsx — the tap that feels like a tap. COPY VERBATIM (do not edit per app).
 *
 * Owns tap-state physics on touch, where CSS :hover lies and :active flickers: pressing sets
 * `data-pressed` immediately, a fast tap still shows it for a minimum beat (~120ms) so the button
 * visibly responded, and a finger that slides away cancels it (the native cancel gesture). Pass
 * `haptic` to buzz on commit — only where the action deserves it (a log landing: 'light'; the
 * payoff moment: 'success'); silent on hosts without haptics.
 *
 * The default press style is a subtle opacity dip (face-kit.css); style it yourself with
 * `[data-pressed]` in your own classes, e.g. `data-[pressed]:bg-accent/80`.
 *
 *   <Pressable haptic="light" onClick={log} className="…">Add set</Pressable>
 */

import { useEffect, useRef, useState } from 'react'
import { haptic as fireHaptic } from './host'

const MIN_PRESS_MS = 120
const SLOP_PX = 12

export function Pressable({ as: Tag = 'button', haptic, onClick, className = '', children, ...rest }) {
  const [pressed, setPressed] = useState(false)
  const touch = useRef(null)
  const clearTimer = useRef(null)

  useEffect(() => () => clearTimeout(clearTimer.current), [])

  function release() {
    const held = touch.current ? performance.now() - touch.current.t0 : MIN_PRESS_MS
    touch.current = null
    clearTimeout(clearTimer.current)
    if (held >= MIN_PRESS_MS) setPressed(false)
    else clearTimer.current = setTimeout(() => setPressed(false), MIN_PRESS_MS - held)
  }

  return (
    <Tag
      {...rest}
      className={className}
      data-pressed={pressed || undefined}
      onTouchStart={(e) => {
        rest.onTouchStart?.(e)
        const t = e.touches[0]
        touch.current = { x0: t.clientX, y0: t.clientY, t0: performance.now() }
        setPressed(true)
      }}
      onTouchMove={(e) => {
        rest.onTouchMove?.(e)
        const d = touch.current
        if (!d) return
        const t = e.touches[0]
        if (Math.abs(t.clientX - d.x0) > SLOP_PX || Math.abs(t.clientY - d.y0) > SLOP_PX) {
          // The finger slid away — this became a scroll, not a tap.
          touch.current = null
          clearTimeout(clearTimer.current)
          setPressed(false)
        }
      }}
      onTouchEnd={(e) => {
        rest.onTouchEnd?.(e)
        release()
      }}
      onTouchCancel={(e) => {
        rest.onTouchCancel?.(e)
        touch.current = null
        clearTimeout(clearTimer.current)
        setPressed(false)
      }}
      onClick={(e) => {
        if (haptic) fireHaptic(haptic)
        onClick?.(e)
      }}
    >
      {children}
    </Tag>
  )
}
