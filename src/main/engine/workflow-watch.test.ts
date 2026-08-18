import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineEvent } from '@shared/ipc'
import { WorkflowWatcher } from './workflow-watch'

const tempDirs: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('WorkflowWatcher', () => {
  it('settles unresolved members as unknown when journal observation stops', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'koda-workflow-watch-'))
    tempDirs.push(dir)
    writeFileSync(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', agentId: 'reviewer' })}\n`)
    const events: EngineEvent[] = []
    const watcher = new WorkflowWatcher('session', 'run', dir, (event) => events.push(event), vi.fn())

    watcher.start()
    await vi.advanceTimersByTimeAsync(2_001)
    expect(events.at(-1)).toMatchObject({ type: 'WorkflowAgent', agentId: 'reviewer', status: 'running' })
    expect(watcher.activeAgentIds()).toEqual(['reviewer'])
    expect(watcher.isLive()).toBe(true)

    watcher.stop()
    expect(events.at(-1)).toMatchObject({
      type: 'WorkflowObservationEnded',
      unresolvedAgentIds: ['reviewer'],
    })
    expect(watcher.isLive()).toBe(false)

    // Teardown is idempotent; it must not publish duplicate terminal events.
    watcher.stop()
    expect(events.filter((event) => event.type === 'WorkflowObservationEnded')).toHaveLength(1)
  })

  it('does not announce quiet completion while a known member is still running', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'koda-workflow-watch-'))
    tempDirs.push(dir)
    writeFileSync(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', agentId: 'reviewer' })}\n`)
    const events: EngineEvent[] = []
    const watcher = new WorkflowWatcher('session', 'run', dir, (event) => events.push(event), vi.fn())

    watcher.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(events.some((event) => event.type === 'WorkflowCompleted')).toBe(false)
    watcher.stop()
  })

  it('keeps observing a known member beyond journal quiet and finishes after its eventual result', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'koda-workflow-watch-'))
    tempDirs.push(dir)
    const journal = join(dir, 'journal.jsonl')
    const started = JSON.stringify({ type: 'started', agentId: 'reviewer' })
    writeFileSync(journal, `${started}\n`)
    const events: EngineEvent[] = []
    const finished = vi.fn()
    const watcher = new WorkflowWatcher('session', 'run', dir, (event) => events.push(event), finished)

    watcher.start()
    await vi.advanceTimersByTimeAsync(2_001)

    // A long-running member can legitimately leave the append-only journal unchanged for much
    // longer than the late-wave observer window. Quiet must not erase its known writer ownership.
    await vi.advanceTimersByTimeAsync(92_000)
    expect(finished).not.toHaveBeenCalled()
    expect(watcher.activeAgentIds()).toEqual(['reviewer'])
    expect(watcher.isLive()).toBe(true)
    expect(events.some((event) => event.type === 'WorkflowObservationEnded')).toBe(false)

    const result = JSON.stringify({ type: 'result', agentId: 'reviewer', result: 'review complete' })
    writeFileSync(journal, `${started}\n${result}\n`)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'WorkflowAgent', agentId: 'reviewer', status: 'done' }),
    )

    // Once every known member settles, the normal quiet-completion and late-wave observation windows
    // still apply, after which the owner drops exactly once.
    await vi.advanceTimersByTimeAsync(92_000)
    expect(events).toContainEqual(expect.objectContaining({ type: 'WorkflowCompleted', runId: 'run' }))
    expect(finished).toHaveBeenCalledOnce()
    expect(events.some((event) => event.type === 'WorkflowObservationEnded')).toBe(false)
  })

  it('retains the 30-minute hard cap for a known member that never returns', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'koda-workflow-watch-'))
    tempDirs.push(dir)
    writeFileSync(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', agentId: 'reviewer' })}\n`)
    const events: EngineEvent[] = []
    const finished = vi.fn()
    const watcher = new WorkflowWatcher('session', 'run', dir, (event) => events.push(event), finished)

    watcher.start()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 2_001)

    expect(finished).toHaveBeenCalledOnce()
    expect(events.at(-1)).toMatchObject({
      type: 'WorkflowObservationEnded',
      unresolvedAgentIds: ['reviewer'],
    })
    expect(watcher.isLive()).toBe(false)
  })

  it('preserves authoritative result-file completion through immediate teardown', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'koda-workflow-watch-'))
    tempDirs.push(dir)
    writeFileSync(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', agentId: 'reviewer' })}\n`)
    mkdirSync(join(dir, 'workflows'))
    writeFileSync(
      join(dir, 'workflows', 'run.json'),
      JSON.stringify({ status: 'completed', workflowName: 'Review', result: 'Everything finished.' }),
    )
    const events: EngineEvent[] = []
    const finished = vi.fn()
    const watcher = new WorkflowWatcher('session', 'run', dir, (event) => events.push(event), finished, vi.fn())

    watcher.start()
    await vi.advanceTimersByTimeAsync(2_001)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'WorkflowAgent', agentId: 'reviewer', status: 'done' }),
        expect.objectContaining({ type: 'WorkflowCompleted', runId: 'run' }),
      ]),
    )
    // The observer deliberately lingers for a late wave, but the user-visible workflow is settled.
    expect(watcher.isLive()).toBe(false)

    await vi.advanceTimersByTimeAsync(88_000)
    expect(finished).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(finished).toHaveBeenCalledOnce()

    watcher.stop()
    expect(events.some((event) => event.type === 'WorkflowObservationEnded')).toBe(false)
  })
})
