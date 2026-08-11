import type { Meta, StoryObj } from '@storybook/react-vite'
import { Transcript } from './Transcript'
import type { Entry } from './types'

/**
 * The full turn-item assembly: a user message opens a turn, plumbing (thinking + tool calls) collapses
 * into an inset "well", prose/tasklist/subagent/question items each get their own container. Built as a
 * realistic "add search to the docs sidebar" conversation covering every turn-item kind at once.
 */
const items: Entry[] = [
  { id: 1, kind: 'user', text: 'Add a search bar to the docs sidebar, and let me filter by tag while I\'m at it.' },
  { id: 2, kind: 'thinking', estimatedTokens: 240, active: false },
  {
    id: 3,
    kind: 'tool',
    toolUseId: 'tu_1',
    name: 'Read',
    input: { file_path: 'src/renderer/src/docs/DocsBrowser.tsx' },
    result: 'import { useState } from \'react\'\n…182 lines',
  },
  {
    id: 4,
    kind: 'tool',
    toolUseId: 'tu_2',
    name: 'Grep',
    input: { pattern: 'tags:', path: 'src/renderer/src/docs' },
    result: 'No matches — tags aren\'t modeled yet.',
  },
  {
    id: 5,
    kind: 'assistant',
    markdown:
      'Docs don\'t have tags yet, so I\'ll add a lightweight `tags:` frontmatter field, a search input above the list, and a filter row of chips. Here\'s the plan:',
  },
  {
    id: 6,
    kind: 'tasklist',
    tasks: [
      { id: 't1', subject: 'Parse `tags:` frontmatter in the doc list', status: 'completed' },
      { id: 't2', subject: 'Add the search input + live filtering', status: 'completed' },
      { id: 't3', subject: 'Add the tag chip row', status: 'in_progress' },
      { id: 't4', subject: 'Verify with a few real docs', status: 'pending' },
    ],
  },
  {
    id: 7,
    kind: 'tool',
    toolUseId: 'tu_3',
    name: 'Edit',
    input: { file_path: 'src/renderer/src/docs/DocsBrowser.tsx', old_string: 'const [docs, setDocs]', new_string: 'const [query, setQuery] = useState(\'\')\n  const [docs, setDocs]' },
    result: 'Applied.',
  },
  {
    id: 8,
    kind: 'tool',
    toolUseId: 'tu_4',
    name: 'Bash',
    input: { command: 'npm run typecheck' },
    result: '> koda@0.1.9 typecheck\n> tsc --noEmit\n\n(clean)',
  },
  {
    id: 9,
    kind: 'subagent',
    toolUseId: 'tu_5',
    subagentType: 'code-reviewer',
    description: 'Review the docs search + tag filter change',
    status: 'completed',
    usage: { totalTokens: 9820, durationMs: 6100 },
    children: [
      {
        id: 1,
        kind: 'tool',
        toolUseId: 'tu_6',
        name: 'Read',
        input: { file_path: 'src/renderer/src/docs/DocsBrowser.tsx' },
        result: '…214 lines',
      },
    ],
    resultText: 'Looks solid. One nit: the tag chip row should collapse to a scroller past ~6 tags.',
  },
  {
    id: 10,
    kind: 'assistant',
    markdown:
      'Search and tag filtering are wired up, and I tightened the chip row per the review. One thing I want your call on before I move the filter into the sidebar footer:',
  },
  {
    id: 11,
    kind: 'tool',
    toolUseId: 'tu_7',
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Should the tag chip row scroll or wrap onto a second line past 6 tags?',
          header: 'Overflow',
          options: [
            { label: 'Horizontal scroll', description: 'Keeps the sidebar height fixed' },
            { label: 'Wrap to a second line', description: 'Every tag stays visible at once' },
          ],
        },
      ],
    },
  },
]

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-[640px] w-[560px] overflow-y-auto rounded-lg border border-border bg-bg px-4 pb-10 pt-2">
      {children}
    </div>
  )
}

const meta = {
  title: 'Transcript/Transcript',
  component: Transcript,
  args: { items, streaming: '', working: null },
  parameters: { controls: { disable: true } },
  decorators: [(Story) => <Frame><Story /></Frame>],
} satisfies Meta<typeof Transcript>

export default meta
type Story = StoryObj<typeof meta>

/** A finished turn: pinned user header, a thinking+tool well, prose, a task list, a subagent card,
 *  more prose, then an open question waiting on the user. */
export const FullTurn: Story = {}

/** The agent is still streaming its reply — partial markdown renders live through the same Markdown
 *  path as a finished block, with a blinking caret at the tail. */
export const Streaming: Story = {
  args: {
    items: items.slice(0, 6),
    streaming: 'Now adding the tag chip row. It reads every unique `tags:` value across the docs and',
  },
}

/** Between actions with nothing to show yet — the trailing working indicator ("Running a command…")
 *  is the only sign the turn is still alive. */
export const Working: Story = {
  args: {
    items: items.slice(0, 4),
    working: 'Running a command',
  },
}

/** A single short turn — the common case, no well, no extra containers. */
export const ShortTurn: Story = {
  args: {
    items: [
      { id: 1, kind: 'user', text: 'What port does the dev server run on?' },
      { id: 2, kind: 'assistant', markdown: 'Port `5173` — Vite\'s default. The Electron main process picks it up from `electron.vite.config.ts`.' },
    ],
  },
}
