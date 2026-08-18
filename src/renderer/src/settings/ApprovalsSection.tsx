import { useEffect, useState } from 'react'
import type { ApprovalMode } from '@shared/ipc'
import { useWorkspace } from '../workspace/store'
import { useRuntime, useBrowserTesting } from '../workspace/useProvisioning'
import type { PlaywrightStatus, RuntimeId, RuntimeStatus } from '@shared/ipc'
import { SegmentedControl, SettingsRow, SettingsSection, Toggle } from './controls'
import { BusyText } from '../ui'

// Plan is excluded — it's a per-session, spawn-time mode, never a global default (main clamps it too).
const APPROVAL_OPTIONS: { value: ApprovalMode; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Builds on its own (destructive git + recovery still confirm)' },
  { value: 'ask', label: 'Check first', title: 'Asks before every edit and command' },
]

export function ApprovalsSection() {
  const defaultApprovalMode = useWorkspace((s) => s.defaultApprovalMode)
  const setDefaultApprovalMode = useWorkspace((s) => s.setDefaultApprovalMode)
  const [previewAutoStart, setPreviewAutoStart] = useState<boolean | null>(null)

  useEffect(() => {
    window.koda.getSettings().then((s) => setPreviewAutoStart(s.previewAutoStart)).catch(console.error)
  }, [])

  const change = (mode: ApprovalMode): void => {
    setDefaultApprovalMode(mode) // new sessions in this window pick it up immediately
    window.koda.updateSettings({ defaultApprovalMode: mode }).catch(console.error) // persist + live gate
  }

  const toggleAutoStart = (next: boolean): void => {
    setPreviewAutoStart(next)
    window.koda.updateSettings({ previewAutoStart: next }).catch(console.error) // persist + live gate
  }

  // The default never sits at 'plan'; if a stale value ever did, fall the control back to Auto.
  const value: ApprovalMode = defaultApprovalMode === 'plan' ? 'auto' : defaultApprovalMode

  return (
    <SettingsSection
      title="Approvals"
      note="You can change this per session from the session header. Destructive git operations and recovery always confirm, in every mode."
    >
      <SettingsRow
        label="Default mode for new sessions"
        description="How much the agent checks with you before it edits a file or runs a command."
        control={
          <SegmentedControl
            ariaLabel="Default approval mode"
            value={value}
            options={APPROVAL_OPTIONS}
            onChange={change}
          />
        }
      />
      <SettingsRow
        label="Start preview automatically"
        description="Let the agent start the live-preview dev server without asking you first."
        control={
          <Toggle
            checked={previewAutoStart ?? true}
            onChange={toggleAutoStart}
            label="Start preview automatically"
          />
        }
      />
    </SettingsSection>
  )
}

/**
 * Browser testing (optional Playwright capability). Turning it on persists the toggle AND kicks a
 * one-time ~150 MB Chromium download into a shared dir (every project reuses it); the agent only gets
 * browser tools once it's `ready`. Download progress streams in over `playwright:progress`. Default-off.
 */
export function BrowserTestingRow() {
  const { pw, toggle } = useBrowserTesting()

  return (
    <SettingsRow
      label="Browser testing"
      description="Let the agent open a real browser and click through your work to confirm it behaves."
      control={<Toggle checked={pw?.enabled ?? false} onChange={toggle} label="Browser testing" />}
    >
      {pw?.enabled && <BrowserTestingStatus status={pw} />}
    </SettingsRow>
  )
}

function BrowserTestingStatus({ status }: { status: PlaywrightStatus }) {
  const { state, message } = status
  const text =
    state === 'ready'
      ? 'Ready. The agent can test in a browser.'
      : state === 'installing'
        ? (message ?? 'Downloading the browser…')
        : state === 'error'
          ? "Couldn't download the browser. Switch off and on to try again."
          : 'Preparing…'
  const tone =
    state === 'ready' ? 'text-emerald-500' : state === 'error' ? 'text-red-500' : 'text-text-muted'
  // Anything not settled (ready) or failed (error) is in flight — installing or still preparing.
  if (state !== 'ready' && state !== 'error')
    return <BusyText className={`text-[12.5px] ${tone}`}>{text}</BusyText>
  return <span className={`block text-[12.5px] ${tone}`}>{text}</span>
}

/** One provisionable runtime row (Node / Python) — owns its status + progress, tracks only its own
 *  runtime's progress events. The control offers Set up / Update, or shows the ✓ system/installed state. */
export function RuntimeRow({
  runtime,
  label,
  description,
}: {
  runtime: RuntimeId
  label: string
  description: string
}) {
  const { status, progress, installing, error, install } = useRuntime(runtime)
  const name = label.replace(/ runtime$/i, '')

  return (
    <SettingsRow
      label={label}
      description={description}
      control={<RuntimeControl status={status} installing={installing} onInstall={install} />}
    >
      {installing && progress && (
        <div className="space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-base"
              style={{ width: `${Math.round((progress.progress ?? (progress.phase === 'download' ? 0 : 1)) * 100)}%` }}
            />
          </div>
          <p className="text-[12px] text-text-muted">{progress.message}</p>
        </div>
      )}
      {error && <p className="text-[12px] text-red-500">Couldn't set up {name}: {error}</p>}
    </SettingsRow>
  )
}

function RuntimeControl({
  status,
  installing,
  onInstall,
}: {
  status: RuntimeStatus | null
  installing: boolean
  onInstall: () => void
}) {
  if (!status) return null
  if (installing) return <BusyText className="text-[13px] text-text-muted">Setting up…</BusyText>
  if (status.state === 'system')
    return <span className="text-[13px] text-text-muted">Already on your Mac ✓</span>
  if (status.state === 'installed')
    return <span className="text-[13px] text-text-muted">Installed ✓ (v{status.installedVersion})</span>

  const label = status.state === 'stale' ? 'Update' : 'Set up'
  return (
    <button
      onClick={onInstall}
      className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent/90"
    >
      {label}
    </button>
  )
}
