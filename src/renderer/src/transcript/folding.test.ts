import { describe, expect, it } from 'vitest'
import { buildTurns } from './folding'
import type { Entry } from './types'

let nextId = 0
const user = (text: string): Entry => ({ id: ++nextId, kind: 'user', text })
const say = (markdown: string): Entry => ({ id: ++nextId, kind: 'assistant', markdown })
const tool = (name: string): Entry => ({ id: ++nextId, kind: 'tool', toolUseId: `tu${nextId}`, name, input: {} })

describe('buildTurns — the live turn', () => {
  it('collapses a run to one object, holding every step', () => {
    const items = [user('go'), tool('Read'), tool('Grep'), tool('Bash')]
    const [turn] = buildTurns(items, { live: true })
    expect(turn.fold).toBeNull()
    const group = turn.body[0]
    expect(group).toMatchObject({ type: 'group', collapsed: true, expanded: false })
    // Every step rides along even while shut — the strip reads the newest one to say what it holds.
    expect(group.type === 'group' && group.entries.map((e) => e.kind === 'tool' && e.name)).toEqual([
      'Read',
      'Grep',
      'Bash',
    ])
  })

  it('keeps the toggle once opened', () => {
    const items = [user('go'), tool('Read'), tool('Grep'), tool('Bash')]
    const [turn] = buildTurns(items, { live: true, expandedRuns: new Set([`g${items[1].id}`]) })
    expect(turn.body[0]).toMatchObject({ type: 'group', collapsed: true, expanded: true })
  })

  it('marks only the run at the tail live', () => {
    const items = [user('go'), tool('Read'), say('narrating'), tool('Bash')]
    const [turn] = buildTurns(items, { live: true })
    expect(turn.body.map((n) => n.type === 'group' && n.live)).toEqual([false, false, true])
  })

  it('marks nothing live once the answer is the tail', () => {
    const items = [user('go'), tool('Bash'), say('done')]
    const [turn] = buildTurns(items, { live: true })
    expect(turn.body.some((n) => n.type === 'group' && n.live)).toBe(false)
  })

  it('collects a turn\'s delegates into one row where the first launched', () => {
    const delegate = (toolUseId: string): Entry => ({
      id: ++nextId,
      kind: 'subagent',
      toolUseId,
      subagentType: 'scout',
      description: 'Look',
      status: 'running',
      children: [],
    })
    // Progress rows land between spawns during a real fan-out; the row must not splinter into three.
    const items = [user('go'), delegate('a'), tool('Read'), delegate('b'), tool('Grep'), delegate('c')]
    const [turn] = buildTurns(items, { live: true })
    expect(turn.body.map((n) => n.type)).toEqual(['fleet', 'group', 'group'])
    const fleet = turn.body[0]
    expect(fleet.type === 'fleet' && fleet.entries.map((e) => e.kind === 'subagent' && e.toolUseId)).toEqual(['a', 'b', 'c'])
  })

  it('gives each turn its own row', () => {
    const delegate = (): Entry => ({
      id: ++nextId,
      kind: 'subagent',
      toolUseId: `tu${nextId}`,
      subagentType: 'scout',
      description: 'Look',
      status: 'running',
      children: [],
    })
    const turns = buildTurns([user('first'), delegate(), say('done'), user('second'), delegate()], { live: true })
    expect(turns.map((t) => t.body.filter((n) => n.type === 'fleet').length)).toEqual([1, 1])
  })

  it('leaves only the LAST turn unsettled', () => {
    const items = [user('first'), tool('Read'), say('done'), user('second'), tool('Bash')]
    const [first, second] = buildTurns(items, { live: true })
    expect(first.fold).toMatchObject({ count: 1 })
    expect(second.fold).toBeNull()
  })
})

describe('buildTurns — the settled turn', () => {
  it('folds the work behind one line, leaving the answer', () => {
    const items = [user('go'), tool('Read'), { id: ++nextId, kind: 'thinking', active: false } as Entry, say('narration'), tool('Bash'), say('Done — search works.')]
    const [turn] = buildTurns(items, { live: false })
    expect(turn.fold).toMatchObject({ count: 4, expanded: false })
    expect(turn.body).toHaveLength(1)
    expect(turn.body[0]).toMatchObject({ type: 'item', entry: { markdown: 'Done — search works.' } })
  })

  it('opens back to the full body, still in order', () => {
    const items = [user('go'), tool('Read'), say('answer')]
    const turnId = items[0].id
    const [turn] = buildTurns(items, { live: false, expandedTurns: new Set([turnId]) })
    expect(turn.fold).toMatchObject({ expanded: true })
    expect(turn.body.map((n) => n.type)).toEqual(['group', 'item'])
    // Opened from the turn's own door, so the run inside is already shown — no second door over it.
    expect(turn.body[0]).toMatchObject({ collapsed: false })
  })

  it('does not fold a turn that is only its answer', () => {
    const [turn] = buildTurns([user('hi'), say('hello')], { live: false })
    expect(turn.fold).toBeNull()
    expect(turn.body).toHaveLength(1)
  })

  it('keeps a running delegate, a notice, and an answered question out of the fold', () => {
    const running: Entry = {
      id: ++nextId,
      kind: 'subagent',
      toolUseId: 'tu_sub',
      subagentType: 'scout',
      description: 'Check the docs',
      status: 'running',
      children: [],
    }
    const finished: Entry = { ...running, id: ++nextId, toolUseId: 'tu_sub2', status: 'completed' }
    const notice: Entry = { id: ++nextId, kind: 'notice', text: 'Restored a version' }
    const question: Entry = { id: ++nextId, kind: 'tool', toolUseId: 'tu_q', name: 'AskUserQuestion', input: {} }
    const [turn] = buildTurns([user('go'), tool('Read'), running, finished, notice, question, say('done')], {
      live: false,
    })
    expect(turn.fold).toMatchObject({ count: 1 }) // the Read step
    expect(turn.body.map((n) => (n.type === 'item' ? n.entry.kind : n.type))).toEqual([
      'fleet',
      'notice',
      'tool',
      'assistant',
    ])
    // The settled sibling rides through the fold with the running one: the row counts the batch, so a
    // fold that took half of it would say "1 agent" while two were launched.
    expect(turn.body[0]).toMatchObject({
      type: 'fleet',
      entries: [{ toolUseId: 'tu_sub' }, { toolUseId: 'tu_sub2' }],
    })
  })

  it('folds the delegates away once the whole batch has settled', () => {
    const done: Entry = {
      id: ++nextId,
      kind: 'subagent',
      toolUseId: 'tu_done',
      subagentType: 'scout',
      description: 'Check the docs',
      status: 'completed',
      children: [],
    }
    const [turn] = buildTurns([user('go'), done, say('answer')], { live: false })
    expect(turn.fold).toMatchObject({ count: 1 })
    expect(turn.body.map((n) => n.type)).toEqual(['item'])
  })

  it('keeps a workflow row visible while a member outlives its settled coordinator', () => {
    const workflow: Entry = {
      id: ++nextId,
      kind: 'workflow',
      runId: 'late-member',
      name: 'Late member',
      status: 'completed',
      agents: [{ agentId: 'reviewer', status: 'running' }],
    }
    const [turn] = buildTurns([user('go'), tool('Read'), workflow, say('answer')], { live: false })
    expect(turn.fold).toMatchObject({ count: 1 })
    expect(turn.body.map((node) => node.type)).toEqual(['fleet', 'item'])
  })

  it('keeps a substantial mid-turn passage out of the fold when the closing line is smaller', () => {
    const substance =
      'Here is the verbatim quote you asked about, with the full explanation of where it came from and ' +
      'why it matters. This is the real reply: several sentences the reader was meant to see, written ' +
      'before the edits ran. If the fold swallowed it, the closing line below would reference a quote ' +
      'the reader never saw, which is exactly the silent failure the fail-open rule exists to stop.'
    const items = [user('go'), say(substance), tool('Edit'), tool('Edit'), say('Done.')]
    const [turn] = buildTurns(items, { live: false })
    expect(turn.fold).toMatchObject({ count: 2 }) // only the two edits
    expect(turn.body.map((n) => n.type === 'item' && n.entry.kind === 'assistant' && n.entry.markdown)).toEqual([
      substance,
      'Done.',
    ])
  })

  it('still folds a status line that merely outruns a terse closer', () => {
    const items = [user('go'), say('Confirmed the pack is the right seam, adding the rule there now.'), tool('Edit'), say('Done.')]
    const [turn] = buildTurns(items, { live: false })
    expect(turn.fold).toMatchObject({ count: 2 }) // the status line and the edit
    expect(turn.body).toHaveLength(1)
  })

  it('folds an interrupted turn that never produced an answer', () => {
    const [turn] = buildTurns([user('go'), tool('Read'), tool('Bash')], { live: false })
    expect(turn.fold).toMatchObject({ count: 2 })
    expect(turn.body).toHaveLength(0)
  })
})
