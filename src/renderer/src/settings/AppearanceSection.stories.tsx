import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { AppearanceSection } from './AppearanceSection'
import { ThemeProvider } from '../theme'
import { TextSizeProvider } from '../text-size'

// Appearance reads/writes through useTheme + useTextSize (renderer-only localStorage contexts, no
// bridge round-trip — see theme.tsx/text-size.tsx), so it needs their real providers, not a mock.
function withProviders(Story: React.ComponentType): React.ReactElement {
  return (
    <ThemeProvider>
      <TextSizeProvider>
        <div className="max-w-2xl space-y-8">
          <Story />
        </div>
      </TextSizeProvider>
    </ThemeProvider>
  )
}

const meta = {
  title: 'Settings/Appearance',
  component: AppearanceSection,
  decorators: [withProviders],
} satisfies Meta<typeof AppearanceSection>

export default meta
type Story = StoryObj<typeof meta>

/** Theme mode, the paired light/dark pack pickers, reading text size, and the layout reset — all
 *  live browser state (localStorage), so every control here genuinely flips when clicked. */
export const Default: Story = {}

/** The light-theme picker portals its menu to `document.body` (escapes the card's overflow) — opening
 *  it proves the pack list + live sample render, not just that the trigger button paints. */
export const ThemePickerOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByLabelText('Light theme'))
    await waitFor(() => expect(within(document.body).getAllByRole('option').length).toBeGreaterThan(0))
  },
}
