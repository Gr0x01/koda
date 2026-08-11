import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import type { GuardrailsLayer, SkillState } from '@shared/ipc'
import { GuardrailsSection, SkillsSection } from './GuardrailsSection'
import { useWorkspace, type SessionState } from '../workspace/store'

// Two components share this source file (the nav's "Guardrails" and "Skills" categories), so this
// story file covers both under one title, grouped-gallery style (transcript/StatusPieces.stories.tsx
// precedent) — each has real state variants, so each still gets its own set of stories below.

function withBridgeFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as any).__kodaBridgeFixtures = fixtures
    return <Story />
  }
}

function baseSession(overrides: Partial<SessionState> & Pick<SessionState, 'id' | 'label'>): SessionState {
  return {
    userNamed: true,
    cwd: '/Users/rb/Documents/coding_projects/koda',
    items: [],
    streaming: '',
    busy: false,
    errored: false,
    draft: '',
    attachments: [],
    live: true,
    attention: false,
    approvalMode: 'auto',
    engineId: 'claude',
    spendUsd: 0,
    byModel: {},
    ...overrides,
  }
}

/** "Create with agent" needs a live session to dispatch the turn to — seed one, or clear the slice
 *  to show the disabled "Open a session first" state. */
function withActiveSession(hasSession: boolean) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState(
      hasSession
        ? { activeId: 's-1', sessions: { 's-1': baseSession({ id: 's-1', label: 'Fix the login flow' }) } }
        : { activeId: null, sessions: {} },
    )
    return <Story />
  }
}

const GUARDRAILS_LAYER: GuardrailsLayer = {
  rules: [
    {
      scope: 'koda',
      title: 'Ask before big changes',
      summary: 'Checks with you before major features or architecture shifts.',
      body: "Ask before making major feature or architecture changes.\nGet approval before adding dependencies or altering core workflows.\nExplain your reasoning when proposing changes; surface trade-offs early.",
      enabled: true,
      kind: 'safety',
      section: 'core',
      toggleKey: 'ask-before-major',
      principleId: 'ask-before-major',
    },
    {
      scope: 'koda',
      title: 'Keep it simple',
      summary: 'Smallest change that solves the problem — no gold-plating for a solo project.',
      body: 'Follow KISS and YAGNI — do not build for hypothetical futures without explicit direction. Skip enterprise patterns unless explicitly needed.',
      enabled: true,
      kind: 'preference',
      section: 'core',
      toggleKey: 'kiss',
      principleId: 'kiss',
      customized: true,
    },
    {
      scope: 'koda',
      title: 'Guard destructive git',
      summary: 'Force-push, hard reset, and branch deletion always confirm, in every approval mode.',
      body: 'Never run destructive git commands (push --force, reset --hard, checkout ., clean -f, branch -D) unless explicitly requested.',
      enabled: true,
      kind: 'safety',
      section: 'core',
      toggleKey: 'destructive-git',
      principleId: 'destructive-git',
    },
    {
      scope: 'project',
      title: 'CLAUDE.md',
      body: '# Project rules\n\nEdit existing files before creating new ones. Search before inventing.\nRun linting and type checking before handoff.',
      enabled: true,
      path: '/Users/rb/Documents/coding_projects/koda/CLAUDE.md',
    },
  ],
  skills: [
    {
      scope: 'koda',
      name: 'frontend-design',
      description: 'Guidelines for distinctive, high-quality renderer UI — bold typography, real atmosphere.',
      body: '---\nname: frontend-design\ndescription: Guidelines for distinctive UI\n---\n\nAvoid generic AI-slop patterns...',
      enabled: true,
      toggleKey: 'skill-frontend-design',
    },
    {
      scope: 'project',
      name: 'release-checklist',
      description: 'The mechanical steps for cutting a Koda release.',
      body: '---\nname: release-checklist\n---\n\n1. Update CHANGELOG.md\n2. Bump the version\n3. Tag + push',
      enabled: true,
      openPath: '/Users/rb/Documents/coding_projects/koda/.claude/skills/release-checklist/SKILL.md',
    },
  ],
  subagents: [
    {
      scope: 'koda',
      name: 'code-reviewer',
      description: 'Proactive code quality, security, and maintainability reviews.',
      body: '---\nname: code-reviewer\n---\n\nReview diffs for security issues, code quality, and maintainability.',
      enabled: true,
      toggleKey: 'subagent-code-reviewer',
    },
    {
      scope: 'project',
      name: 'db-migrator',
      description: 'Writes and reviews SQL migrations for this project.',
      body: '---\nname: db-migrator\n---\n\nWrite migrations that are reversible and reviewed before applying.',
      enabled: false,
      openPath: '/Users/rb/Documents/coding_projects/koda/.claude/agents/db-migrator.md',
    },
  ],
}

const meta = {
  title: 'Settings/Guardrails',
  parameters: { controls: { disable: true } },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="max-w-2xl space-y-8">{children}</div>
}

/** Rules, skills, and subagents across both Koda defaults and this project's own — a customized
 *  principle, a protected safety rule, a disabled project subagent, and the raw CLAUDE.md row. */
export const Gallery: Story = {
  decorators: [withBridgeFixtures({ listGuardrails: GUARDRAILS_LAYER }), withActiveSession(true)],
  render: () => (
    <Frame>
      <GuardrailsSection />
    </Frame>
  ),
}

/** No active session — "Create with agent" is disabled with a pointer to open one first; Save still works. */
export const NoActiveSession: Story = {
  decorators: [withBridgeFixtures({ listGuardrails: GUARDRAILS_LAYER }), withActiveSession(false)],
  render: () => (
    <Frame>
      <GuardrailsSection />
    </Frame>
  ),
}

/** Opening a row reveals its full text inline, with the contextual reset (Restore default / Delete). */
export const RowOpen: Story = {
  decorators: [withBridgeFixtures({ listGuardrails: GUARDRAILS_LAYER }), withActiveSession(true)],
  render: () => (
    <Frame>
      <GuardrailsSection />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Keep it simple'))
    await waitFor(() => expect(canvas.getByText('Restore default')).toBeInTheDocument())
  },
}

/** The undo net is down: main refuses a guardrail edit it can't first make undoable, and the row says
 *  which one and what did NOT happen. Without this the row read "Couldn't update. Try again." and the
 *  user would retry forever against a recovery store that isn't coming back on its own. */
export const RefusedNoUndoPoint: Story = {
  decorators: [
    withBridgeFixtures({
      listGuardrails: GUARDRAILS_LAYER,
      setRuleOverride: () => {
        throw new Error(
          "Error invoking remote method 'guardrails:setRuleOverride': Error: Couldn't make an undo point, so the rule was left as it was.",
        )
      },
    }),
    withActiveSession(true),
  ],
  render: () => (
    <Frame>
      <GuardrailsSection />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Keep it simple'))
    const box = await canvas.findByRole('textbox')
    await userEvent.type(box, ' Extra wording.')
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(canvas.getAllByText(/Couldn't make an undo point, so the rule was left as it was\./)[0]).toBeInTheDocument(),
    )
  },
}

// ── Skills gallery ──────────────────────────────────────────────────────────────────
const SKILLS: SkillState[] = [
  { id: 'canvas-design', title: 'Canvas design', category: 'Canvas & design', blurb: 'Design a poster, deck, or one-page layout.', deps: 'none', defaultActive: true, global: true, project: false },
  { id: 'brand-identity', title: 'Brand identity', category: 'Canvas & design', blurb: 'Work out a name, palette, and voice for a new brand.', deps: 'none', defaultActive: false, global: false, project: true },
  { id: 'doc-coauthor', title: 'Doc co-author', category: 'Docs', blurb: 'Draft and revise a long document alongside you.', deps: 'none', defaultActive: true, global: true, project: false },
  { id: 'pdf-forms', title: 'PDF forms', category: 'Docs', blurb: 'Fill and flatten a fillable PDF form.', deps: 'requires pypdf', defaultActive: false, global: false, project: false },
  { id: 'theme-a-page', title: 'Theme a page', category: 'Advanced', blurb: 'Apply a cohesive visual theme across a whole site.', deps: 'none', defaultActive: false, global: false, project: false },
]

/** The bundled Anthropic skills gallery, grouped by category — availability picked per skill
 *  (Off / This project / Everywhere). */
export const SkillsGallery: Story = {
  decorators: [
    withBridgeFixtures({ listSkills: SKILLS }),
    (Story) => {
      useWorkspace.setState({ projectPath: '/Users/rb/Documents/coding_projects/koda' })
      return <Story />
    },
  ],
  render: () => (
    <Frame>
      <SkillsSection />
    </Frame>
  ),
}

/** No project open (a ProjectHome window) — "This project" drops out, leaving Off / Everywhere. */
export const SkillsNoProject: Story = {
  decorators: [
    withBridgeFixtures({ listSkills: SKILLS }),
    (Story) => {
      useWorkspace.setState({ projectPath: '' })
      return <Story />
    },
  ],
  render: () => (
    <Frame>
      <SkillsSection />
    </Frame>
  ),
}
