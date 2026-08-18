import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArchivedSessionMeta } from '@shared/ipc'
import {
  doorFromLabels,
  followRefusalCopy,
  followSession,
  parseSessionHref,
  resolveSessionDoor,
  sessionHref,
  SESSION_HREF_PREFIX,
  type SessionDoorStore,
} from './session-href'
import { useWorkspace, type SessionState } from './store'

/**
 * The session door: a document's `source:` frontmatter turned into somewhere the user can go.
 *
 * The load-bearing case is the one that outlives everything else. Provenance is written into the file
 * once and stays there forever; the chat it names archives, gets deleted by hand, or gets purged by
 * the retention window. So every branch of "what does this id point at now" is pinned here, and the
 * DEAD one hardest: a door to a chat that is gone must resolve to `gone` without touching the store,
 * must be claimed by the link handler (never handed to window.open, which would ask macOS to launch a
 * `koda://` scheme nothing serves), and must come back with something to say.
 */

// ── The href vocabulary ──────────────────────────────────────────────────────────────────────────

describe('a session href round-trips and stays strict', () => {
  it('builds and parses the canonical shape', () => {
    const href = sessionHref('7f3c-abcd')
    expect(href).toBe(`${SESSION_HREF_PREFIX}7f3c-abcd`)
    expect(parseSessionHref(href)).toBe('7f3c-abcd')
  })

  it('survives an id that needs encoding, and a markdown renderer that lowercased the scheme', () => {
    // A `source:` field is a line in a file anyone can edit, so the id is not assumed to be a UUID.
    const href = sessionHref('a b/c#d')
    expect(parseSessionHref(href)).toBe('a b/c#d')
    expect(parseSessionHref('KODA://SESSION/plain-id')).toBe('plain-id')
  })

  it('drops a trailing anchor or query the way the file resolver does', () => {
    expect(parseSessionHref('koda://session/abc#top')).toBe('abc')
    expect(parseSessionHref('koda://session/abc?x=1')).toBe('abc')
  })

  it('declines anything that is not exactly one session id', () => {
    expect(parseSessionHref('koda://session/')).toBeNull()
    expect(parseSessionHref('koda://session/a/b')).toBeNull() // nested path: not an id
    expect(parseSessionHref('koda://document/abc')).toBeNull()
    expect(parseSessionHref('koda-preview://token/index.html')).toBeNull()
    expect(parseSessionHref('https://example.com/session/abc')).toBeNull()
    expect(parseSessionHref('Documents/plans/launch.md')).toBeNull()
  })

  it('takes a stray percent literally rather than throwing', () => {
    expect(parseSessionHref('koda://session/100%done')).toBe('100%done')
  })
})

// ── The resolution ladder ────────────────────────────────────────────────────────────────────────

describe('a recorded session id resolves to one of three real answers', () => {
  const state = {
    sessions: { open: { label: 'Launch planning' } },
    archived: [{ id: 'cold', label: 'Pricing rewrite' }],
  }

  it('names a live chat', () => {
    expect(resolveSessionDoor('open', state)).toEqual({ status: 'live', label: 'Launch planning' })
  })

  it('still names an ARCHIVED chat, because the cold index keeps its label', () => {
    // The whole reason `archived` is its own answer instead of being folded into `gone`: the archive
    // splits the transcript body off, not the name, so the door still opens (by reopening it).
    expect(resolveSessionDoor('cold', state)).toEqual({ status: 'archived', label: 'Pricing rewrite' })
  })

  it('gives up on a chat that is in neither list', () => {
    expect(resolveSessionDoor('deleted', state)).toEqual({ status: 'gone' })
  })

  it('does not call a missing row deleted when the archive index failed to load', () => {
    expect(resolveSessionDoor('maybe-cold', { ...state, archiveLoadFailed: true })).toEqual({ status: 'unknown' })
    expect(doorFromLabels(undefined, undefined, true)).toEqual({ status: 'unknown' })
  })

  it('prefers the live chat when an id somehow sits in both lists', () => {
    expect(doorFromLabels('live name', 'cold name')).toEqual({ status: 'live', label: 'live name' })
  })

  it('treats an empty label as a name, not as absence', () => {
    // A chat named "" is still a chat. Falling through to `gone` here would tell the user their
    // conversation was deleted when it is sitting in the sidebar.
    expect(doorFromLabels('')).toEqual({ status: 'live', label: '' })
    expect(doorFromLabels(undefined, '')).toEqual({ status: 'archived', label: '' })
  })
})

// ── Following the door ───────────────────────────────────────────────────────────────────────────

function fakeStore(overrides: Partial<SessionDoorStore> = {}): {
  getState: () => SessionDoorStore
  select: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
} {
  const select = vi.fn()
  const restore = vi.fn(async () => {})
  const store: SessionDoorStore = {
    sessions: {},
    archived: [],
    selectSession: select,
    restoreArchived: restore,
    ...overrides,
  }
  return { getState: () => store, select, restore }
}

describe('following a session door', () => {
  it('selects a live chat', async () => {
    const { getState, select, restore } = fakeStore({ sessions: { open: { label: 'Launch' } } })
    await expect(followSession('open', getState)).resolves.toBe('opened')
    expect(select).toHaveBeenCalledWith('open')
    expect(restore).not.toHaveBeenCalled()
  })

  it('reopens an archived chat instead of dead-ending on it', async () => {
    const store: SessionDoorStore = {
      sessions: {},
      archived: [{ id: 'cold', label: 'Pricing' }],
      selectSession: vi.fn(),
      // Stand in for the real restore: the chat leaves the archive and joins the live map.
      restoreArchived: vi.fn(async () => {
        store.archived = []
        store.sessions = { cold: { label: 'Pricing' } }
      }),
    }
    await expect(followSession('cold', () => store)).resolves.toBe('reopened')
    expect(store.selectSession).not.toHaveBeenCalled() // restoreArchived already fronts it
  })

  it('reports a restore that resolved without landing the chat', async () => {
    // The real `restoreArchived` swallows an unreadable transcript and leaves the chat archived, so an
    // outcome read from the promise alone would call this a success and show the user nothing.
    const { getState, restore } = fakeStore({ archived: [{ id: 'cold', label: 'Pricing' }] })
    await expect(followSession('cold', getState)).resolves.toBe('unreadable')
    expect(restore).toHaveBeenCalledWith('cold')
  })

  it('refuses a deleted chat WITHOUT touching the store', async () => {
    const { getState, select, restore } = fakeStore()
    await expect(followSession('deleted', getState)).resolves.toBe('gone')
    expect(select).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
  })

  it('reports an unavailable archive without claiming the chat was deleted', async () => {
    const { getState, select, restore } = fakeStore({ archiveLoadFailed: true })
    await expect(followSession('maybe-cold', getState)).resolves.toBe('unavailable')
    expect(select).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
  })

  it('speaks for the dead chat and stays quiet where another surface already speaks', () => {
    expect(followRefusalCopy('gone')).toMatch(/no longer here/)
    expect(followRefusalCopy('opened')).toBeNull()
    expect(followRefusalCopy('reopened')).toBeNull()
    // `unreadable` is deliberately silent HERE: the store raises `archiveRestoreFailed` and the
    // data-integrity banner says it across the top of the window. Two voices, one failure, is noise.
    expect(followRefusalCopy('unreadable')).toBeNull()
    expect(followRefusalCopy('unavailable')).toMatch(/can't check archived chats/i)
  })
})

// ── The routing branch, end to end over the real store ───────────────────────────────────────────

/**
 * What StageLinkProvider does with an href, minus React: parse, follow, decide what to say. The value
 * of driving the REAL store here is that `restoreArchived` is a read-modify-write across two awaited
 * disk writes, and a door that only worked against a hand-written fake would be proving nothing.
 */
async function route(href: string): Promise<{ claimed: boolean; said: string | null }> {
  const sessionId = parseSessionHref(href)
  if (!sessionId) return { claimed: false, said: null }
  return { claimed: true, said: followRefusalCopy(await followSession(sessionId, useWorkspace.getState)) }
}

function archivedMeta(id: string, label: string): ArchivedSessionMeta {
  return {
    id,
    label,
    cwd: '/tmp/project',
    approvalMode: 'ask',
    engineId: 'claude',
    archivedAt: Date.now(),
    preview: [],
    maxItemId: 0,
  }
}

const ids = (list: { id: string }[]): string[] => list.map((a) => a.id)

beforeEach(() => {
  const bodies: Record<string, unknown[]> = { cold: [{ id: 1, kind: 'user', text: 'the decision' }] }
  ;(globalThis as unknown as { window: unknown }).window = {
    koda: {
      saveArchived: async () => true,
      loadArchivedBody: async (id: string) => bodies[id] ?? null,
      deleteArchivedBody: async () => {},
      gitDetect: async () => ({ isRepo: false }),
    },
  }
  useWorkspace.setState({
    sessions: {},
    order: [],
    activeId: null,
    archived: [],
    archiveRestoreFailed: false,
  })
})

describe('the StageLinks session branch', () => {
  it('leaves a project-relative doc link alone', async () => {
    expect(await route('Documents/plans/launch.md')).toEqual({ claimed: false, said: null })
  })

  it('lands the user in the live chat a document came from', async () => {
    useWorkspace.setState({
      sessions: { open: sessionStub('open', 'Launch planning') },
      order: ['open'],
      activeId: null,
    })
    expect(await route(sessionHref('open'))).toEqual({ claimed: true, said: null })
    expect(useWorkspace.getState().activeId).toBe('open')
  })

  it('reopens an archived chat and fronts it', async () => {
    useWorkspace.setState({ archived: [archivedMeta('cold', 'Pricing rewrite')] })

    expect(await route(sessionHref('cold'))).toEqual({ claimed: true, said: null })

    const after = useWorkspace.getState()
    expect(after.sessions.cold?.label).toBe('Pricing rewrite')
    expect(after.activeId).toBe('cold')
    expect(after.archived).toEqual([]) // it moved out of the cold index, not copied
  })

  it('claims a DELETED chat and says so instead of doing nothing', async () => {
    // The dead-session path. Two things have to hold at once: the href never falls through to
    // window.open (nothing on the machine serves `koda://`), and the click is not swallowed.
    const before = useWorkspace.getState()

    const { claimed, said } = await route(sessionHref('deleted-last-week'))

    expect(claimed).toBe(true)
    expect(said).toBeTruthy()
    expect(useWorkspace.getState().sessions).toEqual(before.sessions)
    expect(useWorkspace.getState().activeId).toBe(before.activeId)
  })

  it('leaves an unreadable archive to the banner that already owns that failure', async () => {
    useWorkspace.setState({ archived: [archivedMeta('shredded', 'Old thread')] })

    const { claimed, said } = await route(sessionHref('shredded'))

    expect(claimed).toBe(true)
    expect(said).toBeNull() // the door stays quiet…
    expect(useWorkspace.getState().archiveRestoreFailed).toBe(true) // …because this raises the banner
    expect(useWorkspace.getState().sessions.shredded).toBeUndefined()
    expect(ids(useWorkspace.getState().archived)).toEqual(['shredded']) // still listed, nothing lost
  })

  it('raises the same banner when the archive index refuses the restore move', async () => {
    ;(window.koda.saveArchived as unknown as ReturnType<typeof vi.fn>) = vi.fn(async () => false)
    ;(window.koda.loadArchivedBody as unknown as ReturnType<typeof vi.fn>) = vi.fn(async () => [
      { id: 1, kind: 'user', text: 'the decision' },
    ])
    useWorkspace.setState({ archived: [archivedMeta('stuck', 'Stuck archive')] })

    const { claimed, said } = await route(sessionHref('stuck'))

    expect(claimed).toBe(true)
    expect(said).toBeNull()
    expect(useWorkspace.getState().archiveRestoreFailed).toBe(true)
    expect(useWorkspace.getState().sessions.stuck).toBeUndefined()
    expect(ids(useWorkspace.getState().archived)).toEqual(['stuck'])
  })
})

/** The minimum a live session needs to exist in the store for `selectSession` to accept it. */
function sessionStub(id: string, label: string): SessionState {
  return {
    id,
    label,
    userNamed: false,
    cwd: '/tmp/project',
    items: [],
    streaming: '',
    busy: false,
    errored: false,
    draft: '',
    attachments: [],
    live: false,
    attention: false,
    approvalMode: 'ask',
    engineId: 'claude',
    spendUsd: 0,
    byModel: {},
  }
}
