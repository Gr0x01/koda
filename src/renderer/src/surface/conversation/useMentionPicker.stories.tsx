import { useEffect, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMentionPicker } from './useMentionPicker'

/**
 * useMentionPicker is a hook, not a component — it returns the popover's JSX (`menu`) plus the
 * keyboard/typing wiring the composer's textarea drives it with. This hosts it in a minimal stand-in
 * textarea (the composer's real one, minus the attach/send chrome) so the popover itself is storyable.
 */
const DOCS = [
  { path: '/proj/Documents/release/ship-checklist-iphone.md', rel: 'Documents/release/ship-checklist-iphone.md', name: 'ship-checklist-iphone.md', mtimeMs: Date.now() - 2 * 3_600_000 },
  { path: '/proj/Documents/design/storybook-status.md', rel: 'Documents/design/storybook-status.md', name: 'storybook-status.md', mtimeMs: Date.now() - 26 * 3_600_000 },
  { path: '/proj/Documents/site/koda-site-feature-inventory.md', rel: 'Documents/site/koda-site-feature-inventory.md', name: 'koda-site-feature-inventory.md', mtimeMs: Date.now() - 3 * 24 * 3_600_000 },
  { path: '/proj/Documents/guides/vibecoding-tips-plan.md', rel: 'Documents/guides/vibecoding-tips-plan.md', name: 'vibecoding-tips-plan.md', mtimeMs: Date.now() - 6 * 24 * 3_600_000 },
  { path: '/proj/Documents/release/ship-checklist-desktop.md', rel: 'Documents/release/ship-checklist-desktop.md', name: 'ship-checklist-desktop.md', mtimeMs: Date.now() - 12 * 24 * 3_600_000 },
]

const EXCERPTS: Record<string, string> = {
  '/proj/Documents/release/ship-checklist-iphone.md':
    '# Ship checklist — iPhone\nThe phone-tier launch gates: pairing, approvals, presence.',
  '/proj/Documents/design/storybook-status.md':
    '# Storybook status\nTier 3 in flight — store-seeded composites.',
  '/proj/Documents/site/koda-site-feature-inventory.md':
    '# Feature inventory\nThe source list for what koda-site can advertise.',
  '/proj/Documents/guides/vibecoding-tips-plan.md':
    '# Vibecoding tips — tracker\nThe published content series tracker.',
  '/proj/Documents/release/ship-checklist-desktop.md':
    '# Ship checklist — desktop\nThe Mac release gates.',
}

/** listDocs is keyed only by method name in the global mock, but readFile's excerpt needs to vary by
 *  the SELECTED doc's path — so this wraps window.koda in a local fall-through Proxy that inspects the
 *  call's argument (same pattern ModelControl.stories uses for per-arg fixtures). */
function withDocsFixtures() {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    const base = window.koda as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const overrides: Record<string, (...args: unknown[]) => Promise<unknown>> = {
      listDocs: () => Promise.resolve({ root: '/proj', docs: DOCS }),
      readFile: (args: unknown) => {
        const path = (args as { path: string }).path
        const content = EXCERPTS[path] ?? ''
        return Promise.resolve({ path, content, truncated: false, binary: false })
      },
    }
    window.koda = new Proxy(base, {
      get: (target, prop: string) => overrides[prop] ?? target[prop],
    }) as unknown as typeof window.koda
    return <Story />
  }
}

function MentionPickerHost({ draft: initialDraft }: { draft: string }) {
  const [draft, setDraftState] = useState(initialDraft)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const setDraft = (_id: string, text: string): void => setDraftState(text)
  const { menu, onKeyDown, sync } = useMentionPicker({ activeId: 's-1', draft, setDraft, textareaRef })

  // Open the picker on mount: drop the caret at the end of the typed `@query`, then run the same
  // detection the composer runs on every keystroke/caret move.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    sync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="relative w-[400px] rounded-2xl border border-border bg-surface p-3 shadow-soft">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => {
          setDraftState(e.target.value)
          requestAnimationFrame(sync)
        }}
        onKeyDown={(e) => onKeyDown(e)}
        rows={2}
        className="w-full resize-none rounded-xl border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
      />
      {menu}
    </div>
  )
}

const meta = {
  title: 'Conversation/MentionPicker',
  component: MentionPickerHost,
  args: { draft: 'Take a look at @' },
  parameters: { controls: { disable: true } },
  // The menu opens UPWARD (`bottom-full`) from the composer, so it needs room above.
  decorators: [
    withDocsFixtures(),
    (Story) => (
      <div className="flex min-h-[420px] flex-col justify-end">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MentionPickerHost>

export default meta
type Story = StoryObj<typeof meta>

/** No query yet — the most-recent docs list, top row selected and opened into its excerpt card. */
export const RecentDocs: Story = {}

/** Typing narrows the list to matching names; the typed letters highlight in accent ink. */
export const FilteredQuery: Story = {
  args: { draft: 'Take a look at @ship' },
}

/** A query that matches nothing collapses the picker entirely (open only holds while there's at
 *  least one match) — the textarea alone, no floating panel. */
export const NoMatches: Story = {
  args: { draft: 'Take a look at @zzz' },
}
