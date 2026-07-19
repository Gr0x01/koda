import { useEffect, useRef, useState } from 'react'
import type { AppInfo, EngineProbe, ProviderKind, RateLimitInfo } from '@shared/ipc'
import { AnimatePresence, Menu, motion, spring, duration, ease } from '../motion'
import { useTheme } from '../theme'
import { SegmentBar } from './ContextMeter'
import { engineShort, engineOrder } from './models'
import { useWorkspace } from './store'
import { Button } from '../ui'

// ── Billing fallback banner ──────────────────────────────────────────────────────
// 'auto' mode only: shown when the subscription plan limit is hit and we haven't yet asked whether to
// continue on the API key. Confirming spends real money — so it's an explicit, one-time consent (after
// it, billing rides the API key until the window resets; see store.confirmApiFallback).
export function BillingFallbackBanner() {
  const prompt = useWorkspace((s) => s.billingFallbackPrompt)
  const confirm = useWorkspace((s) => s.confirmApiFallback)
  const dismiss = useWorkspace((s) => s.dismissApiFallback)
  if (!prompt) return null
  const resets = new Date(prompt.resetsAt * 1000).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[12.5px] text-text">
      <span className="flex-1">
        <span className="font-medium">Plan limit reached.</span> Keep going on your API key? This spends
        real money on your Anthropic account until your plan resets ({resets}).
      </span>
      <Button variant="primary" size="md" onClick={() => void confirm()} className="shrink-0">Continue on API</Button>
      <Button variant="ghost" size="md" onClick={dismiss} className="shrink-0">Wait for reset</Button>
    </div>
  )
}

// ── Status bar ─────────────────────────────────────────────────────────────────
export function StatusBar() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [engine, setEngine] = useState<EngineProbe | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  useEffect(() => {
    window.koda.getAppInfo().then(setInfo).catch(console.error)
    window.koda
      .probeEngine()
      .then(setEngine)
      .catch((err) => setEngineError(String(err)))
  }, [])

  // Memory weight changes only when the agent writes memory notes, so a slow ambient poll is plenty —
  // the pill appearing a few minutes late is fine; Settings → Memory re-reads fresh on open.
  const refreshMemoryWeight = useWorkspace((s) => s.refreshMemoryWeight)
  useEffect(() => {
    void refreshMemoryWeight()
    const t = setInterval(() => void refreshMemoryWeight(), 300_000)
    return () => clearInterval(t)
  }, [refreshMemoryWeight])

  // Truthful-on-arrival provider health: one status check when the footer mounts and whenever the window
  // regains focus (you sitting back down) — NOT a background monitor. Lives here (always mounted) so it
  // runs in API-billing mode too, where the usage chips that carry health aren't shown. Selecting the
  // key sets as joined strings keeps the effect dep a primitive (no render loop).
  const activeEngine = useWorkspace((s) => (s.activeId ? s.sessions[s.activeId]?.engineId : undefined) ?? 'claude')
  const rlKeys = useWorkspace((s) => Object.keys(s.rateLimits).join(','))
  const pdKeys = useWorkspace((s) => Object.keys(s.providerDown).join(','))
  const engineKey = Array.from(
    new Set([activeEngine, ...rlKeys.split(',').filter(Boolean), ...pdKeys.split(',').filter(Boolean)]),
  ).join(',')
  useEffect(() => {
    const check = (): void => void window.koda.refreshProviderStatus?.(engineKey.split(','))
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [engineKey])

  return (
    <footer className="relative flex items-center border-t border-border bg-bg px-2 py-1 text-[11px] text-text-muted">
      {/* Actions on the left — Versions + Settings, moved out of the old sidebar footer so they're
          always reachable regardless of the sidebar's collapse/resize state. */}
      <FooterActions />

      {/* Billing stays dead-center (the limits gauge). Absolute so the left/right widths never shift it.
          Provider health rides the per-engine chips inside RateLimitStatus; the standalone pill only
          appears in API-billing mode, where there are no usage chips to fold it into. */}
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-4 font-mono">
        <BillingStatus />
      </div>

      {/* Passive build status parked in the right corner (VS Code convention). */}
      <div className="ml-auto flex items-center gap-3 pr-2 font-mono">
        {engine ? (
          <span>
            engine {engine.version} · {engine.source}
          </span>
        ) : engineError ? (
          <span className="text-red-400">engine: {engineError}</span>
        ) : (
          <span>engine …</span>
        )}
        {info && <span className="opacity-60">v{info.appVersion}</span>}
      </div>
    </footer>
  )
}

// ── Footer actions (left of the status bar) ──────────────────────────────────────
// Versions opens the full history (graph + branch review); Settings overlays the main area. A dirty
// dot on Versions echoes the dock's Changes cue so unsaved work — including a sibling worktree's — is
// visible even when the dock is on another tool.
function FooterActions() {
  const setVersionsOpen = useWorkspace((s) => s.setVersionsOpen)
  const setSettingsOpen = useWorkspace((s) => s.setSettingsOpen)
  const dirty = useWorkspace((s) => s.gitRepo && (s.gitFiles.length > 0 || s.gitWorktreesDirty))
  return (
    <div className="flex items-center gap-0.5">
      <FooterButton label="Versions" onClick={() => setVersionsOpen(true)}>
        <span className="relative">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="6" cy="6" r="2.5" />
            <circle cx="6" cy="18" r="2.5" />
            <circle cx="18" cy="8" r="2.5" />
            <path d="M6 8.5v7M18 10.5c0 3-2.5 4.5-6 4.5" />
          </svg>
          {dirty && <span className="absolute -right-1 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-bg" aria-hidden />}
        </span>
      </FooterButton>
      <FooterButton label="Settings" onClick={() => setSettingsOpen(true)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
        </svg>
      </FooterButton>
      <ThemeSwitch />
      <MemoryTidyPill />
    </div>
  )
}

// ── Theme switch ──────────────────────────────────────────────────────────────────
// The light/dark quick-flip, moved out of the title bar (which stays calm: the face flip + Remote)
// to sit with the bar's other controls. Twin-icon track with a sliding ink disc carrying the active
// icon; scaled to the status bar's height. Full appearance control lives in Settings → Appearance.
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
      className="relative ml-1 h-[19px] w-[37px] rounded-full bg-border transition-colors"
    >
      <span className="pointer-events-none absolute inset-y-0 left-[4px] flex items-center text-text-muted/70">
        <SunIcon />
      </span>
      <span className="pointer-events-none absolute inset-y-0 right-[4px] flex items-center text-text-muted/70">
        <MoonIcon />
      </span>
      <motion.span
        animate={{ x: isDark ? 18 : 0 }}
        transition={spring.snappy}
        className="absolute left-[1.5px] top-[1.5px] z-[1] flex h-4 w-4 items-center justify-center rounded-full bg-surface text-accent shadow-sm"
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
      width="9"
      height="9"
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
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  )
}

function FooterButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-surface hover:text-text"
    >
      {children}
      <span>{label}</span>
    </button>
  )
}

// ── Provider health pill (API-billing mode only) ───────────────────────────────────
// The subscription case folds provider health into the per-engine usage chips (EngineWindows). API mode
// has no such chips, so health gets this compact fallback. Quiet by default: renders only while a
// feed-CONFIRMED incident is watched; the word matches the reported severity (never "outage" for a slowdown).
function ProviderOutagePill() {
  const providerDown = useWorkspace((s) => s.providerDown)
  const engines = Object.keys(providerDown)
  if (engines.length === 0) return null
  return (
    <>
      {engines.map((id) => (
        <span
          key={id}
          className="flex cursor-default select-none items-center gap-1.5 text-amber-500"
          title={healthTooltip(providerDown[id])}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
          {engineShort(id)} · {kindWord(providerDown[id]?.kind)}
        </span>
      ))}
    </>
  )
}

/** Plain word for a reported severity — kept honest so the chip never overstates. A missing/unknown kind
 *  falls back to the neutral "incident", never "outage" (that would be the exact overstatement to avoid). */
function kindWord(kind?: ProviderKind): string {
  switch (kind) {
    case 'outage':
      return 'outage'
    case 'partial':
      return 'partial outage'
    case 'degraded':
      return 'degraded'
    case 'maintenance':
      return 'maintenance'
    default:
      return 'incident'
  }
}

function healthTooltip(health?: { note?: string; kind?: ProviderKind }): string {
  const head = `${kindWord(health?.kind)}${health?.note ? ` — ${health.note}` : ''}`
  return `${head}. Your work is fine; you'll get a ping when it's back.`
}

// ── Memory tidy pill ──────────────────────────────────────────────────────────────
// Quiet by default: renders only when the project's always-injected memory pair (the index +
// active-context, folded into every session's system prompt) has crossed the heaviness line. Sits
// right next to Settings (the surface it opens), NOT in the center usage cluster — it's a control
// that leads somewhere, not an ambient stat. Amber like the outage pill; gone once tidied.
function MemoryTidyPill() {
  const heavy = useWorkspace((s) => s.memoryWeight?.heavy ?? false)
  const openSettingsTo = useWorkspace((s) => s.openSettingsTo)
  if (!heavy) return null
  return (
    <button
      onClick={() => openSettingsTo('memory')}
      title="This project's memory has grown. Part of it loads into every conversation, so tidying it keeps the agent sharp. Click for details."
      aria-label="Memory needs a tidy — open Settings"
      className="ml-0.5 flex select-none items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-amber-500 transition-colors hover:bg-surface hover:text-amber-400"
    >
      {/* lucide triangle-alert */}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
      <span>memory needs a tidy</span>
    </button>
  )
}

// ── Billing status (center of the status bar) ────────────────────────────────────
// Subscription billing → the plan-window gauges (the common case). API billing (always-on, or an 'auto'
// fallback window that's currently live) → a small running-spend chip instead: the plan windows don't
// apply, and real dollars ARE being spent, so it's worth keeping in view. `apiActive` is mirrored from
// main (billing:getState) into the store and kept in sync by the bridge.
function BillingStatus() {
  const apiActive = useWorkspace((s) => s.apiActive)
  const sessions = useWorkspace((s) => s.sessions)
  if (!apiActive) return <RateLimitStatus />
  const total = Object.values(sessions).reduce((sum, s) => sum + (s.spendUsd ?? 0), 0)
  return (
    <span className="flex items-center gap-4">
      <span
        className="cursor-default select-none"
        title="Billing to your API account: real per-token spend. Details under Settings → Usage."
      >
        API · ~${total.toFixed(2)}
      </span>
      {/* No usage chips in API mode, so provider health rides its own compact chip here instead. */}
      <ProviderOutagePill />
    </span>
  )
}

// ── Rate-limit windows (the 5-hour + weekly subscription caps) ───────────────────
// The account-level windows the TUI's /usage shows, surfaced ambiently next to the build info. The
// engine streams the reset time + a coarse status band for whichever window is currently BINDING
// (almost always 5-hour) — not a precise "% used" (that's behind a separate authenticated call), and
// not every window every turn. So we anchor the 5-hour gauge as ALWAYS-PRESENT (empty/grayed before
// the first turn, like the context meter — a missing gauge reads as broken), and let weekly join only
// when the engine actually sends it (we never fabricate a window we can't see).
function RateLimitStatus() {
  // The footer is global chassis, not session-scoped: keep tabs on EVERY engine we have window data for,
  // so blowing out Claude's 5-hour cap and switching to Codex still shows Claude's window — you can see
  // when it frees up and switch back. Each engine is a separate subscription with its own caps. The
  // active session's engine is always shown (anchored even when empty, like the context meter — a missing
  // gauge reads as broken); other engines join once they've reported a window.
  const rateLimits = useWorkspace((s) => s.rateLimits)
  const providerDown = useWorkspace((s) => s.providerDown)
  const activeEngine = useWorkspace((s) => (s.activeId ? s.sessions[s.activeId]?.engineId : undefined) ?? 'claude')
  // Re-evaluate every 30s so a window that reaches its reset time drops off on its own — the store isn't
  // touched between turns, so nothing else would trigger the re-render that expires it.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000)
    return () => clearInterval(t)
  }, [])
  // An engine in an incident always earns a chip (even before it has window data) so its health shows.
  const engineIds = Array.from(new Set([activeEngine, ...Object.keys(rateLimits), ...Object.keys(providerDown)]))
    .filter((id) => id === activeEngine || providerDown[id] || hasWindowData(liveWindows(rateLimits[id], nowSec)))
    .sort((a, b) => engineOrder(a) - engineOrder(b))
  const labelEngines = engineIds.length > 1
  return (
    <div className="flex items-center gap-4">
      {engineIds.map((id) => (
        <EngineWindows key={id} engineId={id} windows={liveWindows(rateLimits[id], nowSec)} showLabel={labelEngines} />
      ))}
    </div>
  )
}

function hasWindowData(windows?: Record<string, RateLimitInfo>): boolean {
  return !!windows && Object.keys(windows).length > 0
}

/** Windows still inside their live period. Past `resetsAt` the real band/percent is unknown (the boot
 *  seed drops expired windows for exactly this reason, usage-history.ts), so an elapsed window is treated
 *  as absent — the gauge falls back to the em-dash until the next turn re-emits it, rather than showing a
 *  stale "31%" / color long after the window should have reset. */
function liveWindows(windows: Record<string, RateLimitInfo> | undefined, nowSec: number): Record<string, RateLimitInfo> {
  if (!windows) return {}
  const out: Record<string, RateLimitInfo> = {}
  for (const [k, w] of Object.entries(windows)) if (w && w.resetsAt > nowSec) out[k] = w
  return out
}

// One engine's 5-hour gauge — the only window shown inline (it's the cap you actually hit). A small
// accent dot + brand name when more than one engine is on screen (the single-engine case stays clean
// with just "5-hour"). Reset times and the weekly window live in a click popout (the same pattern as
// the composer's context readout), so the footer reads at a glance instead of as a wall of text.
function EngineWindows({
  engineId,
  windows,
  showLabel,
}: {
  engineId: string
  windows: Record<string, RateLimitInfo>
  showLabel: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // Dismiss on outside click / Escape — same inline idiom as ContextReadout. Only listens while open.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  // Provider health folds onto this chip: the dot is the always-present, subtle signal (brand/ muted when
  // fine, amber the moment the provider reports trouble) and the honest severity word appears inline.
  const health = useWorkspace((s) => s.providerDown[engineId])
  const trouble = !!health
  const five = windows['five_hour']
  const pct = five?.usedPercent != null ? `${Math.round(five.usedPercent)}%` : null
  // Inline value: precise % when the engine reports one (Codex), else nothing (Claude's band is carried
  // by the bar's color), else an em dash before any turn has landed.
  const value = !five ? '—' : pct
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex select-none items-center gap-1.5 transition-colors hover:text-text ${five || trouble ? '' : 'opacity-60'}`}
        title={trouble ? healthTooltip(health) : 'Plan usage, click for details'}
        aria-label={`${engineShort(engineId)} plan usage`}
      >
        <span className={`flex items-center gap-1.5 ${trouble ? 'text-amber-500' : ''}`}>
          {/* Dot is a health light, same meaning for every engine: green when the provider is fine, amber
              when it's not. The name label carries identity; the inline word carries the honest severity. */}
          <span
            className={`h-1.5 w-1.5 rounded-full ${trouble ? 'bg-amber-500' : 'bg-emerald-500'}`}
            aria-hidden
          />
          {showLabel || trouble ? engineShort(engineId) : '5-hour'}
          {trouble && <span>· {kindWord(health?.kind)}</span>}
        </span>
        {/* Same 3-state band language as the context meter (allowed/warning/rejected → green/amber/red). */}
        <SegmentBar filled={five ? fillOf(five.status) : 0} segments={3} />
        {value && <span>{value}</span>}
      </button>
      {/* Positioning lives on a plain wrapper: Menu animates `scale`, and motion's inline transform
          would override a class-based -translate-x-1/2 (the panel would hang off to the right). */}
      <div className="absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2">
        <Menu
          open={open}
          origin="origin-bottom"
          className="w-max whitespace-nowrap rounded-xl border border-border bg-surface px-3 py-2 text-left font-mono text-[11px] text-text-muted shadow-pop"
        >
          {/* Same label-left / value-right row as the window rows below, for consistency: engine name on
              the left, provider health right-aligned, the incident note dropping right-aligned beneath. */}
          <div className="mb-1 flex justify-between gap-6">
            <span className="text-text">{engineShort(engineId)}</span>
            <span className={health ? 'text-amber-500' : 'text-emerald-500'}>
              {health ? kindWord(health.kind) : 'operational'}
              {health?.note ? (
                <span className="block text-right text-text-muted">{health.note}</span>
              ) : null}
            </span>
          </div>
          <WindowRow type="five_hour" info={five} />
          <WindowRow type="weekly" info={windows['weekly']} />
        </Menu>
      </div>
    </div>
  )
}

// One plan window in the popout: fill on the first line (a precise % when the engine reports one —
// Codex — else the hedged band read), the reset time under it. Weekly renders only once seen.
function WindowRow({ type, info }: { type: string; info?: RateLimitInfo }) {
  if (!info) {
    if (type !== 'five_hour') return null
    return (
      <div className="flex justify-between gap-6">
        <span>5-hour</span>
        <span className="text-text">updates after your next turn</span>
      </div>
    )
  }
  const reset = formatReset(info.resetsAt)
  const fill = info.usedPercent != null ? `${Math.round(info.usedPercent)}% used` : statusHint(info.status)
  return (
    <div className="flex justify-between gap-6">
      <span>{windowLabel(type)}</span>
      <span className="text-text">
        {fill}
        {info.isUsingOverage ? ' · using overage' : ''}
        <span className="block text-right text-text-muted">
          resets {reset.absolute} ({reset.relative})
        </span>
      </span>
    </div>
  )
}

function windowLabel(type: string): string {
  if (type === 'five_hour') return '5-hour'
  if (type === 'weekly') return 'weekly'
  return type.replace(/_/g, ' ')
}

/** Translate the band into a plain "how close am I" read for the popout, with a rough % anchor so
 *  the color isn't abstract. The stream gives no precise %, but the claude.ai Usage screen shows its
 *  bar flips amber around ~75–78% used — so `warning` maps to "~75%+". Deliberately hedged ("~")
 *  since we're inferring the threshold, not reading a number. */
function statusHint(status: string): string {
  if (status === 'warning') return 'getting close, ~75%+ used'
  if (status === 'rejected' || status === 'blocked') return 'limit reached, paused until reset'
  if (status === 'allowed') return 'healthy, under ~75% used'
  return ''
}

/** Map the engine's 3-state rate-limit band to lit cells: healthy→1 (green), warning→2 (amber),
 *  rejected→3 (red full). A coarse "how close to the cap" read, the only resolution the stream gives. */
function fillOf(status: string): number {
  if (status === 'warning') return 2
  if (status === 'rejected' || status === 'blocked') return 3
  if (status === 'allowed') return 1
  return 0
}

/** Absolute reset time for the inline label (no ticking timer needed — a fixed timestamp), plus a
 *  relative phrase for the popout, computed at render. Weekly resets show the weekday too. */
function formatReset(resetsAt: number): { absolute: string; relative: string } {
  const d = new Date(resetsAt * 1000)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const sameDay = d.toDateString() === new Date().toDateString()
  const absolute = sameDay ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  const mins = Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60000))
  const relative =
    mins < 60
      ? `in ${mins}m`
      : mins < 60 * 24
        ? `in ${Math.floor(mins / 60)}h ${mins % 60}m`
        : `in ${Math.floor(mins / (60 * 24))}d`
  return { absolute, relative }
}
