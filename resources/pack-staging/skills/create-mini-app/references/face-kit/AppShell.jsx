/**
 * face-kit/AppShell.jsx — the face's outermost frame. COPY VERBATIM (do not edit per app).
 *
 * Owns the physics the whole screen depends on: the safe-area frame from koda-face.js's three
 * inset variables, the root scroll with correct overscroll (no body rubber-band), the summon-corner
 * reservation, and keyboard-dismiss-on-scroll (a reading drag closes the keyboard, like a native
 * scroll view). Appearance is entirely the app's — pass your own classes.
 *
 *   <AppShell bar={<TabBar/>} claimedLine={host.claimed} className="bg-ground text-canvas">
 *     …screens…
 *   </AppShell>
 *
 * - `bar` pins to the bottom above the home indicator, for a tab bar or an app-owned composer.
 *   It does NOT ride the keyboard — a native tab bar stays put and the keys cover it. A composer
 *   inside the bar that must ride the keys gets its own transform (see face-kit.css .fk-bar).
 * - `claimedLine`: pass true when the app claimed the agent line (koda:claim-agent-line) — the
 *   90px summon reservation at the bottom of the scroll drops to a plain content pad. If you keep
 *   a `bar` without claiming, keep the bar's bottom-right ~72px clear of primary controls; Koda's
 *   summon floats there.
 */

export function AppShell({ children, bar, claimedLine = false, className = '', mainClassName = '', barClassName = '' }) {
  const reserve = bar || claimedLine ? '16px' : '90px'
  return (
    <div className={`fk-shell ${className}`} style={{ '--fk-reserve': reserve }}>
      <div
        className={`fk-main ${mainClassName}`}
        onTouchMove={() => {
          // A reading drag dismisses the keyboard — the native scroll-view feel. Touch-only, so a
          // desktop trackpad scroll never blurs a field mid-thought.
          const el = document.activeElement
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.blur()
        }}
      >
        {children}
      </div>
      {bar ? <div className={`fk-bar ${barClassName}`}>{bar}</div> : null}
    </div>
  )
}
