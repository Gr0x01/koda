import { AnimatePresence, motion, spring, duration, ease } from '../motion'
import { useTheme } from '../theme'
import { RemoteMenu } from './RemoteMenu'
import { useWorkspace } from './store'

// ── Title bar ────────────────────────────────────────────────────────────────────
// A slim draggable strip so the frameless window can be moved; left inset clears the
// macOS traffic lights (positioned in main/index.ts). Shows "Koda — <folder>" centered
// (the one place the name belongs); the folder is the active session's cwd until step 6
// gives the window a real project context.
export function TitleBar() {
  const folder = useWorkspace((s) => {
    const cwd = s.activeId ? s.sessions[s.activeId]?.cwd : undefined
    return cwd?.replace(/\/+$/, '').split('/').pop() || ''
  })
  return (
    <div className="app-drag relative flex h-9 shrink-0 items-center border-b border-border bg-bg px-3">
      {/* Find moved into the Files panel header, so the label can recenter. Equal flex-1 spacers
          center it across the full bar; at real window widths it never reaches the traffic lights. */}
      <div className="flex-1" />
      <div className="shrink truncate text-center font-display text-xs font-medium text-text-muted">
        Koda{folder && <span className="text-text-muted/60"> — {folder}</span>}
      </div>
      <div className="flex-1" />
      {/* Pinned absolute (not in the flex flow) so the title stays truly centered regardless of the
          switch width. inset-y-0 + flex centers it over the full bar height — no half-pixel translate
          rounding. app-no-drag so the button is clickable inside the draggable strip. */}
      <div className="app-no-drag absolute inset-y-0 right-3 flex items-center gap-2.5">
        <RemoteMenu />
        <ThemeSwitch />
      </div>
    </div>
  )
}

// ── Theme switch ───────────────────────────────────────────────────────────────────
// Twin-icon track (sun + moon sit faded in the rail) with a sliding ink disc that "selects" the active
// mode; the disc carries the active icon, which rotates in as it crosses. Slide uses the snappy spring so
// a click-mid-animation reverses smoothly; icon swap is a quick rotate-fade. Reduced-motion is honored
// globally (MotionConfig at the app root) — the spring collapses to instant there.
function ThemeSwitch() {
  const { theme, toggle } = useTheme()
  const isDark = theme === 'dark'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label="Toggle light or dark theme"
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={toggle}
      className="relative h-[23px] w-[43px] rounded-full bg-border transition-colors"
    >
      <span className="pointer-events-none absolute inset-y-0 left-[5px] flex items-center text-text-muted/70">
        <SunIcon />
      </span>
      <span className="pointer-events-none absolute inset-y-0 right-[5px] flex items-center text-text-muted/70">
        <MoonIcon />
      </span>
      <motion.span
        animate={{ x: isDark ? 20 : 0 }}
        transition={spring.snappy}
        className="absolute left-[1.5px] top-[1.5px] z-[1] flex h-5 w-5 items-center justify-center rounded-full bg-surface text-accent shadow-sm"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={isDark ? 'moon' : 'sun'}
            initial={{ rotate: -90, opacity: 0, scale: 0.4 }}
            animate={{ rotate: 0, opacity: 1, scale: 1 }}
            exit={{ rotate: 90, opacity: 0, scale: 0.4 }}
            transition={{ duration: duration.fast, ease: ease.out }}
            className="flex items-center justify-center"
          >
            {isDark ? <MoonIcon /> : <SunIcon />}
          </motion.span>
        </AnimatePresence>
      </motion.span>
    </button>
  )
}

function SunIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  )
}
