import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendRemoteReplay,
  deleteRemoteReplay,
  loadRemoteReplay,
  replaceRemoteReplay,
} from './remote-replay-store'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16)
const created: string[] = []

function fixture(): { project: string; session: string; path: string } {
  const project = `/koda-replay-test/${Math.random().toString(36).slice(2)}-${process.hrtime.bigint()}`
  const session = `session-${Math.random().toString(36).slice(2)}`
  const dir = join(tmpdir(), `koda-replay-${hash(project)}.bodies`)
  created.push(dir)
  return { project, session, path: join(dir, `${hash(session)}.jsonl`) }
}

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('durable remote replay', () => {
  it('round-trips task lifecycle and remaps a resumed live session id', () => {
    const f = fixture()
    appendRemoteReplay(f.project, f.session, {
      type: 'SubagentStarted',
      sessionId: f.session,
      toolUseId: 'agent-1',
      taskId: 'task-1',
      subagentType: 'scout',
      description: 'Inspect',
    })
    appendRemoteReplay(f.project, f.session, {
      type: 'SubagentCompleted',
      sessionId: f.session,
      toolUseId: 'agent-1',
      taskId: 'task-1',
      outcome: 'completed',
      resultText: 'Evidence',
    })

    const replay = loadRemoteReplay(f.project, f.session, 'live-session')
    expect(replay.map((entry) => entry.sessionId)).toEqual(['live-session', 'live-session'])
    expect(replay.at(-1)).toMatchObject({ type: 'SubagentCompleted', resultText: 'Evidence' })
  })

  it('keeps valid rows when the final append was torn', () => {
    const f = fixture()
    replaceRemoteReplay(f.project, f.session, [
      { type: 'RemoteUserTurn', sessionId: f.session, text: 'hello' },
    ])
    appendFileSync(f.path, '{"type":"SubagentStarted"', 'utf8')

    expect(loadRemoteReplay(f.project, f.session)).toEqual([
      { type: 'RemoteUserTurn', sessionId: f.session, text: 'hello' },
    ])
    expect(readFileSync(f.path, 'utf8')).toContain('SubagentStarted')
  })

  it('keeps the first valid append after a torn row', () => {
    const f = fixture()
    replaceRemoteReplay(f.project, f.session, [])
    appendFileSync(f.path, '{"type":"SubagentStarted"', 'utf8')

    appendRemoteReplay(f.project, f.session, {
      type: 'SubagentCompleted',
      sessionId: f.session,
      toolUseId: 'agent-1',
      outcome: 'completed',
      resultText: 'Recovered result',
    })

    expect(loadRemoteReplay(f.project, f.session)).toEqual([
      expect.objectContaining({ type: 'SubagentCompleted', resultText: 'Recovered result' }),
    ])
  })

  it('removes the sidecar with a permanently deleted session', () => {
    const f = fixture()
    appendRemoteReplay(f.project, f.session, {
      type: 'RemoteUserTurn',
      sessionId: f.session,
      text: 'private history',
    })

    deleteRemoteReplay(f.project, f.session)

    expect(loadRemoteReplay(f.project, f.session)).toEqual([])
  })
})
