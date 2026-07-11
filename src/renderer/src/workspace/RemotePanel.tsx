import { useEffect, useState } from 'react'
import type { RemoteState, RemoteAuthState, RemoteRelayState } from '@shared/ipc'
import { QrCode } from '../settings/QrCode'
import { SegmentedControl } from '../settings/controls'
import { Button } from '../ui'

export function RemotePanel({
  tab,
  setTab,
  cloud,
  remote,
  auth,
  relay,
  onRemoteChange,
  onRelayChange,
  toSettings,
}: {
  tab: 'anywhere' | 'lan'
  setTab: (t: 'anywhere' | 'lan') => void
  cloud: boolean
  remote: RemoteState | null
  auth: RemoteAuthState | null
  relay: RemoteRelayState | null
  onRemoteChange: (s: RemoteState) => void
  onRelayChange: (s: RemoteRelayState) => void
  toSettings: () => void
}) {
  const lanActive = remote?.running ?? false
  const [lanErr, setLanErr] = useState('')
  const [lanBusy, setLanBusy] = useState(false)

  const setLan = (enabled: boolean): void => {
    setLanErr('')
    setLanBusy(true)
    window.koda
      .setRemoteEnabled({ enabled })
      .then(onRemoteChange)
      .catch((e) => {
        const msg = String(e?.message ?? e)
        setLanErr(
          /EADDRINUSE|address already in use/i.test(msg)
            ? 'Port 4321 is in use — another Koda or dev instance may be running.'
            : msg.replace(/^Error invoking remote method '[^']+':\s*/i, ''),
        )
      })
      .finally(() => setLanBusy(false))
  }

  // The method toggle drives the LAN port (RB: no extra click). The two paths are mutually exclusive, so
  // switching to Same Wi-Fi opens the port and switching to From anywhere closes it (also lets the relay
  // resume issuing — it pauses while the LAN server runs).
  const selectTab = (t: 'anywhere' | 'lan'): void => {
    if (t === tab) return
    setTab(t)
    if (t === 'lan' && !lanActive) setLan(true)
    if (t === 'anywhere' && lanActive) setLan(false)
  }

  return (
    <div>
      <div className="flex items-center justify-between px-3.5 pt-3">
        <div className="text-[13px] font-semibold text-text">Remote access</div>
        <button
          onClick={toSettings}
          title="Remote settings"
          aria-label="Remote settings"
          className="-mr-1 grid size-7 place-items-center rounded-lg text-text-muted transition-colors hover:bg-bg hover:text-text"
        >
          <GearIcon />
        </button>
      </div>
      <div className="px-3.5 pt-0.5 text-[11.5px] leading-snug text-text-muted">
        Control this Mac from your phone. Send messages and approve actions.
      </div>

      {cloud && (
        <div className="px-3.5 pt-3">
          <SegmentedControl
            ariaLabel="Pairing method"
            value={tab}
            onChange={selectTab}
            fill
            options={[
              { value: 'anywhere', label: 'From anywhere' },
              { value: 'lan', label: 'Same Wi‑Fi' },
            ]}
          />
        </div>
      )}

      <div className="p-3.5">
        {cloud && tab === 'anywhere' ? (
          <AnywherePane
            auth={auth}
            relay={relay}
            lanActive={lanActive}
            onRelayChange={onRelayChange}
            toSettings={toSettings}
          />
        ) : !cloud && !lanActive && !lanErr ? (
          // Cloud flagged off and the LAN server isn't running yet: an explicit start (opening a popover
          // shouldn't silently open a LAN port). Once on, the persisted toggle keeps it on across boots.
          <Centered>
            <p className="text-[12px] leading-snug text-text-muted">
              Pair a phone on the same Wi‑Fi to send messages and approve actions. Nothing leaves your
              network.
            </p>
            <Button variant="primary" onClick={() => setLan(true)}>{lanBusy ? 'Starting…' : 'Turn on'}</Button>
          </Centered>
        ) : (
          <LanPane remote={remote} busy={lanBusy} err={lanErr} onRetry={() => setLan(true)} />
        )}
      </div>
    </div>
  )
}

// ── From anywhere (cloud relay) ──────────────────────────────────────────────────
function AnywherePane({
  auth,
  relay,
  lanActive,
  onRelayChange,
  toSettings,
}: {
  auth: RemoteAuthState | null
  relay: RemoteRelayState | null
  lanActive: boolean
  onRelayChange: (s: RemoteRelayState) => void
  toSettings: () => void
}) {
  const [blob, setBlob] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Once a device pairs, the auto-issued QR is consumed — fall back to the paired state, not the stale
  // code. "Pair another" sets this so we deliberately show a fresh QR over the already-paired state.
  const [repairing, setRepairing] = useState(false)
  const signedIn = auth?.signedIn ?? false
  const paired = relay?.paired ?? false

  // Auto-issue a fresh QR while signed in, not paired, and the LAN server is off (one live QR at a time;
  // briefly gated off during the switch-to-anywhere transition until the port closes). Refresh just
  // before the 5-minute TTL. Re-pairing a paired device stays a manual tap.
  useEffect(() => {
    if (!signedIn || paired || lanActive) return
    let cancelled = false
    const issue = (): void => {
      window.koda
        .pairRelayDevice()
        .then((r) => {
          if (cancelled) return
          setBlob(r.blob)
          onRelayChange(r.state)
          setErr('')
        })
        .catch((e) => !cancelled && setErr(String(e)))
    }
    issue()
    const id = setInterval(issue, 4.5 * 60 * 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [signedIn, paired, lanActive, onRelayChange])

  const rePair = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    setRepairing(true)
    try {
      const r = await window.koda.pairRelayDevice()
      setBlob(r.blob)
      onRelayChange(r.state)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!signedIn) {
    return (
      <Centered>
        <p className="text-[12px] leading-snug text-text-muted">
          Sign in to your Koda account to control your Mac over the internet, even off your home Wi‑Fi.
          End-to-end encrypted, so the relay never sees your messages or files.
        </p>
        <Button variant="primary" onClick={toSettings}>Set up</Button>
      </Centered>
    )
  }

  if (paired && !repairing) {
    return (
      <Centered>
        <p className="text-[12px] leading-snug text-text-muted">
          One phone is paired, end-to-end encrypted. Replacing it pairs a new phone and disconnects the old one.
        </p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={rePair}>{busy ? 'Working…' : 'Replace device'}</Button>
          <button
            onClick={toSettings}
            className="text-[11.5px] font-medium text-text-muted transition-colors hover:text-text"
          >
            Manage
          </button>
        </div>
        {err && <p className="text-[11.5px] text-red-500">{err}</p>}
      </Centered>
    )
  }

  return (
    <QrPane
      blob={blob}
      caption="Open Koda on your phone, sign into this account, then scan."
      hint="Expires in 5 minutes · one-time use"
      err={err}
    />
  )
}

// ── Same Wi-Fi (LAN) ─────────────────────────────────────────────────────────────
function LanPane({
  remote,
  busy,
  err,
  onRetry,
}: {
  remote: RemoteState | null
  busy: boolean
  err: string
  onRetry: () => void
}) {
  const running = remote?.running ?? false
  const connected = remote?.connectedClients ?? 0
  const pairUrl = running && remote?.url && remote?.code ? `${remote.url}/?code=${remote.code}` : null

  if (err) {
    return (
      <Centered>
        <p className="text-[12px] leading-snug text-red-500">{err}</p>
        <Button variant="secondary" onClick={onRetry}>{busy ? 'Starting…' : 'Try again'}</Button>
      </Centered>
    )
  }

  return (
    <QrPane
      blob={pairUrl}
      caption="Point your phone's camera at the code. Koda opens and pairs automatically; nothing leaves your network."
      hint={
        connected > 0
          ? `${connected} device${connected > 1 ? 's' : ''} connected`
          : 'No devices connected'
      }
      live={connected > 0}
    />
  )
}

// ── Shared bits ──────────────────────────────────────────────────────────────────
function QrPane({
  blob,
  caption,
  hint,
  live,
  err,
}: {
  blob: string | null
  caption: string
  hint: string
  live?: boolean
  err?: string
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 text-center">
      {blob ? (
        <QrCode value={blob} size={240} />
      ) : (
        <div className="grid size-[240px] place-items-center rounded-lg border border-border bg-bg text-[12px] text-text-muted">
          Starting…
        </div>
      )}
      <p className="text-[12px] leading-snug text-text-muted">{caption}</p>
      <div className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
        {live != null && (
          <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-500' : 'bg-border'}`} />
        )}
        {hint}
      </div>
      {err && <p className="text-[11.5px] text-red-500">{err}</p>}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col items-center gap-3 py-1 text-center">{children}</div>
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  )
}
