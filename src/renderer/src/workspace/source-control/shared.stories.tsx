import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { GitStatusFile } from '@shared/ipc'
import { Section, FileButton, StatusGlyph } from './shared'

// Source Control's small reused pieces — section chrome, a file row, and its status glyph. Gathered
// in one gallery since none of them is a standalone screen.
const meta = {
  title: 'Source Control/Shared pieces',
  parameters: { controls: { disable: true } },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const SectionChrome: Story = {
  render: () => (
    <div className="max-w-sm rounded-lg border border-border bg-bg">
      <Section label="Changes" count={3}>
        <p className="px-3 py-1.5 text-xs text-text-muted">3 files changed since your last version.</p>
      </Section>
      <Section label="History">
        <p className="px-3 py-1.5 text-xs text-text-muted">12 versions saved.</p>
      </Section>
    </div>
  ),
}

const FILES: GitStatusFile[] = [
  { path: 'src/renderer/src/settings/controls.tsx', status: 'modified' },
  { path: 'src/renderer/src/settings/icons.tsx', status: 'added' },
  { path: 'src/renderer/src/workspace/source-control/shared.tsx', status: 'renamed' },
  { path: 'CHANGELOG.md', status: 'untracked' },
  { path: 'src/main/engine/env.ts', status: 'deleted' },
]

// Interactive — clicking a row sets it active, exercising FileButton's own local hover/menu state.
function FileButtonDemo() {
  const [activePath, setActivePath] = useState(FILES[0].path)
  return (
    <ul className="flex max-w-sm flex-col gap-0.5 px-1.5">
      {FILES.map((f) => (
        <li key={f.path}>
          <FileButton
            file={f}
            active={f.path === activePath}
            onClick={() => setActivePath(f.path)}
            title={`See what changed in ${f.path}`}
            onOpen={() => {}}
            onReveal={() => {}}
            onDiscard={async () => null}
          />
        </li>
      ))}
    </ul>
  )
}

export const FileRow: Story = {
  render: () => <FileButtonDemo />,
}

export const StatusGlyphs: Story = {
  render: () => (
    <div className="flex items-center gap-4 text-[13px] text-text">
      {(['modified', 'added', 'deleted', 'renamed', 'untracked', 'other'] as const).map((status) => (
        <div key={status} className="flex items-center gap-1.5">
          <StatusGlyph status={status} />
          <span className="text-text-muted">{status}</span>
        </div>
      ))}
    </div>
  ),
}
