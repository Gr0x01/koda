import { useEffect, useState } from 'react'
import type { ImageDetail } from '@shared/ipc'
import { setNotifyEnabled } from '../workspace/store'
import { SegmentedControl, SettingsRow, SettingsSection, Toggle } from './controls'

// Bigger images cost more tokens (cost tracks pixel area), so the composer downscales pasted/dropped
// images to this level's pixel cap before sending. Balanced is the default.
const IMAGE_DETAIL_OPTIONS: { value: ImageDetail; label: string; title: string }[] = [
  { value: 'high', label: 'High detail', title: 'Keeps fine text and small UI crisp. Largest size, most tokens.' },
  { value: 'balanced', label: 'Balanced', title: 'Readable screenshots at a fraction of the tokens' },
  { value: 'max', label: 'Max savings', title: 'Smallest size, fewest tokens. May blur dense text.' },
]

// Saved images auto-prune after this many days; '0' = keep forever. SegmentedControl is string-only,
// so the day counts are strings here and converted to numbers when persisted.
const RETENTION_OPTIONS: { value: string; label: string; title: string }[] = [
  { value: '1', label: '1 day', title: 'Clear saved images after a day' },
  { value: '7', label: '7 days', title: 'Clear saved images after a week' },
  { value: '30', label: '30 days', title: 'Clear saved images after a month' },
  { value: '0', label: 'Forever', title: "Never auto-deleted. You'll manage them yourself." },
]

export function GeneralSection() {
  const [notifications, setNotifications] = useState<boolean | null>(null)
  const [usageResetNotify, setUsageResetNotify] = useState<boolean | null>(null)
  const [providerStatusNotify, setProviderStatusNotify] = useState<boolean | null>(null)
  const [daySessions, setDaySessions] = useState<boolean | null>(null)
  const [critiquePass, setCritiquePass] = useState<boolean | null>(null)
  const [imageDetail, setImageDetail] = useState<ImageDetail | null>(null)
  const [retentionDays, setRetentionDays] = useState<number | null>(null)

  useEffect(() => {
    window.koda
      .getSettings()
      .then((s) => {
        setNotifications(s.notificationsEnabled)
        setUsageResetNotify(s.usageResetNotify)
        setProviderStatusNotify(s.providerStatusNotify)
        setDaySessions(s.appDaySessions)
        setCritiquePass(s.critiquePass)
        setImageDetail(s.imageDetail)
        setRetentionDays(s.scratchRetentionDays)
      })
      .catch(console.error)
  }, [])

  const toggleNotifications = (next: boolean): void => {
    setNotifications(next)
    setNotifyEnabled(next) // live gate, no restart
    window.koda.updateSettings({ notificationsEnabled: next }).catch(console.error)
  }

  const toggleUsageResetNotify = (next: boolean): void => {
    setUsageResetNotify(next)
    window.koda.updateSettings({ usageResetNotify: next }).catch(console.error) // main reads it live
  }

  const toggleProviderStatusNotify = (next: boolean): void => {
    setProviderStatusNotify(next)
    window.koda.updateSettings({ providerStatusNotify: next }).catch(console.error) // main reads it live
  }

  const toggleDaySessions = (next: boolean): void => {
    setDaySessions(next)
    window.koda.updateSettings({ appDaySessions: next }).catch(console.error) // both heads read it live
  }

  const toggleCritiquePass = (next: boolean): void => {
    setCritiquePass(next)
    window.koda.updateSettings({ critiquePass: next }).catch(console.error) // applies to the next session
  }

  const changeImageDetail = (next: ImageDetail): void => {
    setImageDetail(next)
    window.koda.updateSettings({ imageDetail: next }).catch(console.error) // applies on the next paste
  }

  const changeRetention = (next: string): void => {
    const days = Number(next)
    setRetentionDays(days)
    window.koda.updateSettings({ scratchRetentionDays: days }).catch(console.error) // applies on the next save
  }

  return (
    <>
      <SettingsSection title="Notifications">
        <SettingsRow
          label="Background session alerts"
          description="Show a system notification when a session you're not watching finishes, errors, or needs your approval. The in-app marker and dock badge always appear."
          control={
            <Toggle
              checked={notifications ?? true}
              onChange={toggleNotifications}
              label="Background session alerts"
            />
          }
        />
        <SettingsRow
          label="Usage limit reset"
          description="When you hit your 5-hour usage limit, get a notification the moment it resets so you know you can pick back up. Only fires for windows you actually maxed out, never every window."
          control={
            <Toggle
              checked={usageResetNotify ?? true}
              onChange={toggleUsageResetNotify}
              label="Usage limit reset"
            />
          }
        />
        <SettingsRow
          label="Provider back up"
          description="When Claude or Codex goes down mid-turn (a confirmed outage on their end), get a notification the moment their status page turns green again. With a paired phone, the ping reaches you even if your Mac is asleep."
          control={
            <Toggle
              checked={providerStatusNotify ?? true}
              onChange={toggleProviderStatusNotify}
              label="Provider back up"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Apps">
        <SettingsRow
          label="A new conversation each day"
          description="What you say to an app's ask-or-fix line starts a fresh conversation each day, named for that day — so a month of logging is a month of dated chats you can look back through, instead of one endless thread. Turn it off to keep a single running conversation per app."
          control={
            <Toggle
              checked={daySessions ?? true}
              onChange={toggleDaySessions}
              label="A new conversation each day"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Finishing work">
        <SettingsRow
          label="Check the work before calling it done"
          description="Nothing substantial gets finished on the builder's own say-so. Something you'll actually look at — a screen, a page, a document — is opened by a second agent that didn't build it and compared against the standard agreed on up front; a finished feature gets its change read for real problems and checked against the rest of the project for duplicate paths and competing owners. Either way the biggest thing it finds gets fixed, and you never have to ask. Small fixes and routine edits skip it. Adds a few minutes and a bit more of your usage window each time — turn it off when you'd rather spend that on building."
          control={
            <Toggle
              checked={critiquePass ?? true}
              onChange={toggleCritiquePass}
              label="Check the work before calling it done"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Images">
        <SettingsRow
          label="Detail when sending images"
          description="Pasted or dropped images are shrunk before they go to the agent. Bigger images cost more tokens. Balanced keeps screenshots readable for a fraction of the cost; raise it for tiny text, lower it to save the most."
          control={
            <SegmentedControl
              ariaLabel="Image detail"
              value={imageDetail ?? 'balanced'}
              options={IMAGE_DETAIL_OPTIONS}
              onChange={changeImageDetail}
            />
          }
        />
        <SettingsRow
          label="Keep saved images for"
          description="Every image you send is also saved in the project so the agent can refer back to it later. Koda clears these automatically after this long."
          control={
            <SegmentedControl
              ariaLabel="Keep saved images for"
              value={String(retentionDays ?? 7)}
              options={RETENTION_OPTIONS}
              onChange={changeRetention}
            />
          }
        />
      </SettingsSection>

      <AssistSection />
      <PrivacySection />
    </>
  )
}

function PrivacySection() {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    window.koda.getSettings().then((s) => setEnabled(s.telemetryEnabled)).catch(console.error)
  }, [])

  const toggle = (next: boolean): void => {
    setEnabled(next)
    window.koda.updateSettings({ telemetryEnabled: next }).catch(console.error) // main reads it live
  }

  return (
    <SettingsSection title="Privacy">
      <SettingsRow
        label="Help improve Koda"
        description="Sends counts of which features get used and which errors happen, tied to a random id. It never includes your files, chats, file names, or project names, so we could not see your work even if we wanted to. Turn it off and nothing is sent at all."
        control={<Toggle checked={enabled ?? true} onChange={toggle} label="Help improve Koda" />}
      />
    </SettingsSection>
  )
}

function AssistSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    window.koda.getSettings().then((s) => setEnabled(s.assistEnabled)).catch(console.error)
  }, [])

  const toggle = (next: boolean): void => {
    setEnabled(next)
    window.koda.updateSettings({ assistEnabled: next }).catch(console.error)
  }

  return (
    <SettingsSection title="On-device assist">
      <SettingsRow
        label="Smart names & labels"
        description="Use Apple's on-device model (macOS 26+) to write clean session names and plain-language recovery labels. Runs entirely on your Mac, nothing leaves the machine. Falls back to a simple default when unavailable."
        control={
          <Toggle checked={enabled ?? true} onChange={toggle} label="On-device assist" />
        }
      />
    </SettingsSection>
  )
}
