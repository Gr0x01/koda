import { useEffect, useState } from 'react'
import type { RemoteAuthState, RemoteRelayState, RemoteState } from '@shared/ipc'
import { Collapse } from '../motion'
import { SettingsRow, SettingsSection, Toggle } from './controls'
import { Button, PixelGlyph } from '../ui'
import { QrCode } from './QrCode'

// ── Koda account (your identity with Koda; cloud-service home) ──────────────────────
// Deliberately separate from the AI providers below: this is your account WITH Koda — the email-OTP
// login the from-anywhere relay rides on, and where Koda's own optional paid cloud plans (Sync / Backup
// / Remote) will be managed. Device pairing itself lives under Remote.
export function KodaAccountSection() {
  return (
    <>
      <CloudAccountPanel />
      <SettingsSection title="Koda Cloud">
        <div className="px-4 py-3.5 text-[12.5px] leading-snug text-text-muted">
          Sync, Backup, and from-anywhere Remote are coming as optional paid plans, managed here on your
          Koda account. The local app stays free.
        </div>
      </SettingsSection>
    </>
  )
}

// ── Cloud account sign-in (email-OTP; lives under Koda account) ───────────────────
// The Mac signs into a Supabase account; the phone signs into the SAME account, so both land on the
// owner-scoped rc:<uid>:* channels for from-anywhere control. A 6-digit code (no magic link — the
// headless Mac has no browser). This is identity only — the device pairing it unlocks lives under
// Remote (RelayPairingSection). LAN control works without any of this.
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
    <SettingsSection title="Account">
      {auth?.signedIn ? (
        <SettingsRow
          label="Signed in"
          description={`${auth.email ?? 'your account'}. Pair a phone under Remote to control your Mac from anywhere.`}
          control={<Button variant="secondary" onClick={signOut}>Sign out</Button>}
        />
      ) : (
        <div>
          <SettingsRow
            label="Control from anywhere"
            description="Sign in to drive your Mac over the internet, even off your home Wi-Fi. Then pair your phone under Remote. End-to-end encrypted, so the relay never sees your messages or files."
          />
          <div className="space-y-2.5 px-4 pb-4">
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
        </div>
      )}
    </SettingsSection>
  )
}

// ── Relay device pairing (lives under Remote) ────────────────────────────────────
// The from-anywhere pairing surface: needs a signed-in Cloud account (under Account). Shows a QR the
// phone scans to derive an end-to-end key. Pauses while Same Wi-Fi is on, so only one QR is ever live.
function RelayPairingSection({ lanActive }: { lanActive: boolean }) {
  const [cloud, setCloud] = useState(false)
  const [auth, setAuth] = useState<RemoteAuthState | null>(null)
  const [relay, setRelay] = useState<RemoteRelayState | null>(null)
  const [pairBlob, setPairBlob] = useState('')
  const [pairing, setPairing] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState('')

  const copyBlob = (): void => {
    navigator.clipboard
      .writeText(pairBlob)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(console.error)
  }

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

  const connectDevice = async (): Promise<void> => {
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

  const forgetDevice = async (): Promise<void> => {
    setErr('')
    try {
      setRelay(await window.koda.forgetRelayDevice())
      setPairBlob('')
    } catch (e) {
      setErr(String(e))
    }
  }

  // From-anywhere is release-flagged off (LAN-only first release): Remote shows only the Same Wi-Fi section.
  if (!cloud) return null

  return (
    <SettingsSection title="Connect from anywhere">
      {!auth?.signedIn ? (
        <div className="px-4 py-3.5 text-[12.5px] leading-snug text-text-muted">
          Sign in under <span className="text-text">Koda account</span> to pair a phone and control your
          Mac from anywhere.
        </div>
      ) : (
        <div>
          <SettingsRow
            label={relay?.paired ? 'A device is paired' : 'Connect a device'}
            description={
              relay?.paired
                ? 'Your phone is paired with an end-to-end encrypted key. The relay only ever sees ciphertext.'
                : lanActive
                  ? 'Paused while Same Wi-Fi is on. Turn that off to pair a device from anywhere.'
                  : 'Scan the code below in the Koda app on your phone, signed into this account. It refreshes on its own.'
            }
            control={
              relay?.paired ? (
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={forgetDevice}>Forget</Button>
                  <Button variant="secondary" onClick={connectDevice}>{pairing ? 'Starting…' : 'Re-pair'}</Button>
                </div>
              ) : undefined
            }
          />
          <Collapse open={!!pairBlob && !lanActive}>
            <div className="space-y-3 px-4 pb-4">
              <div className="flex items-center gap-5">
                <QrCode value={pairBlob ?? ''} size={200} />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold text-text">Scan to pair</div>
                  <div className="mt-1 text-[12.5px] leading-snug text-text-muted">
                    Open Koda on your phone, sign into this account, then scan.
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
                        value={pairBlob ?? ''}
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
          {err && <div className="px-4 pb-3 text-[12px] text-red-500">{err}</div>}
        </div>
      )}
    </SettingsSection>
  )
}

// ── Remote (drive Koda from your phone) ──────────────────────────────────────────
// Phase 0 LAN walking skeleton (remote-control-security.md): turn it on, enter the code on a phone on
// the same Wi-Fi, and drive the live agent (with remote approvals). Off by default — it opens a LAN
// port (the shipped design uses outbound polling instead), so it's a trusted-network dogfood feature.
export function RemoteSection() {
  const [state, setState] = useState<RemoteState | null>(null)
  const refresh = (): void => {
    window.koda.getRemoteState().then(setState).catch(console.error)
  }
  useEffect(refresh, [])
  // Live-update the connected count + running state when a device connects/disconnects.
  useEffect(() => window.koda.onRemoteActivity(() => refresh()), [])

  const [toggleErr, setToggleErr] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const toggle = (next: boolean): void => {
    setToggleErr('')
    window.koda
      .setRemoteEnabled({ enabled: next })
      .then(setState)
      .catch((e) => {
        const msg = String(e?.message ?? e)
        setToggleErr(
          /EADDRINUSE|address already in use/i.test(msg)
            ? 'The local port (4321) is already in use — another Koda or dev instance may still be running. Quit it and try again.'
            : `Couldn't start remote control: ${msg.replace(/^Error invoking remote method '[^']+':\s*/i, '')}`,
        )
        refresh()
      })
  }
  const newCode = (): void => {
    window.koda.newRemoteCode().then(setState).catch(console.error)
  }
  const revoke = (id: string): void => {
    window.koda.revokeRemoteDevice({ id }).then(setState).catch(console.error)
  }

  // The open-source build ships without the phone-control stack; say why the section is empty
  // instead of showing a toggle that can never work.
  if (state?.available === false)
    return (
      <SettingsSection title="Remote">
        <div className="px-4 py-3.5 text-[12.5px] leading-snug text-text-muted">
          Phone control is part of Koda's hosted cloud service. It is not included in this build.
        </div>
      </SettingsSection>
    )

  const running = state?.running ?? false
  const connected = state?.connectedClients ?? 0
  // Encode address + code in one QR so the phone's native camera opens the client and pairs in one tap —
  // no typing the URL or the 6 digits. The code is single-use, so this updates after each pair.
  const pairUrl = state?.url && state?.code ? `${state.url}/?code=${state.code}` : null

  return (
    <>
      {/* One pairing path at a time: while same-Wi-Fi is on, the cloud QR collapses (and stops issuing
          codes in the background) so a phone being paired sees a single QR. The section stays visible. */}
      <RelayPairingSection lanActive={running} />
      <SettingsSection title="Same Wi‑Fi">
        <SettingsRow
          label="Drive Koda from your phone"
          description="No account needed, nothing leaves your network. Pair a phone on the same Wi-Fi to send messages and approve actions. Your Mac stays awake and does the work."
          control={<Toggle checked={running} onChange={toggle} label="Remote control" />}
        />
        {toggleErr && <div className="px-4 pb-3 text-[12.5px] text-red-500">{toggleErr}</div>}
        <Collapse open={running}>
          <div className="space-y-3 p-4">
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
                  Point your phone's camera at the code. Koda opens and pairs automatically, no typing.
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
                    <div className="mt-1.5 flex min-h-8 items-center break-all font-mono text-[14px] text-text">{state?.url ?? '…'}</div>
                  </div>
                  <div className="w-px self-stretch bg-border" />
                  <div className="flex-none">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-text-muted">Pairing code</div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <div className="flex gap-1">
                        {(state?.code ?? '••••••').split('').map((ch, i) => (
                          <span
                            key={i}
                            className="grid h-8 w-[26px] place-items-center rounded-md border border-border bg-surface font-mono text-[15px] font-semibold text-accent"
                          >
                            {ch}
                          </span>
                        ))}
                      </div>
                      <button
                        onClick={newCode}
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
      </SettingsSection>

      {running && state && state.devices.length > 0 && (
        <SettingsSection title="Paired devices">
          {state.devices.map((d) => (
            <SettingsRow
              key={d.id}
              label={d.label}
              description={`Paired ${new Date(d.pairedAt).toLocaleString()}`}
              control={<Button variant="danger" onClick={() => revoke(d.id)}>Remove</Button>}
            />
          ))}
        </SettingsSection>
      )}

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-[12.5px] leading-snug text-text-muted">
        <span className="font-medium text-text">Use this only on a network you trust.</span> While it's on, anyone on
        the same Wi-Fi who has the code can drive the agent on this Mac, which can edit files and run commands. This
        is an early preview; leave it off when you're not actively using it.
      </div>
    </>
  )
}
