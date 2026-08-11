import { describe, expect, it } from 'vitest'
import { isBackgroundSubagentLaunchResult, taskNotificationToCompletion } from './adapter'

describe('background subagent notifications', () => {
  it('does not mistake Claude\'s async launch receipt for the child result', () => {
    expect(
      isBackgroundSubagentLaunchResult(
        'Async agent launched successfully.\nThe agent is working in the background. You will be notified automatically when it completes.',
      ),
    ).toBe(true)
    expect(isBackgroundSubagentLaunchResult('The child inspected the adapter and found no issue.')).toBe(false)
  })

  it('turns a completed task notification into the child result Koda persists', () => {
    expect(
      taskNotificationToCompletion('s1', 'tool-1', {
        status: 'completed',
        task_id: 'task-1',
        summary: '**Outcome** — found it',
        usage: { total_tokens: 123, tool_uses: 2, duration_ms: 456 },
      }),
    ).toEqual({
      type: 'SubagentCompleted',
      sessionId: 's1',
      toolUseId: 'tool-1',
      taskId: 'task-1',
      resultText: '**Outcome** — found it',
      outcome: 'completed',
      isError: false,
      usage: { totalTokens: 123, toolUses: 2, durationMs: 456 },
    })
  })

  it('keeps a targeted stop distinct from a failed child', () => {
    const event = taskNotificationToCompletion('s1', 'tool-1', {
      status: 'stopped',
      task_id: 'task-1',
      summary: 'Stopped by the user',
    })
    expect(event.outcome).toBe('interrupted')
    expect(event.isError).toBe(false)
  })
})
