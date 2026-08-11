import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ApprovalRequest } from '@shared/ipc'
import { ApprovalPrompt } from './ApprovalPrompt'

const sessionId = 'sess_9f3c2a'

const bashCommand: ApprovalRequest = {
  sessionId,
  requestId: 'req_bash',
  toolName: 'Bash',
  input: { command: 'rm -rf dist && npm run build' },
}

const fileWrite: ApprovalRequest = {
  sessionId,
  requestId: 'req_write',
  toolName: 'Write',
  input: {
    file_path: '/Users/rb/Projects/acme-app/src/components/Header.tsx',
    content: 'export function Header() {\n  return <header>Acme</header>\n}\n',
  },
}

const searchPattern: ApprovalRequest = {
  sessionId,
  requestId: 'req_grep',
  toolName: 'Grep',
  input: { pattern: 'useWorkspace\\(' },
}

const planReview: ApprovalRequest = {
  sessionId,
  requestId: 'req_plan',
  toolName: 'ExitPlanMode',
  input: {
    plan:
      '# Add a dark mode toggle\n\n' +
      '1. Add a `theme` field to the settings store\n' +
      '2. Wire a toggle into the Settings panel\n' +
      '3. Apply the `.dark` class on `<html>` from the stored preference\n' +
      '4. Persist the choice to `localStorage`',
  },
}

const toolSetup: ApprovalRequest = {
  sessionId,
  requestId: 'req_setup_node',
  toolName: 'mcp__koda_broker__ensure_tool',
  input: { tool_id: 'node' },
}

const toolSetupUnknown: ApprovalRequest = {
  sessionId,
  requestId: 'req_setup_custom',
  toolName: 'mcp__koda_broker__ensure_tool',
  input: { tool_id: 'imagemagick' },
}

const meta = {
  title: 'Approval/ApprovalPrompt',
  component: ApprovalPrompt,
  parameters: { controls: { disable: true } },
  args: {
    request: bashCommand,
    onAllow: () => {},
    onDeny: () => {},
    active: false,
  },
} satisfies Meta<typeof ApprovalPrompt>

export default meta
type Story = StoryObj<typeof meta>

export const BashCommand: Story = {
  render: () => (
    <div className="max-w-md">
      <ApprovalPrompt request={bashCommand} onAllow={() => {}} onDeny={() => {}} />
    </div>
  ),
}

export const FileWrite: Story = {
  render: () => (
    <div className="max-w-md">
      <ApprovalPrompt request={fileWrite} onAllow={() => {}} onDeny={() => {}} />
    </div>
  ),
}

/** The self-protection tier: a forced ask (even in Auto) with the gate's reason line explaining
 *  why this one surfaced — the card must read as "this is different", not an ordinary approval. */
export const ProtectedTarget: Story = {
  render: () => (
    <div className="max-w-md">
      <ApprovalPrompt
        request={{
          sessionId,
          requestId: 'req_protected',
          toolName: 'Edit',
          input: { file_path: '.koda/guardrails.json', old_string: '"disabled": []', new_string: '"disabled": ["rule:critique-before-done"]' },
          reason: "This changes this project's guardrail switches — Koda always checks with you first.",
        }}
        onAllow={() => {}}
        onDeny={() => {}}
      />
    </div>
  ),
}

export const SearchPattern: Story = {
  render: () => (
    <div className="max-w-md">
      <ApprovalPrompt request={searchPattern} onAllow={() => {}} onDeny={() => {}} />
    </div>
  ),
}

export const PlanReview: Story = {
  render: () => (
    <div className="max-w-xl">
      <ApprovalPrompt request={planReview} onAllow={() => {}} onDeny={() => {}} />
    </div>
  ),
}

export const ToolSetup: Story = {
  render: () => (
    <div className="max-w-md">
      <ApprovalPrompt request={toolSetup} onAllow={() => {}} onDeny={() => {}} />
    </div>
  ),
}

export const ToolSetupUnknown: Story = {
  render: () => (
    <div className="max-w-md">
      <ApprovalPrompt request={toolSetupUnknown} onAllow={() => {}} onDeny={() => {}} />
    </div>
  ),
}
