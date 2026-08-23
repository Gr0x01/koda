import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  windowLabel,
  type AppInfo,
  type BackupKept,
  type EngineId,
  type EngineProbe,
  type ProviderKind,
  type RateLimitInfo,
} from '@shared/ipc'
import { Menu } from '../motion'
import { shortResetCountdown } from '@shared/rate-limits'
import { SegmentBar } from './ContextMeter'
import { engineShort, engineOrder } from './models'
import { useWorkspace } from './store'
import { Button } from '../ui'
import { liveRateLimitWindows } from '@shared/rate-limits'
import { engineCapabilities, isEngineId } from '@shared/engine-capabilities'

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

// ── Account sign-in banner ───────────────────────────────────────────────────────
// Shown when the Mac's cloud sign-in is dead for good (revoked token family) — the state retrying can
// never fix. Without this the failure is silent here and masquerades as a flaky connection on the phone
// (2026-08-02: apps unreachable all day, the only witness was a log line every 60s).
export function AccountSignInBanner() {
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const openSettingsTo = useWorkspace((s) => s.openSettingsTo)
  useEffect(() => {
    window.koda.getRemoteAuth?.().then((a) => setNeedsSignIn(a.needsReSignin)).catch(console.error)
    return window.koda.onRemoteAuthChanged?.((a) => setNeedsSignIn(a.needsReSignin))
  }, [])
  if (!needsSignIn) return null
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[12.5px] text-text">
      <span className="flex-1">
        <span className="font-medium">Signed out of your Koda account.</span> Your phone can&rsquo;t reach
        this Mac until you sign in again.
      </span>
      <Button variant="primary" size="md" onClick={() => openSettingsTo('koda-account')} className="shrink-0">
        Sign in
      </Button>
    </div>
  )
}

// ── Data integrity banner ───────────────────────────────────────────────────────
// Something is wrong with one of this project's two session stores (the hot sessions blob, or the cold
// archive index), or with the app-global settings file. Five very different situations share this banner
// and must never share wording, because the difference decides what the user should do next:
//   TOTAL failure — main refused to treat the file as "empty" (which the very next save would otherwise
//     overwrite; see session-store.ts), so chat saving is OFF for this run.
//   PARTIAL drop — individual drifted rows were set aside so the rest of the project survives. Saving
//     here is still ON, which means the shortened list DOES get written back. Without a message this is
//     the silent one: the chat is simply gone from the list and nothing says so.
//   REFUSED WRITE — the archive index reads fine, but a write to it came back refused, so the archive /
//     reopen / delete the user just asked for was declined instead of half-done. The only one of the
//     three triggered by an action rather than by boot, and the only one that can clear itself: the next
//     write that lands takes it down (store.ts `persistArchived`).
//   UNREADABLE TRANSCRIPT — the index is fine and the write would have been fine, but the archived
//     chat's own transcript file couldn't be read, so the reopen stopped rather than hand back an empty
//     conversation and delete the file it failed to read. Settings closes on the click either way, so
//     without this line the user watches their chat not come back and hears nothing. Also self-clearing:
//     the next reopen that works takes it down.
//   BILLING RESET — the app-global settings file was unreadable and had recorded a choice to bill through
//     the user's own API key, so billing fell back to the subscription. CLAUDE.md makes a billing switch
//     "user-visible, never silent", and a log line is not visible. The one line here that isn't about
//     this project's files, and the one fed by main rather than the workspace store (settings are
//     app-global, so there's no per-project load result to hang it on).
// The "Koda kept a copy" line is claimed only when main confirmed the copy landed. It can fail (an
// EACCES store whose backup re-read fails the same way, a copyFileSync that hits ENOSPC), and promising
// a recovery file that doesn't exist is worse than admitting there isn't one.
// Un-dismissable on purpose: it stays true for the rest of this run. Deliberately does NOT tell the
// user to reopen the project — a reopen re-reads the same unreadable file and fails identically, so
// that advice would send them back in to lose another session's work. Recovery needs the kept copy,
// which is the agent's job.
export function DataIntegrityBanner() {
  const sessionsFailed = useWorkspace((s) => s.sessionsLoadFailed)
  const archiveFailed = useWorkspace((s) => s.archiveLoadFailed)
  const sessionsBackupKept = useWorkspace((s) => s.sessionsBackupKept)
  const archiveBackupKept = useWorkspace((s) => s.archiveBackupKept)
  const droppedSessions = useWorkspace((s) => s.droppedSessions)
  const droppedArchives = useWorkspace((s) => s.droppedArchives)
  const unreadableArchiveBodies = useWorkspace((s) => s.unreadableArchiveBodies)
  const archiveWriteFailed = useWorkspace((s) => s.archiveWriteFailed)
  const archiveRestoreFailed = useWorkspace((s) => s.archiveRestoreFailed)
  // Not in the workspace store: settings are app-global, so this comes straight from main. Re-asked on
  // every settings write, which is how the line clears once the user picks a billing mode themselves.
  const [billingModeReset, setBillingModeReset] = useState(false)
  useEffect(() => {
    const refresh = (): void => {
      window.koda
        .getDataIntegrity?.()
        .then((d) => setBillingModeReset(!!d?.billingModeReset))
        .catch(console.error)
    }
    refresh()
    return window.koda.onSettingsChanged(refresh)
  }, [])

  // One line per store, so both stores failing says both things (a single ternary used to show only the
  // sessions one, and "ask Koda to recover it" then quietly referred to a file the user was never told
  // about). A store can fail OR drop rows, never both: a drop only happens on a read that succeeded.
  const lines: { key: string; headline: string; body: string }[] = []
  if (sessionsFailed) {
    lines.push({
      key: 'sessions-failed',
      headline: 'Koda couldn’t read this project’s saved chats.',
      body: sentences(
        'Your chats are still on disk and Koda has not changed that file.',
        keptCopyLine(sessionsBackupKept),
        'Chats in this window will not be saved until that file can be read again. Everything else keeps saving normally, including your files, documents, settings and saved versions.',
        'Ask Koda to recover it before you do more work here. The usual cause is installing an older version of Koda over a newer one.',
      ),
    })
  } else if (droppedSessions > 0) {
    lines.push({
      key: 'sessions-dropped',
      headline: `Koda couldn’t read ${count(droppedSessions, 'chat')} in this project.`,
      body: sentences(
        `${droppedSessions === 1 ? 'It was' : 'They were'} set aside instead of deleted, and Koda kept a copy of the original file beside it.`,
        'The rest of this project is working normally and everything you do here is still being saved.',
        `Ask Koda to bring ${droppedSessions === 1 ? 'that chat' : 'those chats'} back. The usual cause is installing an older version of Koda over a newer one.`,
      ),
    })
  }
  if (archiveFailed) {
    lines.push({
      key: 'archive-failed',
      headline: 'Koda couldn’t read this project’s archived chats.',
      body: sentences(
        'They are still on disk and Koda has not changed that file.',
        keptCopyLine(archiveBackupKept),
        'Archiving is turned off here until it can be read. The rest of the project works normally.',
        'Ask Koda to recover it.',
      ),
    })
  } else if (droppedArchives > 0) {
    lines.push({
      key: 'archive-dropped',
      headline: `Koda couldn’t read ${count(droppedArchives, 'archived chat')} in this project.`,
      body: sentences(
        `${droppedArchives === 1 ? 'It was' : 'They were'} set aside instead of deleted, and Koda kept a copy of the original list beside it.`,
        'The rest of this project is working normally, and archiving still works.',
        `Ask Koda to bring ${droppedArchives === 1 ? 'that chat' : 'those chats'} back.`,
      ),
    })
  }
  if (unreadableArchiveBodies > 0) {
    lines.push({
      key: 'archive-body-unreadable',
      headline: `Koda couldn’t read the archived copy of ${count(unreadableArchiveBodies, 'chat')}.`,
      body: sentences(
        `${unreadableArchiveBodies === 1 ? 'Its live copy is' : 'Their live copies are'} still here and nothing was deleted.`,
        `Koda kept the readable live ${unreadableArchiveBodies === 1 ? 'copy' : 'copies'} instead of trusting the broken archive.`,
        'Ask Koda to repair the archive before putting that work away again.',
      ),
    })
  }
  // Its own line rather than a branch of the two above: this one is about a WRITE, it can sit alongside
  // an archive row that drifted on boot, and it can never sit alongside the read failure (a store we
  // couldn't read is one we refuse to write, so no move ever gets far enough to be refused).
  if (archiveWriteFailed) {
    lines.push({
      key: 'archive-write-failed',
      headline: 'Koda couldn’t update this project’s archived chats.',
      body: sentences(
        'Nothing moved and nothing was lost.',
        'Koda was not able to save the list of archived chats, so archiving a chat, reopening one and deleting one will not go through until that works again.',
        'Ask Koda to take a look.',
      ),
    })
  }
  // Separate from the refused write above, and able to sit beside it: that one is about the list, this
  // one is about a single chat's saved conversation. The wording has to say the chat is still there,
  // because the user just clicked Restore and watched Settings close with nothing reopened.
  if (archiveRestoreFailed) {
    lines.push({
      key: 'archive-restore-failed',
      headline: 'Koda couldn’t reopen an archived chat.',
      body: sentences(
        'Nothing moved and nothing was lost.',
        'The saved conversation could not be read, so the chat is still in your archived list.',
        'Ask Koda to take a look.',
      ),
    })
  }
  if (billingModeReset) {
    lines.push({
      key: 'billing-mode-reset',
      headline: 'Koda went back to billing on your Claude subscription.',
      body: sentences(
        'Koda could not read its settings file, and your choice to bill through your own API key was saved in it.',
        'Work you do now goes to your subscription.',
        'You can choose the API key again in Settings under AI providers.',
      ),
    })
  }
  if (!lines.length) return null
  return (
    <div
      role="status"
      className="flex shrink-0 flex-col gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[12.5px] text-text"
    >
      {lines.map((line) => (
        <p key={line.key}>
          <span className="font-medium">{line.headline}</span> {line.body}
        </p>
      ))}
    </div>
  )
}

/** The copy claim, made only when main confirmed the copy exists. `null` means nobody got to say, and
 *  an unproven promise about the user's only remaining copy is not worth making. */
function keptCopyLine(kept: BackupKept): string {
  if (kept === true) return 'Koda kept a copy of it beside the original.'
  if (kept === false) return 'Koda was not able to make a copy of it this time.'
  return ''
}

const sentences = (...parts: string[]): string => parts.filter(Boolean).join(' ')
const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

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
  const refreshEngineAuth = useWorkspace((s) => s.refreshEngineAuth)
  useEffect(() => {
    const check = (): void => {
      void window.koda.refreshProviderStatus?.(engineKey.split(','))
      // Same "on arrival + on sitting back down" cadence: catch a sign-in that lapsed while you were away.
      void refreshEngineAuth()
    }
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [engineKey, refreshEngineAuth])

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
// ONE Versions chip: it opens the timeline, carries the unsaved-change count, and shows an amber dot
// when side lines are still waiting. It used to be two buttons sitting next to each other saying two
// halves of the same fact ("2 changes" and "Versions"), which is what made the count read as a second
// place work could live. Settings overlays the main area. This lives in always-visible chassis because
// the stage comes and goes with what's on it, and an unsaved-work cue that can disappear isn't a cue.
function FooterActions() {
  const setVersionsOpen = useWorkspace((s) => s.setVersionsOpen)
  const setSettingsOpen = useWorkspace((s) => s.setSettingsOpen)
  const gitRepo = useWorkspace((s) => s.gitRepo)
  const changeCount = useWorkspace((s) => (s.gitRepo ? s.gitFiles.length : 0))
  const sideLinesWaiting = useWorkspace((s) => s.gitRepo && s.gitSideLinesWaiting)
  const changeSummary =
    changeCount > 0
      ? `${changeCount} ${changeCount === 1 ? 'change' : 'changes'} not yet saved`
      : null
  const details = [changeSummary, sideLinesWaiting ? 'side-line work is waiting' : null].filter(
    (detail): detail is string => detail !== null,
  )
  return (
    <div className="flex items-center gap-0.5">
      <button
        onClick={() => setVersionsOpen(true)}
        title={details.length > 0 ? `Versions · ${details.join(' · ')}` : 'Versions'}
        aria-label={details.length > 0 ? `Versions, ${details.join(', ')}` : 'Versions'}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-surface hover:text-text"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="6" cy="18" r="2.5" />
          <circle cx="18" cy="8" r="2.5" />
          <path d="M6 8.5v7M18 10.5c0 3-2.5 4.5-6 4.5" />
        </svg>
        <span>Versions</span>
        {gitRepo && changeCount > 0 && (
          <span className="font-medium tabular-nums text-accent" aria-hidden>
            {changeCount}
          </span>
        )}
        {sideLinesWaiting && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-amber-500"
            title="Side lines are still waiting"
            aria-hidden
          />
        )}
      </button>
      <FooterButton label="Settings" onClick={() => setSettingsOpen(true)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
        </svg>
      </FooterButton>
      <MemoryTidyPill />
    </div>
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
        <button
          key={id}
          onClick={() => openStatusPage(id)}
          className="flex select-none items-center gap-1.5 text-amber-500 transition-colors hover:text-amber-400"
          title={healthTooltip(providerDown[id])}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
          {engineShort(id)} · {kindWord(providerDown[id]?.kind)}
        </button>
      ))}
    </>
  )
}

// The human status pages behind the feeds status-watch.ts polls — where to send someone who wants the
// provider's own word on an incident. window.open routes through main's window-open handler →
// shell.openExternal, so it lands in the user's browser.
const STATUS_PAGES: Record<string, string> = {
  claude: 'https://status.claude.com',
  codex: 'https://status.openai.com',
}

function openStatusPage(engineId: string): void {
  const url = STATUS_PAGES[engineId]
  if (url) window.open(url)
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
  return `${head}. Your work is fine; you'll get a ping when it's back. Click for the status page.`
}

// ── Memory tidy pill ──────────────────────────────────────────────────────────────
// Quiet by default: renders only when the project's memory navigation pair (the index +
// active-context) has crossed the heaviness line. Sits
// right next to Settings (the surface it opens), NOT in the center usage cluster — it's a control
// that leads somewhere, not an ambient stat. Amber like the outage pill; gone once tidied.
function MemoryTidyPill() {
  const heavy = useWorkspace((s) => s.memoryWeight?.heavy ?? false)
  const openSettingsTo = useWorkspace((s) => s.openSettingsTo)
  if (!heavy) return null
  return (
    <button
      onClick={() => openSettingsTo('memory')}
      title="This project's memory map has grown hard to navigate. Tidying it keeps retrieval sharp. Click for details."
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
    .filter(isEngineId)
    .filter((id) => id === activeEngine || providerDown[id] || hasWindowData(liveRateLimitWindows(rateLimits[id], nowSec)))
    .sort((a, b) => engineOrder(a) - engineOrder(b))
  const labelEngines = engineIds.length > 1
  return (
    <div className="flex items-center gap-4">
      {engineIds.map((id) => (
        <EngineWindows key={id} engineId={id} windows={liveRateLimitWindows(rateLimits[id], nowSec)} showLabel={labelEngines} nowSec={nowSec} />
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
// One engine's 5-hour gauge — the only window shown inline (it's the cap you actually hit). A small
// accent dot + brand name when more than one engine is on screen (the single-engine case stays clean
// with just "5-hour"). Reset times and the weekly window live in a click popout (the same pattern as
// the composer's context readout), so the footer reads at a glance instead of as a wall of text.
function EngineWindows({
  engineId,
  windows,
  showLabel,
  nowSec,
}: {
  engineId: EngineId
  windows: Record<string, RateLimitInfo>
  showLabel: boolean
  nowSec: number
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // The popout is PORTALED to the body and positioned in viewport coords (the RemoteMenu pattern). It
  // used to sit `absolute bottom-full` inside the footer, which fit while the plan reported one window
  // but got cut off at the top once the usage poll started reporting three — the footer's z-10 panel
  // competes in the root stacking context with the positioned children of the surfaces above it.
  // Portaled + fixed, the panel is out of that contest entirely and can't be clipped by any ancestor.
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = ref.current?.getBoundingClientRect()
      if (r) setPos({ left: r.left + r.width / 2, bottom: window.innerHeight - r.top + 6 })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    // Dismiss on outside click / Escape — same inline idiom as ContextReadout. The panel is no longer a
    // DOM descendant of the trigger, so a click inside it has to be excused explicitly.
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  // Provider health folds onto this chip: the dot is the always-present, subtle signal (brand/ muted when
  // fine, amber the moment the provider reports trouble) and the honest severity word appears inline.
  const health = useWorkspace((s) => s.providerDown[engineId])
  const trouble = !!health
  // Signed-out sign-in prompt — but ONLY for the engine the active session actually runs on. A Codex-only
  // user's active engine is Codex, so Claude never gets a chip here, let alone a "sign in" nag; the prompt
  // rides the engine you're about to send a turn on. No active session → no proactive nag (the reactive
  // composer banner still catches a failed turn).
  const openSettingsTo = useWorkspace((s) => s.openSettingsTo)
  const isActiveEngine = useWorkspace(
    (s) => !!s.activeId && ((s.activeId ? s.sessions[s.activeId]?.engineId : undefined) ?? 'claude') === engineId,
  )
  const signedOut = useWorkspace((s) => s.engineSignedOut[engineId] ?? false)
  if (signedOut && isActiveEngine)
    return (
      <button
        onClick={() => openSettingsTo('providers')}
        title={`You're signed out of ${engineShort(engineId)}. Click to sign in.`}
        aria-label={`Sign in to ${engineShort(engineId)}`}
        className="flex select-none items-center gap-1.5 text-amber-500 transition-colors hover:text-amber-400"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
        {engineShort(engineId)} · sign in
      </button>
    )
  // The window shown inline is the one that BINDS soonest: five_hour when the plan reports it (Claude),
  // else the weekly window (a Codex plan may report ONLY a weekly window; the Claude server since
  // ~2026-07 may report ONLY the seven_day window when it's the one running hot), else whatever
  // non-overage window exists. Anchoring on five_hour alone would leave the plan's real gauge hidden.
  const primaryType = windows['five_hour']
    ? 'five_hour'
    : windows['weekly']
      ? 'weekly'
      : windows['seven_day']
        ? 'seven_day'
        : Object.keys(windows).find((t) => !t.includes('overage')) ?? Object.keys(windows)[0]
  const primary = primaryType ? windows[primaryType] : undefined
  const pct = primary?.usedPercent != null ? `${Math.round(primary.usedPercent)}%` : null
  // Inline value: precise % when the engine reports one (Codex), else nothing (Claude's band is carried
  // by the bar's color), else an em dash before any turn has landed.
  const value = !primary ? '—' : pct
  // The reset clock rides inline (usage-wave U4): the one question a filling gauge raises is "when
  // does it free up", and the popout answering it was one click too far. liveRateLimitWindows already
  // dropped elapsed windows, so a countdown here can never be stale.
  const countdown = primary ? shortResetCountdown(primary.resetsAt, nowSec) : null
  // Present windows for the popout rows, five_hour first then the longer caps. Overage variants are
  // dropped — they're the same window with the overage flag, already surfaced by WindowRow's "using
  // overage" note, so listing them separately would just double a row.
  const presentTypes = Object.keys(windows)
    .filter((t) => !t.includes('overage'))
    .sort((a, b) => (a === 'five_hour' ? 0 : 1) - (b === 'five_hour' ? 0 : 1))
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex select-none items-center gap-1.5 transition-colors hover:text-text ${primary || trouble ? '' : 'opacity-60'}`}
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
          {showLabel || trouble ? engineShort(engineId) : windowLabel(primaryType ?? 'five_hour')}
          {trouble && <span>· {kindWord(health?.kind)}</span>}
        </span>
        {/* Same 3-state band language as the context meter (allowed/warning/rejected → green/amber/red). */}
        <SegmentBar
          filled={primary?.usedPercent != null ? Math.ceil((Math.max(0, primary.usedPercent) / 100) * 3) : primary ? fillOf(primary.status) : 0}
          segments={3}
        />
        {value && <span>{value}</span>}
        {countdown && (
          /* Reserved width + tabular digits: the tick must never shift the chip's neighbors. */
          <span className="inline-block min-w-[6ch] text-left tabular-nums">· {countdown}</span>
        )}
      </button>
      {/* Positioning lives on a plain wrapper: Menu animates `scale`, and motion's inline transform
          would override a class-based -translate-x-1/2 (the panel would hang off to the right). */}
      {pos &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-50 -translate-x-1/2"
            style={{ left: pos.left, bottom: pos.bottom }}
          >
            <Menu
              open={open}
              origin="origin-bottom"
              className="w-max whitespace-nowrap rounded-xl border border-border bg-surface px-3 py-2 text-left font-mono text-[11px] text-text-muted shadow-pop"
            >
              {/* Same label-left / value-right row as the window rows below, for consistency: engine name
                  on the left, provider health right-aligned, the incident note beneath. During an incident
                  the whole health read links out to the provider's status page — the note is their one-liner;
                  the page has the rest. */}
              <div className="mb-1 flex justify-between gap-6">
                <span className="text-text">{engineShort(engineId)}</span>
                {health ? (
                  <button
                    onClick={() => openStatusPage(engineId)}
                    title="Open the provider's status page"
                    className="text-right text-amber-500 transition-colors hover:text-amber-400"
                  >
                    {kindWord(health.kind)} ↗
                    {health.note ? (
                      <span className="block text-right text-text-muted">{health.note}</span>
                    ) : null}
                  </button>
                ) : (
                  <span className="text-emerald-500">operational</span>
                )}
              </div>
              {presentTypes.length > 0 ? (
                <>
                  {presentTypes.map((t) => <WindowRow key={t} type={t} info={windows[t]} />)}
                  {/* A server that omits windows it deems quiet (Anthropic's, since ~2026-07) still has
                      a 5-hour limit — surface the line so it reads as "nothing to report", not as the
                      limit vanishing. */}
                  {engineCapabilities(engineId).anchorsFiveHourWindow && !windows['five_hour'] && (
                    <div className="flex justify-between gap-6">
                      <span>5-hour</span>
                      <span className="text-text">nothing to report, likely low</span>
                    </div>
                  )}
                </>
              ) : (
                // No window yet (pre-first-turn): the anchored placeholder so the popout isn't empty.
                <WindowRow type="five_hour" info={undefined} />
              )}
              {/* The one route from limits to the ledger: same popup as ever, plus one last row. */}
              <button
                onClick={() => {
                  setOpen(false)
                  openSettingsTo('usage')
                }}
                className="mt-1.5 block w-full border-t border-border pt-1.5 text-left text-accent transition-colors hover:opacity-80"
              >
                Full usage →
              </button>
            </Menu>
          </div>,
          document.body,
        )}
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
