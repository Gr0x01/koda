/**
 * face-kit/Field.jsx — the text input that behaves. COPY VERBATIM (do not edit per app).
 *
 * Owns the keyboard contract every input needs and every hand-rolled one gets wrong somewhere:
 * it scrolls itself into view above the keyboard after the keys animate up, the return key reads
 * "done" and actually closes the keyboard (the single most common "keyboard won't close" bug),
 * and the right keyboard appears per field (pass `inputMode` / `type` as usual). Appearance is
 * the app's via className. Blur-on-scroll comes from AppShell/Sheet, which own the scroll.
 *
 *   <Field inputMode="decimal" placeholder="0" value={g} onChange={…}
 *          onEnter={commit} className="rounded-xl border …" />
 *   <Field multiline rows={3} … />   // textarea; return inserts a newline as expected
 *
 * `onEnter` fires when the user commits with the return key (single-line only), after the
 * keyboard has been dismissed — wire your save to it and the flow feels native.
 */

export function Field({ multiline = false, onEnter, onFocus, onKeyDown, enterKeyHint, className = '', ...rest }) {
  const Tag = multiline ? 'textarea' : 'input'
  return (
    <Tag
      {...rest}
      enterKeyHint={enterKeyHint ?? (multiline ? undefined : 'done')}
      className={className}
      onFocus={(e) => {
        onFocus?.(e)
        const el = e.currentTarget
        // The bridge pushes --kb pre-animation; the scrollport's --kb padding opens the room, and
        // ~300ms lets the keys settle so the scroll lands where they'll be, not where they were.
        setTimeout(() => {
          if (document.activeElement === el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }, 300)
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if (!multiline && e.key === 'Enter' && !e.defaultPrevented) {
          e.currentTarget.blur()
          onEnter?.()
        }
      }}
    />
  )
}
