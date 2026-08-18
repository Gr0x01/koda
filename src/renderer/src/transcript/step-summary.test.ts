import { describe, expect, it } from 'vitest'
import { runSummary, stepLabel } from './step-summary'
import type { Entry } from './types'

let nextId = 0
const tool = (name: string, input: unknown): Entry => ({
  id: ++nextId,
  kind: 'tool',
  toolUseId: `tu${nextId}`,
  name,
  input,
})

describe('stepLabel', () => {
  it('names a tool by what it was about, not its arguments', () => {
    expect(stepLabel(tool('Bash', { command: 'npm test' }))).toEqual({ name: 'Bash', detail: 'npm test' })
    expect(stepLabel(tool('Read', { file_path: 'src/main/ipc.ts' }))).toEqual({
      name: 'Read',
      detail: 'src/main/ipc.ts',
    })
  })

  it('prefers the pattern over the path, which is what the step was actually about', () => {
    expect(stepLabel(tool('Grep', { pattern: 'listHotSessions', path: 'src' })).detail).toBe('listHotSessions')
  })

  it('reads the thinking line as its own state', () => {
    const thinking: Entry = { id: ++nextId, kind: 'thinking', active: true, estimatedTokens: 1200 }
    expect(stepLabel(thinking)).toEqual({ name: 'Thinking', detail: '~1,200 tokens' })
    expect(stepLabel({ ...thinking, active: false })).toMatchObject({ name: 'Thought' })
  })

  it('has nothing to say about an entry that carries its own container', () => {
    expect(stepLabel({ id: ++nextId, kind: 'assistant', markdown: 'hi' })).toEqual({ name: '', detail: '' })
  })
})

describe('runSummary', () => {
  it('describes the newest step — the one you would look for', () => {
    const run = [tool('Read', { file_path: 'a.ts' }), tool('Bash', { command: 'npm test' })]
    expect(runSummary(run)).toEqual({ name: 'Bash', detail: 'npm test' })
  })

  it('says nothing about an empty run rather than inventing a step', () => {
    expect(runSummary([])).toEqual({ name: '', detail: '' })
  })
})
