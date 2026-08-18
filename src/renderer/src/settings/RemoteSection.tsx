import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  ConnectDevice,
  ConnectEnrollmentRequest,
  ConnectState as ConnectStateIpc,
  RemoteAuthState,
  RemoteRelayState,
  RemoteState,
} from '@shared/ipc'
import { Collapse } from '../motion'
import { SettingsNote, SettingsRow, SettingsSection, Toggle } from './controls'
import { Alert, Button, PixelGlyph } from '../ui'
import { QrCode } from './QrCode'

/**
 * Settings → Remote answers ONE question: can my phone reach this Mac, and what is allowed to.
 *
 * It used to answer it in six sections split by transport (relay pairing vs. tailnet vs. LAN), which
 * is a distinction the user never asked about, and the proof it was wrong was a section that had to
 * give directions to another section ("use Reset access under From anywhere below"). Worse, a device
 * standing at the door with a pending enrolment request had no natural home, so the one screen
 * somebody is actively waiting on buried the thing they were waiting for.
 *
 * Two sections now, organised by what the user is deciding:
 *
 *  - **This Mac** — the doors. One row per way in (Same Wi-Fi, From anywhere), each carrying its live
 *    state inline beside its control, so "is it reachable and at what address" is read, not deduced.
 *  - **Devices** — who may come through them, newest question first: a pending request, then this Mac,
 *    then everything else. Reset access sits on the heading because it acts on the whole list; parking
 *    it on one phone's row is what made an account-wide reset read as a per-device removal.
 *
 * Transport still decides the wiring underneath (relay pairing rides the Koda account, the tailnet
 * rides Connect, Same Wi-Fi rides neither), and all of that stays in the hooks at the top of this file.
 */

// ── Koda account (your identity with Koda; cloud-service home) ──────────────────────
// Deliberately separate from the AI providers below: this is your account WITH Koda — the email-OTP
// login the from-anywhere relay rides on, and where Koda's own optional paid cloud plans (Sync / Backup
// / Remote) will be managed. Device pairing itself lives under Remote.
export function KodaAccountSection() {
  return (
    <>
      <CloudAccountPanel />
      <SettingsSection title="Koda Cloud">
        <SettingsNote>
          Sync, Backup, and from-anywhere Remote are coming as optional paid plans, managed here on your
          Koda account. The local app stays free.
        </SettingsNote>
      </SettingsSection>
    </>
  )
}

// ── Cloud account sign-in (email-OTP; lives under Koda account) ───────────────────
// The Mac signs into a Supabase account; the phone signs into the SAME account, so both land on the
// owner-scoped rc:<uid>:* channels for from-anywhere control. A 6-digit code (no magic link — the
// headless Mac has no browser). This is identity only — the device pairing it unlocks lives under
// Remote. LAN control works without any of this.
function CloudAccountPanel() {
  const [cloud, setCloud] = useState(false)
  const [auth, setAuth] = useState<RemoteAuthState | null>(null)
  // Prefill the last email used — re-typing it on every sign-in is pure friction (just an email, not a
  // secret, so plain localStorage is fine).
  const [email, setEmail] = useState(() => localStorage.getItem('koda_last_email') ?? '')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    window.koda.getCloudRelayEnabled().then(setCloud).catch(console.error)
    window.koda.getRemoteAuth().then(setAuth).catch(console.error)
    return window.koda.onRemoteAuthChanged?.(setAuth)
  }, [])

  const sendCode = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      const r = await window.koda.requestRemoteOtp({ email: email.trim() })
      if (r.ok) {
        localStorage.setItem('koda_last_email', email.trim()) // remember it for next time
        setSent(true)
      }
      else setErr(r.error ?? 'Could not send the code.')
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }
  const verify = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      const r = await window.koda.verifyRemoteOtp({ email: email.trim(), code: code.trim() })
      if (r.ok && r.state) {
        setAuth(r.state)
        setSent(false)
        setCode('')
      } else setErr(r.error ?? 'That code did not work.')
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }
  const signOut = (): void => {
    window.koda.signOutRemoteAccount().then((s) => {
      setAuth(s)
      setSent(false)
      setEmail(localStorage.getItem('koda_last_email') ?? '') // keep it prefilled for the next sign-in
      setCode('')
    }).catch(console.error)
  }

  const inputCls =
    'flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-[12.5px] text-text placeholder:text-text-muted/60 focus:border-accent focus:outline-none'
  const btnCls =
    'rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40'

  // From-anywhere is release-flagged off (LAN-only first release) — the whole account door disappears;
  // the "Koda Cloud" coming-soon note in KodaAccountSection stays as the honest placeholder.
  if (!cloud) return null

  return (
    <SettingsSection
      title="Account"
      note="Your Koda account is what lets a phone reach this Mac over the internet. Traffic is end-to-end encrypted, so the relay never sees your messages or files."
    >
      {auth?.signedIn ? (
        <SettingsRow
          label="Signed in"
          description={`${auth.email ?? 'Your account'} is signed in, so your phone can reach this Mac from anywhere.`}
          control={<Button variant="secondary" onClick={signOut}>Sign out</Button>}
        />
      ) : (
        <SettingsRow
          label={auth?.needsReSignin ? 'Signed out' : 'Control from anywhere'}
          description={
            auth?.needsReSignin
              ? 'Your saved sign-in stopped working, so sign in again and your phone reconnects on its own.'
              : 'Sign in to drive this Mac from your phone over the internet, even off your home Wi-Fi.'
          }
        >
          <div className="space-y-2.5">
            <div className="flex items-center gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  if (err) setErr('')
                }}
                onKeyDown={(e) => e.key === 'Enter' && email.trim() && !busy && sendCode()}
                placeholder="you@example.com"
                disabled={sent}
                className={inputCls}
              />
              <button onClick={sendCode} disabled={!email.trim() || busy || sent} className={btnCls}>
                {busy && !sent ? 'Sending…' : sent ? 'Sent' : 'Send code'}
              </button>
            </div>
            {sent && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value)
                    if (err) setErr('')
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && code.trim() && !busy && verify()}
                  placeholder="Enter the code"
                  className={`${inputCls} font-mono tracking-[0.2em]`}
                />
                <button onClick={verify} disabled={!code.trim() || busy} className={btnCls}>
                  {busy ? 'Checking…' : 'Verify'}
                </button>
              </div>
            )}
            {err && <div className="text-[12px] text-red-500">{err}</div>}
          </div>
        </SettingsRow>
      )}
    </SettingsSection>
  )
}

// ── The one status chip ───────────────────────────────────────────────────────────
// Live state belongs beside the control it describes, not in the row's sentence: "Reachable" and an
// address are read at a glance, a paragraph is not. PixelGlyph is the app's only status language.
function StatusChip({ tone, children }: { tone: 'on' | 'warn' | 'off'; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-[12.5px] text-text-muted">
      <PixelGlyph
        glyph="dotRound"
        size={12}
        className={tone === 'on' ? 'text-emerald-500' : tone === 'warn' ? 'text-amber-500' : 'text-text-muted/50'}
      />
      {children}
    </span>
  )
}

// ── Same Wi-Fi (the LAN walking skeleton) ────────────────────────────────────────
// Phase 0 (remote-control-security.md): turn it on, enter the code on a phone on the same Wi-Fi, and
// drive the live agent (with remote approvals). Off by default — it opens a LAN port, so it is a
// trusted-network dogfood feature.
function useLanRemote() {
  const [state, setState] = useState<RemoteState | null>(null)
  const [toggleErr, setToggleErr] = useState('')
  const refresh = (): void => {
    window.koda.getRemoteState().then(setState).catch(console.error)
  }
  useEffect(refresh, [])
  // Live-update the connected count + running state when a device connects/disconnects.
  useEffect(() => window.koda.onRemoteActivity(() => refresh()), [])

  const toggle = (next: boolean): void => {
    setToggleErr('')
    window.koda
      .setRemoteEnabled({ enabled: next })
      .then(setState)
      .catch((e) => {
        const msg = String(e?.message ?? e)
        setToggleErr(
          /EADDRINUSE|address already in use/i.test(msg)
            ? 'The local port (4321) is already in use, so another Koda or dev instance may still be running. Quit it and try again.'
            : `Couldn't start remote control: ${msg.replace(/^Error invoking remote method '[^']+':\s*/i, '')}`,
        )
        refresh()
      })
  }
  const newCode = (): void => {
    window.koda.newRemoteCode().then(setState).catch(console.error)
  }
  const removeDevice = (id: string): void => {
    window.koda.revokeRemoteDevice({ id }).then(setState).catch(console.error)
  }
  return { state, toggleErr, toggle, newCode, removeDevice }
}
type LanRemote = ReturnType<typeof useLanRemote>

// ── Relay pairing (the from-anywhere door that rides the Koda account) ───────────
// Needs a signed-in Cloud account (under Koda account). Shows a QR the phone scans to derive an
// end-to-end key. Pauses while Same Wi-Fi is on, so only one QR is ever live.
function useRelayPairing(lanActive: boolean) {
  const [cloud, setCloud] = useState(false)
  const [auth, setAuth] = useState<RemoteAuthState | null>(null)
  const [relay, setRelay] = useState<RemoteRelayState | null>(null)
  const [pairBlob, setPairBlob] = useState('')
  const [pairing, setPairing] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    window.koda.getCloudRelayEnabled().then(setCloud).catch(console.error)
    window.koda.getRemoteAuth().then(setAuth).catch(console.error)
    window.koda.getRelayState().then(setRelay).catch(console.error)
  }, [])
  useEffect(() => window.koda.onRelayActivity(setRelay), [])

  // Auto-issue a fresh pairing QR while signed in, not yet paired, and this tab is on screen (the
  // section unmounts when you leave Remote, so the interval is scoped to "visible"). Refresh just
  // before the 5-minute TTL so a left-open QR never goes stale. Re-pairing a paired device stays manual.
  useEffect(() => {
    if (!cloud || !auth?.signedIn || !relay || relay.paired || lanActive) return
    let cancelled = false
    const issue = (): void => {
      window.koda
        .pairRelayDevice()
        .then((r) => {
          if (cancelled) return
          setPairBlob(r.blob)
          setRelay(r.state)
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
    // `relay` itself is deliberately NOT a dep: issue() setRelay()s fresh state each cycle, so
    // depending on the object would re-issue the QR in a loop — only paired-ness matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud, auth?.signedIn, relay?.paired, lanActive])

  const rePair = async (): Promise<void> => {
    setPairing(true)
    try {
      const r = await window.koda.pairRelayDevice()
      setPairBlob(r.blob)
      setRelay(r.state)
    } catch (e) {
      setErr(String(e))
    } finally {
      setPairing(false)
    }
  }

  const forgetPairing = async (): Promise<void> => {
    setErr('')
    try {
      setRelay(await window.koda.forgetRelayDevice())
      setPairBlob('')
    } catch (e) {
      setErr(String(e))
    }
  }

  return { cloud, auth, relay, pairBlob, pairing, err, rePair, forgetPairing }
}
type RelayPairing = ReturnType<typeof useRelayPairing>

// ── Connect (this Mac on your own private network) ───────────────────────────────
// The Connect tier's whole Mac-side surface: whether this Mac is reachable, which devices are on the
// account's private network, and the account-wide reset. Build A has no secure node ↔ login ↔ pairing
// identity, so the reset deliberately clears every remote device, signs out every Koda session
// including this Mac, and wipes pairing. A fresh OTP is required before this Mac can rejoin. A partial
// failure names the plane still standing rather than reporting a bare "failed".
//
// DERP is not an error. First contact between two devices rides a relay and upgrades to a direct path
// seconds later, so the relayed reading says reachable, never disconnected.

/**
 * The waiting-device rows this pane may offer Allow and Deny on.
 *
 * The list from the gate carries decided requests too, and they stay on it until they expire. Rendering
 * one is a dead end in both directions: a refused device reads as "wants to join" with a live Allow,
 * and the gate refuses to overturn a refusal, so the tap can only fail. An approved-but-uncollected row
 * is the same shape of lie, offering a decision that was already made.
 *
 * Exported so this stays a checkable rule rather than a filter buried in a fetch handler, which is what
 * it was when a denied row could still be tapped.
 */
export function actionableEnrollments(requests: ConnectEnrollmentRequest[]): ConnectEnrollmentRequest[] {
  return requests.filter((request) => request.status === 'pending')
}

/** connectActivity also fires on peer-path chatter — connect-node.ts emits after every peer-path
 *  event, with no equality check on the derived `path` — not just an actual lifecycle move.
 *  loadDevices() costs two HTTP round trips, and GET /connect/devices shares its per-IP rate budget
 *  with the node's own device-key enrollment call (infra/connect/api/server.mjs), so an open Settings
 *  pane must not refetch on every emitted status, only when the lifecycle itself moved. Kept as a
 *  pure exported predicate so the rate-budget rule has direct regression coverage. */
export function connectLifecycleChanged(prev: ConnectStateIpc | null, next: ConnectStateIpc): boolean {
  if (!prev) return true
  return (
    prev.state !== next.state ||
    prev.reason !== next.reason ||
    prev.enabled !== next.enabled ||
    prev.available !== next.available
  )
}

/** A durable reset stays reachable even while Connect itself is disabled. A fresh reset hides this
 *  row only for its first in-flight attempt; a retry keeps the recovery control visible. */
export function pendingResetRecoveryVisible(
  pendingReset: { nodeId: string; requestId: string } | null,
  busyId: string,
  freshResetInFlight: boolean,
): boolean {
  return !!pendingReset && !(busyId && freshResetInFlight)
}

/** Whether Connect is a live door on this Mac at all: the dogfood flag on and a helper in this build.
 *  Everything Connect-shaped (its status line, its device list, Reset access) hangs off this, so a
 *  build or a flag that cannot do any of it renders none of it rather than an inert control. */
function connectLive(state: ConnectStateIpc | null | undefined): state is ConnectStateIpc {
  return !!state?.enabled && !!state.available
}

/** How often an open Settings pane re-asks for devices waiting to join.
 *
 *  Only while the pane is open, deliberately. A background poll would be a call to the coordination
 *  box every few seconds for the whole life of the app, on a shared 30/minute budget, for a prompt
 *  nobody is looking at. The phone's own card sends RB here, so "here" is where the poll belongs. */
const ENROLLMENT_POLL_MS = 5_000

/** "asked 2 minutes ago". A request lives 30 minutes, so minutes are the only unit needed. This is a
 *  clause in the row's meta line, not a sentence, because the meta line is where the warning lives. */
function askedAgo(at: number | null): string {
  if (!at) return 'asked to join'
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) return 'asked just now'
  return `asked ${minutes} minute${minutes === 1 ? '' : 's'} ago`
}

/** The platform, in the words the owner of the device would use. Unknown stays unnamed rather than
 *  guessed: this line is the one thing standing between RB and allowing someone else's device. */
function deviceKind(platform: string): string {
  if (platform === 'ios') return 'iPhone'
  if (platform === 'macos') return 'Mac'
  return 'Device'
}

function useConnect() {
  const [state, setState] = useState<ConnectStateIpc | null>(null)
  const [devices, setDevices] = useState<ConnectDevice[]>([])
  const [listError, setListError] = useState('')
  // Devices asking to join, and whether this Mac is even allowed to answer them. `available:false`
  // means it holds no approver credential, which is a different sentence from "nothing is waiting".
  const [enrollments, setEnrollments] = useState<ConnectEnrollmentRequest[]>([])
  // Starts TRUE so the "this Mac cannot allow devices" note appears only when the Mac actually said
  // so. A preload that predates this API answers nothing at all, and a note explaining an unusual
  // state must never be what an unanswered call looks like.
  const [enrollmentsAvailable, setEnrollmentsAvailable] = useState(true)
  const [enrollmentError, setEnrollmentError] = useState('')
  const [decidingId, setDecidingId] = useState('')
  const [busyId, setBusyId] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const [revokeError, setRevokeError] = useState('')
  const [resetNotice, setResetNotice] = useState('')
  // The main-process journal is the sole durable source. Renderer storage created a competing reset ID
  // that another window could overwrite; this state is only its current display.
  const [pendingReset, setPendingReset] = useState<{ nodeId: string; requestId: string } | null>(null)
  // True only between a FRESH reset's optimistic set and its settle — never for a "Finish reset" retry
  // of a pendingReset main already confirmed. Without this, the row below would call every healthy
  // in-flight reset "interrupted"; with it, a retry of an already-durable pendingReset still keeps the
  // row (and its own "Finishing…" feedback) instead of vanishing the instant it's clicked.
  const [freshResetInFlight, setFreshResetInFlight] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  // The lifecycle connectLifecycleChanged last compared against, so a loadDevices() refetch tracks the
  // node's actual state rather than every peer-path push.
  const lastActivity = useRef<ConnectStateIpc | null>(null)

  const loadDevices = (): void => {
    // Optional-chained: a dev window whose preload predates this API must degrade, not crash (the
    // HMR preload-version gap).
    window.koda
      .getConnectDevices?.()
      .then((r) => {
        setDevices(r.devices)
        setListError(r.error ?? '')
        setPendingReset(r.pendingReset ?? null)
      })
      .catch((e) => setListError(String(e)))
  }

  // Optional-chained for the same reason loadDevices is: a dev window whose preload predates this
  // API must degrade to "nothing waiting", not crash the whole pane (the HMR preload-version gap).
  const loadEnrollments = (): void => {
    const pending = window.koda.getConnectEnrollments?.()
    if (!pending) return
    pending
      .then((r) => {
        setEnrollments(actionableEnrollments(r.requests))
        setEnrollmentsAvailable(r.available)
        setEnrollmentError(r.error ?? '')
      })
      .catch((e) => setEnrollmentError(String(e)))
  }

  useEffect(() => {
    window.koda.getConnectState?.().then(setState).catch(console.error)
    loadDevices()
    return window.koda.onConnectActivity?.((next) => {
      setState(next)
      if (connectLifecycleChanged(lastActivity.current, next)) loadDevices()
      lastActivity.current = next
    })
  }, [])

  // Someone standing at their phone is waiting on this pane, so it re-asks while it is open. A
  // request that arrives one second after the pane opened must not need RB to close and reopen it.
  // Gated on Connect actually being a live door: a flag-off Mac renders no enrolment surface at all,
  // so polling the rate-limited coordination box for it every five seconds buys nothing.
  const pollable = connectLive(state)
  useEffect(() => {
    if (!pollable) return
    loadEnrollments()
    const timer = setInterval(loadEnrollments, ENROLLMENT_POLL_MS)
    return () => clearInterval(timer)
  }, [pollable])

  const decide = (requestId: string, decision: 'approve' | 'deny'): void => {
    setDecidingId(requestId)
    setEnrollmentError('')
    // Promise.resolve wraps the optional call so an older preload still reaches .finally(); an
    // unwrapped optional call resolves to undefined and throws past the whole chain, which would
    // leave this row stuck on "Allowing…" for the rest of the run.
    Promise.resolve(window.koda.decideConnectEnrollment?.({ requestId, decision }))
      .then((r) => {
        if (r && !r.ok) setEnrollmentError(r.error ?? 'That did not go through, so nothing changed.')
        // Drop the decided row immediately rather than waiting for the refetch. Until that lands, the
        // row is still on screen with a live Allow beside the Deny that just went through, and tapping
        // it there is the one way to reach the gate's refusal-cannot-be-overturned answer from this
        // pane. Only on a confirmed ok: an older preload answers `undefined` here, having decided
        // nothing at all, and removing the row on that would hide a request still waiting.
        if (r?.ok) setEnrollments((rows) => rows.filter((row) => row.requestId !== requestId))
        loadEnrollments()
        // An allowed device joins within seconds, so refresh what the list below shows too.
        if (decision === 'approve') loadDevices()
      })
      .catch((e) => setEnrollmentError(String(e)))
      .finally(() => setDecidingId(''))
  }

  const resetAccess = (id: string, retryId?: string): void => {
    const fresh = !retryId
    const requestId = retryId ?? crypto.randomUUID()
    // Main journals before its first await. If the IPC never reaches main, no reset began; once it
    // does, every window and restart reads the same durable request ID from main.
    const pending = { nodeId: id, requestId }
    setPendingReset(pending)
    if (fresh) setFreshResetInFlight(true)
    setBusyId(id)
    setConfirmReset(false)
    setRevokeError('')
    setResetNotice('')
    // Promise.resolve(...) wraps the optional call so a preload predating this API still reaches
    // .finally(): an unwrapped `revokeConnectDevice?.()` resolves straight to undefined when the
    // method is missing, and calling .then() on undefined throws synchronously past the whole chain.
    // busyId and freshResetInFlight then never clear, and this row stays hidden for the rest of the run.
    Promise.resolve(window.koda.revokeConnectDevice?.({ nodeId: id, requestId }))
      .then((r) => {
        if (!r) {
          setRevokeError('Some remote access could not be reset. Restart Koda and try again.')
          loadDevices()
          return
        }
        if (!r.ok) {
          setRevokeError(r.message ?? 'Some remote access could not be reset.')
          loadDevices()
          return
        }
        if (r.requiresReauth) {
          setDevices([])
          setPendingReset(null)
          setListError('')
          setResetNotice('Remote access was reset on every device. Sign in again to reconnect this Mac, then pair trusted phones again.')
          return
        }
        loadDevices()
      })
      .catch((e) => {
        setRevokeError(String(e))
        loadDevices()
      })
      .finally(() => {
        setBusyId('')
        setFreshResetInFlight(false)
      })
  }

  const reconnect = (): void => {
    setReconnecting(true)
    window.koda
      .reconnectConnectNode?.()
      .then(setState)
      .catch(console.error)
      .finally(() => setReconnecting(false))
  }

  return {
    state,
    devices,
    listError,
    enrollments,
    enrollmentsAvailable,
    enrollmentError,
    decidingId,
    busyId,
    confirmReset,
    setConfirmReset,
    revokeError,
    resetNotice,
    pendingReset,
    freshResetInFlight,
    reconnecting,
    decide,
    resetAccess,
    reconnect,
  }
}
type Connect = ReturnType<typeof useConnect>

// ── This Mac ─────────────────────────────────────────────────────────────────────
// The doors, one row each. Every row is a label, one sentence, and its control, with the live state
// sitting beside the control rather than inside the sentence.

function ThisMacSection({ lan, relay, connect }: { lan: LanRemote; relay: RelayPairing; connect: Connect }) {
  const [manualOpen, setManualOpen] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const running = lan.state?.running ?? false
  const connected = lan.state?.connectedClients ?? 0
  // Encode address + code in one QR so the phone's native camera opens the client and pairs in one tap —
  // no typing the URL or the 6 digits. The code is single-use, so this updates after each pair.
  // hosts[0] already is state.url's address; bundle the rest so the phone can try every reachable IP.
  const altHosts = (lan.state?.hosts ?? []).slice(1)
  const pairUrl =
    lan.state?.url && lan.state?.code
      ? `${lan.state.url}/?code=${lan.state.code}${altHosts.length ? `&hosts=${encodeURIComponent(altHosts.join(','))}` : ''}`
      : null
  // The address the phone types, with the scheme stripped: it is a thing you read off a screen and
  // copy onto a keypad, not a link anybody clicks on the Mac that is serving it.
  const lanAddress = lan.state?.url?.replace(/^https?:\/\//, '') ?? null

  const copyBlob = (): void => {
    navigator.clipboard
      .writeText(relay.pairBlob)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(console.error)
  }

  // Non-null only while Connect is a live door here, so every reading below is either about a real
  // node or about the relay, never about a flag-off node's leftover fields.
  const node = connectLive(connect.state) ? connect.state : null
  const reachable = node?.state === 'connected'
  const relayed = reachable && node.path === 'relayed'
  // A green "Reachable" is technically true while this Mac holds no approver credential, and useless:
  // the one thing the user came here to do (let a phone in) is exactly what it cannot do.
  const cannotApprove = reachable && !connect.enrollmentsAvailable && !connect.enrollmentError

  const anywhere: { tone: 'on' | 'warn' | 'off'; status: string; description: string } | null = node
    ? {
        tone: cannotApprove ? 'warn' : reachable ? 'on' : node.state === 'failed' ? 'warn' : 'off',
        status: cannotApprove
          ? 'Cannot approve devices'
          : reachable
            ? relayed
              ? 'Reachable, relayed'
              : 'Reachable'
            : node.state === 'connecting' || node.state === 'reconnecting'
              ? 'Connecting'
              : node.reason === 'signed-out'
                ? 'Signed out'
                : 'Not reachable',
        description: reachable
          ? relayed
            ? 'Your phone can reach this Mac right now, over a relay while a direct path forms.'
            : 'Your phone can reach this Mac from anywhere while Koda is open.'
          : node.state === 'connecting'
            ? 'Koda is putting this Mac on your private network.'
            : node.state === 'reconnecting'
              ? 'The connection dropped, so Koda is joining again.'
              : node.reason === 'signed-out'
                ? 'Sign in to your Koda account and this Mac joins your private network.'
                : node.reason === 'unavailable'
                  ? 'This build has no connection helper, so nothing outside can reach this Mac.'
                  : // This Mac is the one waiting, which happens when the account already had a device
                    // before this Mac asked. Retrying cannot help, so the row says where the answer is.
                    node.reason === 'needs-approval'
                    ? 'Another device on your account has to allow this Mac onto your private network.'
                    : node.reason === 'denied'
                      ? 'A device already on your private network turned this Mac down.'
                      : 'Koda could not join your private network, and it tries again when you sign in or wake this Mac.',
      }
    : relay.cloud
      ? // Connect is not a door here, so the from-anywhere row speaks for the relay pairing instead.
        !relay.auth?.signedIn
        ? { tone: 'off', status: 'Signed out', description: 'Sign in to your Koda account and a phone can reach this Mac from anywhere.' }
        : relay.relay?.paired
          ? { tone: 'on', status: 'Paired', description: 'A trusted phone is paired, so it can drive Koda with the same permissions you use on this Mac.' }
          : running
            ? { tone: 'off', status: 'Not paired', description: 'Pairing here is paused while Same Wi-Fi is on, so turn that off to pair from anywhere.' }
            : { tone: 'off', status: 'Not paired', description: 'Scan the code below in the Koda app on your phone, signed into this account.' }
      : null

  // Recovery must never be "quit Koda". Hidden only where a rejoin cannot be the answer: signed out
  // (sign in) and no helper in this build (nothing to join with).
  const canReconnect =
    !!node &&
    node.reason !== 'signed-out' &&
    node.reason !== 'unavailable' &&
    node.reason !== 'needs-approval' &&
    node.reason !== 'denied'

  return (
    <SettingsSection
      title="This Mac"
      note="How your phone reaches this Mac. Your files stay here either way, and from-anywhere access ends when you quit Koda."
    >
      <SettingsRow
        label="Same Wi‑Fi"
        description="Your phone can drive Koda only while it is on this network."
        control={
          <div className="flex items-center gap-3">
            {running && (
              <StatusChip tone={lanAddress ? 'on' : 'off'}>
                {lanAddress ? <span className="font-mono text-text">{lanAddress}</span> : 'Starting…'}
              </StatusChip>
            )}
            <Toggle checked={running} onChange={lan.toggle} label="Same Wi-Fi" />
          </div>
        }
      />
      {lan.toggleErr && <div className="pb-3 text-[12.5px] text-red-500">{lan.toggleErr}</div>}
      {/* Attached to the row above, not folded into it: a closed Collapse renders nothing, and a row
          `children` slot would still spend its margin on the empty case every time the toggle is off. */}
      <Collapse open={running}>
          <div className="space-y-3 pb-1">
            {/* Scan-first, but horizontal so a wide panel isn't a sparse column: compact QR (native
                camera → opens the client → auto-pairs) beside the caption + live status; the URL +
                6-digit code recede into a disclosure for the can't-scan case. */}
            <div className="flex items-center gap-5">
              {pairUrl ? (
                <QrCode value={pairUrl} size={132} />
              ) : (
                <div className="grid size-[132px] place-items-center rounded-lg border border-border bg-bg text-[12.5px] text-text-muted">
                  Starting…
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-text">Scan to connect</div>
                <div className="mt-1 text-[12.5px] leading-snug text-text-muted">
                  Point your phone's camera at the code, and Koda opens and pairs with no typing.
                </div>
                {/* The grant is explained BESIDE the QR, deliberately: a phone that scans this becomes a
                    trusted controller, and that has to be readable at the moment of scanning. */}
                <div className="mt-1.5 text-[12.5px] leading-snug text-text-muted">
                  Pairing gives that phone control of Koda, including editing projects and running
                  commands on this Mac.
                </div>
                <div className="mt-2.5 flex items-center gap-2 text-[12.5px] text-text-muted">
                  <PixelGlyph glyph="dotRound" size={12} className={connected > 0 ? 'text-emerald-500' : 'text-text-muted/50'} />
                  {connected > 0
                    ? `${connected} device${connected > 1 ? 's' : ''} connected right now`
                    : 'No devices connected'}
                </div>
              </div>
            </div>

            <div>
              <button
                onClick={() => setManualOpen((o) => !o)}
                className="flex items-center gap-1.5 text-[12.5px] font-medium text-text-muted transition-colors hover:text-text"
              >
                <span
                  className="text-text-muted/70 transition-transform"
                  style={{ transform: manualOpen ? 'rotate(90deg)' : 'none' }}
                >
                  ›
                </span>
                Can't scan? Connect manually
              </button>
              <Collapse open={manualOpen}>
                <div className="mt-3 flex items-start gap-5 rounded-xl border border-border bg-bg px-4 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-text-muted">Address</div>
                    <div className="mt-1.5 flex min-h-8 items-center break-all font-mono text-[14px] text-text">{lan.state?.url ?? '…'}</div>
                  </div>
                  <div className="w-px self-stretch bg-border" />
                  <div className="flex-none">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-text-muted">Pairing code</div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <div className="flex gap-1">
                        {(lan.state?.code ?? '••••••').split('').map((ch, i) => (
                          <span
                            key={i}
                            className="grid h-8 w-[26px] place-items-center rounded-md border border-border bg-surface font-mono text-[15px] font-semibold text-accent"
                          >
                            {ch}
                          </span>
                        ))}
                      </div>
                      <button
                        onClick={lan.newCode}
                        title="New code"
                        aria-label="New code"
                        className="grid h-8 w-8 place-items-center rounded-md text-text-muted transition-colors hover:bg-accent/10 hover:text-accent"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                          <path d="M21 3v5h-5" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              </Collapse>
            </div>
          </div>
        </Collapse>

      {anywhere && (
        <SettingsRow
          label="From anywhere"
          description={anywhere.description}
          control={
            <div className="flex items-center gap-3">
              <StatusChip tone={anywhere.tone}>{anywhere.status}</StatusChip>
              {canReconnect && (
                <Button
                  variant="secondary"
                  disabled={connect.reconnecting || !!connect.pendingReset}
                  onClick={connect.reconnect}
                >
                  {connect.reconnecting ? 'Reconnecting…' : 'Reconnect'}
                </Button>
              )}
            </div>
          }
        />
      )}
      {anywhere && relay.cloud && (
        <div className="space-y-2">
          {!relay.auth?.signedIn && (
            <div className="text-[12.5px] leading-snug text-text-muted">
              Sign in under <span className="text-text">Koda account</span> to pair a phone.
            </div>
          )}
          {relay.auth?.signedIn && relay.relay?.paired && (
            <div className="space-y-2 pb-2">
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={relay.forgetPairing}>Forget pairing</Button>
                <Button variant="secondary" onClick={relay.rePair}>{relay.pairing ? 'Starting…' : 'Re-pair'}</Button>
              </div>
              <div className="text-[12.5px] leading-snug text-text-muted">
                Forgetting the encrypted pairing on this Mac signs out every other Koda device, and it
                leaves private-network access alone.
              </div>
            </div>
          )}
          {relay.auth?.signedIn && !relay.relay?.paired && (
            <Collapse open={!!relay.pairBlob && !running}>
              <div className="space-y-3 pb-1">
                <div className="flex items-center gap-5">
                  <QrCode value={relay.pairBlob ?? ''} size={200} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-text">Scan to trust this phone</div>
                    <div className="mt-1 text-[12.5px] leading-snug text-text-muted">
                      Pairing gives this phone control of Koda, including editing projects and running commands on this Mac.
                    </div>
                    <div className="mt-2 text-[12px] text-text-muted">Expires in 5 minutes, one-time use.</div>
                  </div>
                </div>
                <div>
                  <button
                    onClick={() => setCopyOpen((o) => !o)}
                    className="flex items-center gap-1.5 text-[12.5px] font-medium text-text-muted transition-colors hover:text-text"
                  >
                    <span
                      className="text-text-muted/70 transition-transform"
                      style={{ transform: copyOpen ? 'rotate(90deg)' : 'none' }}
                    >
                      ›
                    </span>
                    Can't scan? Copy the code
                  </button>
                  <Collapse open={copyOpen}>
                    <div className="mt-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={relay.pairBlob ?? ''}
                          onFocus={(e) => e.currentTarget.select()}
                          className="min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 py-2 font-mono text-[11px] text-text-muted focus:border-accent focus:outline-none"
                        />
                        <button
                          onClick={copyBlob}
                          title={copied ? 'Copied' : 'Copy'}
                          aria-label={copied ? 'Copied' : 'Copy'}
                          className="grid size-9 flex-none place-items-center rounded-xl border border-border text-text-muted transition-colors hover:bg-accent/10 hover:text-accent"
                        >
                          {copied ? (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M20 6 9 17l-5-5" />
                            </svg>
                          ) : (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <rect x="9" y="9" width="13" height="13" rx="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      </div>
                      <div className="text-[12px] text-text-muted">
                        Then on your phone: open Koda, tap Connect from anywhere, and choose Paste code.
                      </div>
                    </div>
                  </Collapse>
                </div>
              </div>
            </Collapse>
          )}
          {relay.err && <div className="text-[12px] text-red-500">{relay.err}</div>}
        </div>
      )}
    </SettingsSection>
  )
}

// ── Devices ──────────────────────────────────────────────────────────────────────
// One list of everything that can reach this Mac, ordered by what needs an answer: a device standing
// at the door first, then this Mac, then everyone already through.

function DevicesSection({
  lan,
  connect,
  relay,
}: {
  lan: LanRemote
  connect: Connect
  relay: RelayPairing
}) {
  const node = connectLive(connect.state) ? connect.state : null
  const reachable = node?.state === 'connected'
  const thisMac = connect.devices.find((d) => d.isThisMac)
  const otherDevices = connect.devices.filter((d) => !d.isThisMac)
  const lanDevices = lan.state?.devices ?? []
  // The relay pairing is the highest-privilege connection on this pane and it was the one missing from
  // the list. A phone paired this way drives Koda with the owner's permissions right now, so a list
  // headed "everything that can reach this Mac" that omitted it was not just incomplete, it read as
  // proof that nothing else had access. It has no name or pairing date because pairing never recorded
  // either — only the phone's keys are kept — so the row says what is true and no more.
  const relayPaired = relay.relay?.paired === true

  // The reset is account-wide on every plane, so the node it names is only the ownership handle the
  // coordination service checks against the account; it must be a node the account really has, or the
  // ceremony 404s as target-gone and only the local planes clear. Prefer another device (exactly what
  // the old per-row control passed), and fall back to this Mac so the cannot-approve state — where
  // this Mac is often the only device left — still has the way out its own note points at.
  const resetTarget = otherDevices[0] ?? thisMac ?? null

  // A standing fence closes every remote path, same-Wi-Fi included, so the only thing that clears it
  // must outlive Connect's own flag. Turning the flag off after a half-done reset used to hide this row
  // and leave the Mac unreachable with nothing on screen naming why.
  const finishResetRow = pendingResetRecoveryVisible(
    connect.pendingReset,
    connect.busyId,
    connect.freshResetInFlight,
  ) && (
    <SettingsRow
      label="Remote-access reset needs finishing"
      description="Access stays closed until this interrupted remote-access reset finishes."
      control={
        <Button
          variant="danger"
          disabled={!!connect.busyId}
          onClick={() => connect.resetAccess(connect.pendingReset!.nodeId, connect.pendingReset!.requestId)}
        >
          {connect.busyId ? 'Finishing…' : 'Finish reset'}
        </Button>
      }
    />
  )

  // Nothing to list and nothing to recover from: the whole section stays off screen rather than
  // showing an empty heading. Reset outcomes still need a home, since the click that produced them
  // can be the last thing this pane had to say.
  const anything =
    !!node ||
    lanDevices.length > 0 ||
    !!connect.pendingReset ||
    !!connect.resetNotice ||
    !!connect.revokeError
  if (!anything) return null

  const resetAction = !!node && resetTarget && (
    connect.confirmReset ? (
      <span className="flex items-center gap-2 text-[12px]">
        <button
          className="font-medium text-red-500 transition-colors hover:text-red-400"
          disabled={!!connect.busyId || !!connect.pendingReset}
          onClick={() => connect.resetAccess(resetTarget.id)}
        >
          Reset every device
        </button>
        <button
          className="text-text-muted transition-colors hover:text-text"
          onClick={() => connect.setConfirmReset(false)}
        >
          Cancel
        </button>
      </span>
    ) : (
      <Button
        variant="danger"
        size="sm"
        disabled={!!connect.busyId || !!connect.pendingReset}
        onClick={() => connect.setConfirmReset(true)}
      >
        {connect.busyId ? 'Resetting…' : 'Reset access'}
      </Button>
    )
  )

  return (
    <SettingsSection
      title="Devices"
      // The section's shared context gives way to the consequence at the moment of the decision, so
      // the full scope of an account-wide reset is read where it is about to be agreed to. As a
      // standing paragraph at the foot of the list it was prose nobody reads, sitting a whole list
      // away from the control it describes.
      note={
        connect.confirmReset
          ? 'Reset access removes every device from your private network and signs out every Koda device, including this Mac. You’ll sign in again to reconnect this Mac, then pair trusted phones again.'
          : 'Everything that can reach this Mac. A device on this list can send instructions, approve actions, edit projects, and run commands with the same permissions you use here.'
      }
      action={resetAction || undefined}
    >
      {/* THE GATE. A Koda account password alone must never be enough to reach this Mac, so a second
          device waits here until someone standing at an already-connected one says yes. It sits at the
          TOP of the list and inside the one warning callout on this pane, because it is the only thing
          on this screen that somebody is standing at a phone waiting for. */}
      {connect.enrollments.length > 0 && (
        <Alert tone="warning" className="my-2">
          <div className="space-y-3">
            {connect.enrollments.map((request) => (
              <div key={request.requestId} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[13.5px] font-medium text-text">{request.deviceName} wants to join</div>
                  <div className="mt-1 text-[12.5px] leading-snug text-text-muted">
                    {deviceKind(request.platform)} · {askedAgo(request.requestedAt)} · allow only if this is you
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    disabled={!!connect.decidingId}
                    onClick={() => connect.decide(request.requestId, 'deny')}
                  >
                    Deny
                  </Button>
                  <Button
                    variant="primary"
                    disabled={!!connect.decidingId}
                    onClick={() => connect.decide(request.requestId, 'approve')}
                  >
                    {connect.decidingId === request.requestId ? 'Working…' : 'Allow'}
                  </Button>
                </div>
              </div>
            ))}
            <div className="text-[12.5px] leading-snug text-text-muted">
              Anyone who knows your Koda password can raise this and name the device anything, and
              allowing it puts that device on your private network until you reset access.
            </div>
          </div>
        </Alert>
      )}
      {connect.enrollmentError && <div className="pb-3 text-[12.5px] text-red-500">{connect.enrollmentError}</div>}

      {thisMac && (
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              {thisMac.name}
              <span className="rounded border border-border px-1.5 py-px text-[11px] font-normal text-text-muted">
                This Mac
              </span>
            </span>
          }
          description={
            !reachable
              ? 'This Mac, on your private network.'
              : connect.enrollmentsAvailable
                ? 'Approves the devices that ask to join.'
                : 'Cannot approve the devices that ask to join.'
          }
          control={<StatusChip tone={thisMac.online ? 'on' : 'off'}>{thisMac.online ? 'Online' : 'Offline'}</StatusChip>}
        />
      )}

      {otherDevices.map((d) => (
        <SettingsRow
          key={d.id}
          label={d.name}
          description={
            d.lastSeenAt ? `Last seen ${new Date(d.lastSeenAt).toLocaleString()}.` : 'Has joined your private network.'
          }
          control={<StatusChip tone={d.online ? 'on' : 'off'}>{d.online ? 'Online' : 'Offline'}</StatusChip>}
        />
      ))}

      {relayPaired && (
        <SettingsRow
          label="Paired phone"
          description="Drives Koda from anywhere with the same permissions you use here."
          control={
            <Button variant="danger" onClick={relay.forgetPairing}>
              Remove
            </Button>
          }
        />
      )}

      {/* Paired over the LAN, which is the one credential here that CAN be taken away on its own, so
          this is the only row that gets a scoped Remove. Listed even while Same Wi-Fi is switched off:
          a pairing that survives the toggle has to stay visible and immediately removable. */}
      {lanDevices.map((d) => (
        <SettingsRow
          key={`lan-${d.id}`}
          label={d.label}
          description={`Paired on this Wi-Fi ${new Date(d.pairedAt).toLocaleString()}.`}
          control={<Button variant="danger" onClick={() => lan.removeDevice(d.id)}>Remove</Button>}
        />
      ))}

      {/* Silent whenever "nobody has joined" is not the useful reading. A device already waiting at
          the door has not "not joined yet", and telling the owner to sign in on their phone is advice
          they just followed. A Mac that cannot approve anyone would be sending them at a shut door. */}
      {node &&
        otherDevices.length === 0 &&
        lanDevices.length === 0 &&
        !relayPaired &&
        connect.enrollments.length === 0 &&
        connect.enrollmentsAvailable &&
        !connect.listError &&
        !connect.resetNotice && (
          <SettingsNote>Nothing else has joined yet, so sign in on your phone to add it.</SettingsNote>
        )}

      {/* The one state with no in-app fix. This Mac is on the network but holds no credential proving
          it, so it cannot answer for anyone. Only reachable when devices were removed outside a reset,
          or when this Mac's own credential was lost with its Keychain entry. Reset access is the way
          back: it clears the account's record, and the next device to join establishes a new one. */}
      {reachable && !connect.enrollmentsAvailable && !connect.enrollmentError && (
        <SettingsNote>
          This Mac cannot allow other devices onto your private network. Use{' '}
          <span className="text-text">Reset access</span> above, then sign in again on this Mac to put it
          back in charge.
        </SettingsNote>
      )}

      {finishResetRow}

      {connect.resetNotice && <SettingsNote>{connect.resetNotice}</SettingsNote>}
      {connect.listError && <div className="pb-3 text-[12.5px] text-text-muted">{connect.listError}</div>}
      {connect.revokeError && <div className="pb-3 text-[12.5px] text-red-500">{connect.revokeError}</div>}
    </SettingsSection>
  )
}

export function RemoteSection() {
  const lan = useLanRemote()
  // One pairing path at a time: while same-Wi-Fi is on, the relay QR collapses (and stops issuing
  // codes in the background) so a phone being paired sees a single QR.
  const relay = useRelayPairing(lan.state?.running ?? false)
  const connect = useConnect()

  // The open-source build ships without the phone-control stack; say why the pane is empty instead of
  // showing doors that can never open.
  if (lan.state?.available === false)
    return (
      <SettingsSection title="This Mac">
        <SettingsNote>
          Phone control is part of Koda's hosted cloud service. It is not included in this build.
        </SettingsNote>
      </SettingsSection>
    )

  return (
    <>
      <ThisMacSection lan={lan} relay={relay} connect={connect} />
      <DevicesSection lan={lan} connect={connect} relay={relay} />
    </>
  )
}
