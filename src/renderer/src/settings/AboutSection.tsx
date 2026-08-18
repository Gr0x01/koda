import { useEffect, useState, type ReactNode } from 'react'
import type { AppInfo, EngineProbe, UpdateStatus } from '@shared/ipc'
import { useWorkspace } from '../workspace/store'
import { Button, BusyText } from '../ui'
import { SettingsRow, SettingsSection } from './controls'

export function AboutSection() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [engine, setEngine] = useState<EngineProbe | null>(null)

  useEffect(() => {
    window.koda.getAppInfo().then(setInfo).catch(console.error)
    window.koda.probeEngine().then(setEngine).catch(console.error)
  }, [])

  return (
    <SettingsSection
      title="About"
      note="What this build is made of, and where its logs live when something goes wrong."
    >
      <SettingsRow label="Koda" control={<Mono>{info ? `v${info.appVersion}` : '…'}</Mono>} />
      <SettingsRow
        label="Engine"
        description="The bundled Claude Code build that runs every session."
        control={<Mono>{engine ? `${engine.version} · ${engine.source}` : '…'}</Mono>}
      />
      <SettingsRow
        label="Electron"
        description="The runtime Koda's window is drawn on."
        control={<Mono>{info ? info.electron : '…'}</Mono>}
      />
      <UpdatesRow />
      <SettingsRow
        label="Logs"
        description="One diagnostic log per launch, worth attaching when you report a bug."
        control={<Mono>~/Library/Logs/Koda</Mono>}
      />
    </SettingsSection>
  )
}

/**
 * Update status + the manual "Check". The state is driven by the main-process autoUpdater (updater.ts):
 * we seed from getUpdateStatus() and follow the live push. Updates only apply to installed builds, so
 * in dev this shows a muted note instead of a dead button.
 */
function UpdatesRow() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    window.koda.getUpdateStatus().then(setStatus).catch(console.error)
    return window.koda.onUpdateStatus(setStatus)
  }, [])

  if (import.meta.env.DEV) {
    return (
      <SettingsRow
        label="Updates"
        description="Installed builds check for new versions on their own, so this dev build has nothing to check."
        control={<Mono>dev build</Mono>}
      />
    )
  }

  const busy = status.state === 'checking'
  const description =
    status.state === 'ready'
      ? `Version ${status.version} is downloaded and installs when you restart.`
      : status.state === 'downloading'
        ? undefined
        : status.state === 'error'
          ? "Koda couldn't check for updates just now and will try again on its own."
          : status.state === 'up-to-date'
            ? "You're on the latest version."
            : 'Koda checks for new versions on its own and downloads them in the background.'

  return (
    <SettingsRow
      label="Updates"
      description={description}
      control={
        status.state === 'ready' ? (
          <Button variant="primary" onClick={() => void window.koda.quitAndInstallUpdate()}>
            Restart to update
          </Button>
        ) : status.state === 'downloading' ? (
          <BusyText size={11} className="text-[12.5px] text-text-muted">
            Downloading… {status.percent}%
          </BusyText>
        ) : busy ? (
          <BusyText size={11} className="text-[12.5px] text-text-muted">
            Checking…
          </BusyText>
        ) : (
          <Button variant="secondary" onClick={() => void window.koda.checkForUpdates()}>
            Check for updates
          </Button>
        )
      }
    />
  )
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[12px] text-text-muted">{children}</span>
}

/**
 * DEV-only retest panel (gated out of packaged builds in CATEGORIES). Re-trigger the onboarding flows
 * without hand-editing koda-settings.json: replay the first-run wizard, re-offer per-project intake, or
 * wipe all settings. Not a user-facing feature.
 */
export function DeveloperSection() {
  const resetIntake = useWorkspace((s) => s.resetIntake)
  const setSettingsOpen = useWorkspace((s) => s.setSettingsOpen)
  const [intakeNote, setIntakeNote] = useState<string | null>(null)

  const replayWizard = async () => {
    await window.koda.updateSettings({ hasOnboarded: false })
    window.location.reload() // App re-reads hasOnboarded on mount → shows the wizard
  }

  const reOfferIntake = async () => {
    const r = await resetIntake()
    if (r === 'offered') {
      setSettingsOpen(false) // reveal the intake screen sitting behind Settings
      return
    }
    setIntakeNote(
      r === 'no-project'
        ? 'No project is open.'
        : 'This project has sessions or guidelines already, so open a fresh folder to see intake.',
    )
  }

  const resetAll = async () => {
    await window.koda.resetSettings()
    window.location.reload()
  }

  return (
    <SettingsSection
      title="Developer"
      note="Dev-build only, for retesting the onboarding flows without hand-editing settings."
    >
      <SettingsRow
        label="Replay onboarding"
        description="Show the first-run wizard again, with sign-in and installed tools already marked done."
        control={<Button variant="secondary" onClick={replayWizard}>Replay</Button>}
      />
      <SettingsRow
        label="Re-offer project setup"
        description={intakeNote ?? "Clear this project's intake dismissal so the offer runs again."}
        control={<Button variant="secondary" onClick={reOfferIntake}>Reset</Button>}
      />
      <SettingsRow
        label="Reset all settings"
        description="Wipe every preference back to its default and reload the window, onboarding included."
        control={<Button variant="secondary" onClick={resetAll}>Reset all</Button>}
      />
    </SettingsSection>
  )
}
