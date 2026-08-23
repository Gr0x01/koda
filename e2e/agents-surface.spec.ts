import { test, expect, type ElectronApplication } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKoda, makeUserDataDir, openFileViaLibrary } from './support/koda'

const SESSION_LABEL = `AgentRoster${'x'.repeat(120)}`

const storeName = (projectPath: string): string =>
  `koda-sessions-${createHash('sha256').update(projectPath).digest('hex').slice(0, 16)}.json`

function seededFleet(): { project: string; userDataDir: string } {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-agents-proj-')))
  const userDataDir = makeUserDataDir('koda-agents-e2e-')
  writeFileSync(join(project, 'README.md'), '# Agent roster fixture\n')
  writeFileSync(
    join(userDataDir, storeName(project)),
    JSON.stringify({
      version: 3,
      projectPath: project,
      activeId: 'agents-session',
      sessions: [
        {
          id: 'agents-session',
          label: SESSION_LABEL,
          cwd: project,
          items: [
            { id: 1, kind: 'user', text: 'Review the session boundary and hardening work.' },
            {
              id: 2,
              kind: 'subagent',
              toolUseId: 'audit-contracts',
              subagentType: 'codex',
              description: 'audit_repository_contracts',
              status: 'completed',
              usage: { totalTokens: 8200, toolUses: 4, durationMs: 122_000 },
              children: [],
              resultText: 'Mapped the renderer and engine boundaries; no lifecycle bypass found.',
            },
            {
              id: 3,
              kind: 'subagent',
              toolUseId: 'fresh-judge',
              subagentType: 'codex',
              description: 'fresh_judge',
              status: 'completed',
              isError: true,
              usage: { totalTokens: 4400, toolUses: 1, durationMs: 59_000 },
              children: [],
              resultText: 'The first pass left the workflow rows out of launch order.',
            },
          ],
        },
      ],
    }),
  )
  return { project, userDataDir }
}

async function emitLiveFleet(app: ElectronApplication): Promise<void> {
  const events = [
    {
      type: 'WorkflowStarted',
      sessionId: 'agents-session',
      runId: 'parallel-review',
      name: 'parallel_review',
    },
    {
      type: 'WorkflowAgent',
      sessionId: 'agents-session',
      runId: 'parallel-review',
      agentId: 'review-a',
      status: 'done',
      result: 'The launch-order contract is intact.',
    },
    {
      type: 'WorkflowAgent',
      sessionId: 'agents-session',
      runId: 'parallel-review',
      agentId: 'review-b',
      status: 'running',
    },
    // The watcher can infer coordinator completion from journal silence before a long-running
    // member reports its result. That member must remain live throughout the roster.
    {
      type: 'WorkflowCompleted',
      sessionId: 'agents-session',
      runId: 'parallel-review',
      agentCount: 2,
    },
    {
      type: 'SubagentStarted',
      sessionId: 'agents-session',
      toolUseId: 'repair-renderer',
      taskId: 'task-repair-renderer',
      subagentType: 'codex',
      description: 'repair_renderer_surface',
      prompt: 'Keep the mobile card intact while replacing the desktop card stack with one inline roster.',
    },
    {
      type: 'SubagentProgress',
      sessionId: 'agents-session',
      toolUseId: 'repair-renderer',
      taskId: 'task-repair-renderer',
      description: 'Checking intrinsic widths',
      lastToolName: 'Read',
      usage: { totalTokens: 3100, toolUses: 2 },
    },
  ]
  await app.evaluate(({ BrowserWindow }, payload) => {
    const window = BrowserWindow.getAllWindows()[0]
    for (const event of payload) window.webContents.send('engine:event', event)
  }, events)
}

test('Agents is a launch-order roster with one inline detail and fluid narrow layout', async () => {
  const { project, userDataDir } = seededFleet()
  const app = await launchKoda({ projectPath: project, userDataDir })
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (error) => pageErrors.push(error.message))
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })

    // Start with one ordinary file on stage. The first live delegate must add AND select Agents by
    // itself — no transcript click or + picker round-trip — while keeping that file co-open.
    await openFileViaLibrary(win, 'README.md')
    await emitLiveFleet(app)
    const roster = win.getByTestId('agents-roster')
    await expect(roster).toBeVisible({ timeout: 20_000 })
    await expect(roster.getByRole('heading', { name: SESSION_LABEL })).toBeVisible()
    await expect(roster.getByRole('heading', { name: 'Working now' })).toBeVisible()
    await expect(roster.getByText(/2 working.*2 done.*1 failed/)).toBeVisible()
    await expect(roster.getByText(/settled/i)).toHaveCount(0)

    const rows = roster.locator('[data-agent-entry] > button[aria-expanded]')
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(0)).toContainText('Audit repository contracts')
    await expect(rows.nth(1)).toContainText('Fresh judge')
    await expect(rows.nth(2)).toContainText('Parallel review')
    await expect(rows.nth(2)).toContainText('1 still working')
    await expect(
      roster.getByRole('button', { name: /Parallel review.*1 agent is still working/ }).first(),
    ).toBeVisible()
    await expect(rows.nth(3)).toContainText('Repair renderer surface')
    const stopAgent = roster.locator(
      '[data-agent-entry="subagent"] > button[aria-label="Stop Repair renderer surface"]',
    )
    await expect(stopAgent).toBeVisible()
    await expect(stopAgent).toHaveText('')

    // The first live entry opens by default. Choosing another live shortcut moves the ONE inline
    // detail instead of creating another pane or leaving multiple long sub-threads open.
    await expect(rows.filter({ hasText: 'Parallel review' })).toHaveAttribute('aria-expanded', 'true')
    await roster.getByRole('button', { name: /Repair renderer surface.*Checking intrinsic widths/ }).first().click()
    await expect(rows.filter({ hasText: 'Repair renderer surface' })).toHaveAttribute('aria-expanded', 'true')
    await expect(roster.locator('[data-agent-entry] > button[aria-expanded="true"]')).toHaveCount(1)
    await expect(roster.locator('[data-agent-details]')).toHaveCount(1)
    await expect(roster.locator('[data-agent-details] button[aria-label="Stop Repair renderer surface"]')).toHaveCount(0)
    await expect(roster.getByText('Keep the mobile card intact', { exact: false })).toBeVisible()

    // The stage is independently resizable inside a normal desktop window. Drag its own divider to
    // 320px (rather than shrinking the entire three-column shell) and prove this surface stays fluid.
    const stageDivider = win.locator('.cursor-col-resize').last()
    const dividerBox = await stageDivider.boundingBox()
    expect(dividerBox).not.toBeNull()
    const innerWidth = await win.evaluate(() => window.innerWidth)
    await win.mouse.move(dividerBox!.x + dividerBox!.width / 2, dividerBox!.y + 80)
    await win.mouse.down()
    await win.mouse.move(innerWidth - 320, dividerBox!.y + 80, { steps: 6 })
    await win.mouse.up()
    // Releasing the divider restores the Stage's normal width transition. On a fast host the first
    // layout sample can land partway through that final frame, so wait for the requested width rather
    // than treating animation timing as layout behavior.
    await expect
      .poll(() => win.getByTestId('agents-scroll-owner').evaluate((node) => node.clientWidth))
      .toBeLessThanOrEqual(340)
    const overflow = await win.getByTestId('agents-scroll-owner').evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    }))
    expect(overflow.clientWidth).toBeGreaterThanOrEqual(300)
    expect(overflow.clientWidth).toBeLessThanOrEqual(340)
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)

    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
  }
})
