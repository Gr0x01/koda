import { useWorkspace } from '../workspace/store'
import { useTheme, type ThemePreference } from '../theme'
import { useTextSize, type TextSize } from '../text-size'
import { Button } from '../ui'
import { SegmentedControl, SettingsRow, SettingsSection, ThemeSelect } from './controls'
import { themesForMode } from '../themes'

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

// Scales the reading text in the conversation and documents. The session runs tighter than docs by
// design; this shifts both together. Default is the tuned baseline.
const TEXT_SIZE_OPTIONS: { value: TextSize; label: string; title: string }[] = [
  { value: 'compact', label: 'Compact', title: 'Denser, fits more on screen' },
  { value: 'medium', label: 'Default', title: 'The tuned baseline' },
  { value: 'comfortable', label: 'Comfortable', title: 'Larger, easier on the eyes' },
]

export function AppearanceSection() {
  const { preference, setPreference, lightTheme, darkTheme, setLightTheme, setDarkTheme } = useTheme()
  const { size, setSize } = useTextSize()
  const resetLayout = useWorkspace((s) => s.resetLayout)
  return (
    <>
      <SettingsSection title="Theme">
        <SettingsRow
          label="Appearance"
          description="Light, dark, or follow your Mac's system setting."
          control={
            <SegmentedControl
              ariaLabel="Theme"
              value={preference}
              options={THEME_OPTIONS}
              onChange={setPreference}
            />
          }
        />
        <SettingsRow
          label="Light theme"
          description="The pack used in light mode."
          control={
            <ThemeSelect
              ariaLabel="Light theme"
              value={lightTheme}
              options={themesForMode('light')}
              onChange={setLightTheme}
            />
          }
        />
        <SettingsRow
          label="Dark theme"
          description="The pack used in dark mode."
          control={
            <ThemeSelect
              ariaLabel="Dark theme"
              value={darkTheme}
              options={themesForMode('dark')}
              onChange={setDarkTheme}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Text size">
        <SettingsRow
          label="Reading text size"
          description="Scales the text in conversations and documents. The conversation stays a touch denser than documents by design."
          control={
            <SegmentedControl
              ariaLabel="Text size"
              value={size}
              options={TEXT_SIZE_OPTIONS}
              onChange={setSize}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Layout">
        <SettingsRow
          label="Reset to default layout"
          description="Restore the sidebar, the Sessions/Files split, and the conversation and preview panes to their default sizes."
          control={<Button variant="secondary" onClick={resetLayout}>Reset</Button>}
        />
      </SettingsSection>
    </>
  )
}
