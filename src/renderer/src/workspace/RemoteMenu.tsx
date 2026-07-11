import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RemoteState, RemoteAuthState, RemoteRelayState } from '@shared/ipc'
import { Menu } from '../motion'
import { RemotePanel } from './RemotePanel'
import { useWorkspace } from './store'

/**
 * Always-visible Remote affordance in the title bar (RB: "remote access shouldn't just be deep in
 * settings"). Replaces the old RemoteIndicator — still security-relevant (a live connection MUST be
 * noticeable on the Mac), but now a one-tap quick-access surface: tap to open a popover with the pairing
 * QR and a From-anywhere ⟷ Same-Wi-Fi toggle. First-time relay account sign-in (email OTP) and device
 * management still live in Settings → Remote; the popover deep-links there. The two pairing paths are
 * mutually exclusive (main pauses relay while the LAN server runs), so the method toggle IS the control:
 * picking Same Wi-Fi opens the LAN port, picking From anywhere closes it (RB: no extra click).
 */
export function RemoteMenu() {
  const openSettingsTo = useWorkspace((s) => s.openSettingsTo)

  const [remote, setRemote] = useState<RemoteState | null>(null)
  const [auth, setAuth] = useState<RemoteAuthState | null>(null)
  const [relay, setRelay] = useState<RemoteRelayState | null>(null)
  // From-anywhere is release-flagged (LAN-only first release). Off → no tabs, the popover IS the LAN pane.
  const [cloud, setCloud] = useState(false)

  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const [tab, setTab] = useState<'anywhere' | 'lan'>('anywhere')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const refreshRemote = useCallback(() => {
    window.koda.getRemoteState().then(setRemote).catch(() => {})
  }, [])

  useEffect(() => {
    refreshRemote()
    window.koda.getCloudRelayEnabled().then(setCloud).catch(() => {})
    window.koda.getRemoteAuth().then(setAuth).catch(() => {})
    window.koda.getRelayState().then(setRelay).catch(() => {})
    // Always reflect live activity — even before getRemoteState resolves (or if it rejected), so a phone
    // connecting can never go unnoticed (remote-control-security.md §6.5). Stub the fields the activity
    // event doesn't carry (url/code/devices); the next full refresh fills them in.
    const offRemote = window.koda.onRemoteActivity((a) =>
      setRemote((prev) => ({
        ...(prev ?? { url: null, code: null, devices: [] }),
        running: a.running,
        connectedClients: a.connectedClients,
      })),
    )
    const offRelay = window.koda.onRelayActivity(setRelay)
    return () => {
      offRemote()
      offRelay()
    }
  }, [refreshRemote])

  // Position the popover under the trigger; recompute on scroll/resize, close on click-out / Escape
  // (the title-bar ThemeSelect popover pattern).
  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (r) setPos({ top: r.bottom + 8, right: window.innerWidth - r.right })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // The open-source build ships without the phone-control stack; no affordance for a feature that
  // can never turn on.
  if (remote?.available === false) return null

  const running = remote?.running ?? false
  const connected = remote?.connectedClients ?? 0
  const relayPaired = relay?.paired ?? false
  const live = connected > 0
  const on = running || relayPaired

  const toggleOpen = (): void => {
    if (!open) {
      // Reflect what's already in use; otherwise default to the recommended from-anywhere path.
      setTab(running || !cloud ? 'lan' : 'anywhere')
      refreshRemote()
      window.koda.getRemoteAuth().then(setAuth).catch(() => {})
      window.koda.getRelayState().then(setRelay).catch(() => {})
    }
    setOpen((v) => !v)
  }

  const toSettings = (): void => {
    setOpen(false)
    openSettingsTo('remote')
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={toggleOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          live
            ? `${connected} remote device${connected > 1 ? 's' : ''} connected`
            : on
              ? 'Remote access is on'
              : 'Remote access — control this Mac from your phone'
        }
        className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors ${
          live
            ? 'text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400'
            : open
              ? 'bg-surface text-text'
              : 'text-text-muted hover:bg-surface hover:text-text'
        }`}
      >
        <span className="relative flex h-1.5 w-1.5">
          {live && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/70" />
          )}
          <span
            className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
              live ? 'bg-emerald-500' : on ? 'bg-accent' : 'bg-text-muted/50'
            }`}
          />
        </span>
        Remote{live ? ` · ${connected}` : ''}
      </button>

      {pos &&
        createPortal(
          <Menu
            open={open}
            origin="origin-top-right"
            className="fixed z-50 w-[300px] overflow-hidden rounded-2xl border border-border bg-surface shadow-pop"
            style={{ top: pos.top, right: pos.right }}
          >
            <div ref={menuRef}>
              <RemotePanel
                tab={tab}
                setTab={setTab}
                cloud={cloud}
                remote={remote}
                auth={auth}
                relay={relay}
                onRemoteChange={setRemote}
                onRelayChange={setRelay}
                toSettings={toSettings}
              />
            </div>
          </Menu>,
          document.body,
        )}
    </>
  )
}
