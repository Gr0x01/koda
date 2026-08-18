import { useEffect, useState } from 'react'
import type { ImageDetail, KodaSettings, TextGenerationModel } from '@shared/ipc'
import { setNotifyEnabled } from '../workspace/store'
import { SegmentedControl, SettingsRow, SettingsSection, Toggle } from './controls'
import { GeneratedTextControl } from './GeneratedTextControl'

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
  const [suggestVersionMessage, setSuggestVersionMessage] = useState<boolean | null>(null)
  const [generatedTextModel, setGeneratedTextModel] = useState<TextGenerationModel | null>(null)
  const [imageDetail, setImageDetail] = useState<ImageDetail | null>(null)
  const [retentionDays, setRetentionDays] = useState<number | null>(null)

  useEffect(() => {
    let mounted = true
    const sync = (s: KodaSettings): void => {
      if (!mounted) return
      setNotifications(s.notificationsEnabled)
      setUsageResetNotify(s.usageResetNotify)
      setProviderStatusNotify(s.providerStatusNotify)
      setDaySessions(s.appDaySessions)
      setCritiquePass(s.critiquePass)
      setSuggestVersionMessage(s.suggestVersionMessage)
      setGeneratedTextModel(s.textGenerationModel)
      setImageDetail(s.imageDetail)
      setRetentionDays(s.scratchRetentionDays)
    }
    const unsubscribe = window.koda.onSettingsChanged(sync)
    window.koda.getSettings().then(sync).catch(console.error)
    return () => {
      mounted = false
      unsubscribe()
    }
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

  const toggleSuggestVersionMessage = (next: boolean): void => {
    setSuggestVersionMessage(next)
    window.koda.updateSettings({ suggestVersionMessage: next }).catch(console.error) // read live at the next save
  }

  const saveGeneratedTextModel = (model: TextGenerationModel): void => {
    setGeneratedTextModel(model)
    // The returned value is the persisted authority. A failed disk write returns the prior choice,
    // and the global settings broadcast keeps every other open window on this same value.
    window.koda
      .updateSettings({ textGenerationModel: model })
      .then((settings) => setGeneratedTextModel(settings.textGenerationModel))
      .catch(console.error)
  }

  const changeImageDetail = (next: ImageDetail): void => {
    setImageDetail(next)
    window.koda.updateSettings({ imageDetail: next }).catch(console.error) // applies on the next paste
  }

  const changeRetention = (next: string): void => {
    const days = Number(next)
    setRetentionDays(days)
    // Main prunes every open project before this save resolves; closed projects prune on next open.
    window.koda.updateSettings({ scratchRetentionDays: days }).catch(console.error)
  }

  return (
    <>
      <SettingsSection
        title="Notifications"
        note="The in-app marker and the dock badge appear whatever these are set to."
      >
        <SettingsRow
          label="Background session alerts"
          description="Get a Mac notification when a session you are not watching finishes, fails, or needs an approval."
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
          description="Get a notification the moment a 5-hour limit you actually maxed out resets."
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
          description="Get a notification when a confirmed Claude or Codex outage that interrupted you clears."
          control={
            <Toggle
              checked={providerStatusNotify ?? true}
              onChange={toggleProviderStatusNotify}
              label="Provider back up"
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Apps"
        note="Off keeps one running conversation per app instead."
      >
        <SettingsRow
          label="A new conversation each day"
          description="Start a fresh conversation named for the day each time you use an app's ask-or-fix line, so a month of logging reads as a month of dated chats."
          control={
            <Toggle
              checked={daySessions ?? true}
              onChange={toggleDaySessions}
              label="A new conversation each day"
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Finishing work"
        note="Verification still runs without this. Turn it on when you want a second agent for medium- or high-risk work or a finished artifact with a real quality bar."
      >
        <SettingsRow
          label="Check the work before calling it done"
          description="Use one bounded fresh review when the work warrants the extra time and usage; ask for Deep Review explicitly."
          control={
            <Toggle
              checked={critiquePass ?? false}
              onChange={toggleCritiquePass}
              label="Check the work before calling it done"
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Generated text"
        note="Apple Intelligence stays on this Mac. Claude and Codex use the account configured in AI providers for short, ephemeral turns that run outside the project and cannot modify it."
      >
        <SettingsRow
          label="Text generation model"
          description="Choose what writes session names and suggested saved-version descriptions."
          control={
            <GeneratedTextControl
              value={generatedTextModel ?? { provider: 'apple' }}
              onChange={saveGeneratedTextModel}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Saving versions"
        note="The text-generation model above writes the suggestion, and you can edit it before you save. Plain local text writes a simple local summary and spends nothing."
      >
        <SettingsRow
          label="Describe a version for me"
          description="Fill the save box with a description of what actually changed instead of an empty field."
          control={
            <Toggle
              checked={suggestVersionMessage ?? true}
              onChange={toggleSuggestVersionMessage}
              label="Describe a version for me"
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Images"
        note="Balanced keeps a screenshot readable for a fraction of the tokens. Raise it for tiny text, lower it to save the most."
      >
        <SettingsRow
          label="Detail when sending images"
          description="How much detail survives when a pasted image is shrunk on its way to the agent, since bigger images cost more tokens."
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
          description="How long the copy of each image you send is kept in the project for the agent to refer back to."
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
    <SettingsSection
      title="Privacy"
      note="It never includes your files, chats, file names, or project names. Off sends nothing at all."
    >
      <SettingsRow
        label="Help improve Koda"
        description="Send counts of which features get used and which errors happen, tied to a random id."
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
    <SettingsSection
      title="Recovery labels"
      note="It runs entirely on your Mac, and falls back to a plain default when the model is unavailable."
    >
      <SettingsRow
        label="Smart recovery labels"
        description="Use Apple's on-device model (macOS 26 and later) to describe recovery points in plain language."
        control={
          <Toggle checked={enabled ?? true} onChange={toggle} label="Smart recovery labels" />
        }
      />
    </SettingsSection>
  )
}
