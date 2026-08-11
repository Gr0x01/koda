import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import type { SearchResult } from '@shared/ipc'
import { SearchOverlay } from './SearchOverlay'
import { useWorkspace } from './store'

const RESULT: SearchResult = {
  query: 'compose',
  truncated: false,
  files: [
    {
      path: '/Users/rb/Documents/coding_projects/koda/src/renderer/src/surface/conversation/Composer.tsx',
      rel: 'src/renderer/src/surface/conversation/Composer.tsx',
      name: 'Composer.tsx',
      nameMatch: true,
      score: 96,
      matches: [
        { line: 42, preview: 'function useComposeState() {' },
        { line: 118, preview: '  const composerRef = useRef<HTMLTextAreaElement>(null)' },
      ],
    },
    {
      path: '/Users/rb/Documents/coding_projects/koda/src/renderer/src/surface/conversation/ComposerError.tsx',
      rel: 'src/renderer/src/surface/conversation/ComposerError.tsx',
      name: 'ComposerError.tsx',
      nameMatch: true,
      score: 88,
      matches: [],
    },
    {
      path: '/Users/rb/Documents/coding_projects/koda/Documents/design/audits/composer-audit.md',
      rel: 'Documents/design/audits/composer-audit.md',
      name: 'composer-audit.md',
      nameMatch: false,
      score: 0,
      matches: [{ line: 12, preview: 'The compose box should stay pinned while the transcript scrolls.' }],
    },
  ],
}

function withSearchFixture(result: SearchResult) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
      search: result,
      replaceAll: { files: result.files.length, replacements: result.files.reduce((n, f) => n + f.matches.length, 0) },
    }
    return <Story />
  }
}

/** Resets the overlay's own store slice — quick-open reads `recentFiles` + the active editor's open
 *  tabs, so a previous story's leftovers shouldn't bleed into the next. */
function withSearchState(partial: Partial<ReturnType<typeof useWorkspace.getState>>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({
      recentFiles: [],
      editors: {},
      activeId: null,
      searchOpen: true,
      ...partial,
    })
    return <Story />
  }
}

const meta = {
  title: 'Workspace/SearchOverlay',
  component: SearchOverlay,
  decorators: [withSearchFixture(RESULT), withSearchState({})],
} satisfies Meta<typeof SearchOverlay>

export default meta
type Story = StoryObj<typeof meta>

/** Empty query — quick-open: recent + currently-open files, jump straight to one. */
export const QuickOpen: Story = {
  decorators: [
    withSearchState({
      recentFiles: [
        '/Users/rb/Documents/coding_projects/koda/src/renderer/src/workspace/Sidebar.tsx',
        '/Users/rb/Documents/coding_projects/koda/CLAUDE.md',
        '/Users/rb/Documents/coding_projects/koda/Documents/release/ship-checklist-iphone.md',
      ],
    }),
  ],
}

/** Nothing recent yet and no tabs open — the plain "search names + contents" hint. */
export const QuickOpenEmpty: Story = {}

/** A typed query with real results — FILES (ranked name matches) then IN FILES (per-line hits),
 *  the query highlighted in each preview. */
export const WithResults: Story = {
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByPlaceholderText('Find in this project'), 'compose')
    // "Composer.tsx" itself renders 3x (its own FILES row + 2 IN FILES line rows) — assert on
    // ComposerError.tsx instead, which has no line matches and so is unambiguous.
    await waitFor(() => expect(canvas.getByText('ComposerError.tsx')).toBeInTheDocument())
  },
}

/** Replace mode open on top of a typed query — a single "Replace all" step, checkpointed + undoable. */
export const ReplaceMode: Story = {
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByPlaceholderText('Find in this project'), 'compose')
    await waitFor(() => expect(canvas.getByText('ComposerError.tsx')).toBeInTheDocument())
    await userEvent.click(canvas.getByTitle('Replace'))
    await userEvent.type(canvas.getByPlaceholderText('Replace with…'), 'compose box')
  },
}

/** No matches for the typed query. */
export const NoResults: Story = {
  parameters: { controls: { disable: true } },
  decorators: [withSearchFixture({ query: 'zzz', truncated: false, files: [] })],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByPlaceholderText('Find in this project'), 'zzz')
    await waitFor(() => expect(canvas.getByText('No matches for “zzz”.')).toBeInTheDocument())
  },
}
