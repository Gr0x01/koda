import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// loadProviderStatusNotify gates the server-side push registration; keep it on for these tests.
vi.mock('../settings', () => ({ loadProviderStatusNotify: () => true }))
vi.mock('../logger', () => ({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }))

import {
  currentProviderStatus,
  noteProviderError,
  noteTurnOk,
  refreshProviderStatus,
  setStatusWatchHooks,
} from './status-watch'

// A Statuspage-format summary the module's checkFeed understands. `component` is the Claude API component
// status ('operational' = healthy; 'major_outage' / 'degraded_performance' / … = trouble of that severity).
function summary(component: string) {
  const down = component !== 'operational'
  return {
    ok: true,
    json: async () => ({
      status: { indicator: down ? 'major' : 'none' },
      components: [{ name: 'Claude API', status: component }],
      incidents: down ? [{ name: 'Elevated errors' }] : [],
    }),
  }
}

let feedComponent = 'operational'
const hooks = {
  broadcast: vi.fn(),
  registerRemoteWatch: vi.fn(async () => false), // no phone paired → recovery pings directly
  cancelRemoteWatch: vi.fn(async () => {}),
  phonePush: vi.fn(),
}

const isDown = (engine: string) => currentProviderStatus().find((s) => s.engine === engine)?.down

// Feed an error and let the async fast-path feed check settle.
async function error(engine: string): Promise<void> {
  noteProviderError(engine)
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  feedComponent = 'operational'
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => summary(feedComponent)),
  )
  Object.values(hooks).forEach((h) => h.mockClear())
  setStatusWatchHooks(hooks)
})

afterEach(() => {
  // Drain any lingering watch so module-level state doesn't leak between tests.
  noteTurnOk('claude')
  noteTurnOk('codex')
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setStatusWatchHooks(null)
})

describe('provider outage watch — one failed turn, no retrying', () => {
  it('watches silently on a single error while the page is green, then surfaces + pings once the feed catches up', async () => {
    // One failed message, page still green: a background watch starts but shows NOTHING.
    await error('claude')
    expect(isDown('claude')).toBeUndefined() // nothing surfaced
    expect(hooks.broadcast).not.toHaveBeenCalled() // no pill
    expect(hooks.registerRemoteWatch).not.toHaveBeenCalled() // no server push while unconfirmed
    expect(hooks.phonePush).not.toHaveBeenCalled()

    // The page catches up minutes later — a poll confirms it, and only now does it go visible.
    feedComponent = 'major_outage'
    await vi.advanceTimersByTimeAsync(60_000)
    expect(isDown('claude')).toBe(true)
    expect(hooks.registerRemoteWatch).toHaveBeenCalledWith('claude')
    expect(hooks.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'claude', down: true }),
    )

    // Recovery: feed goes green after a confirmed-down watch → one "back up" ping.
    feedComponent = 'operational'
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hooks.phonePush).toHaveBeenCalledTimes(1)
    expect(hooks.phonePush.mock.calls[0][0]).toContain('Claude is back up')
    expect(isDown('claude')).toBeUndefined()
  })

  it('forgets a lone blip silently when the page never corroborates — no pill, no ping', async () => {
    await error('codex') // one error, feed stays green the whole time
    await vi.advanceTimersByTimeAsync(21 * 60_000) // past the grace window

    expect(isDown('codex')).toBeUndefined() // watch dropped
    expect(hooks.broadcast).not.toHaveBeenCalled() // never surfaced anything
    expect(hooks.phonePush).not.toHaveBeenCalled() // and never a false "back up"
    expect(hooks.registerRemoteWatch).not.toHaveBeenCalled()
  })

  it('surfaces immediately when the page is already red, and pings once on recovery', async () => {
    feedComponent = 'major_outage'
    await error('claude') // fast path sees a red feed → visible + server push at once

    expect(isDown('claude')).toBe(true)
    expect(hooks.registerRemoteWatch).toHaveBeenCalledWith('claude')
    expect(hooks.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'claude', down: true, kind: 'outage' }),
    )

    feedComponent = 'operational'
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hooks.phonePush).toHaveBeenCalledTimes(1)
    expect(hooks.phonePush.mock.calls[0][0]).toContain('Claude is back up')
    expect(isDown('claude')).toBeUndefined()
  })

  it('clears a surfaced incident on arrival when it resolved while we could not poll (Mac asleep)', async () => {
    feedComponent = 'major_outage'
    await error('claude') // confirmed, chip amber, server push registered
    expect(isDown('claude')).toBe(true)

    // It recovered while the Mac slept — no local poll ran. On wake, the focus refresh sees a green feed.
    feedComponent = 'operational'
    hooks.phonePush.mockClear()
    await refreshProviderStatus(['claude'])
    await vi.advanceTimersByTimeAsync(0)

    expect(isDown('claude')).toBeUndefined() // cleared at once, not stuck amber until the next 60s poll
    expect(hooks.phonePush).not.toHaveBeenCalled() // silent — the server already handled any ping
  })

  it('reports the honest severity — a slowdown surfaces as degraded, not an outage', async () => {
    feedComponent = 'degraded_performance'
    await error('claude')

    expect(isDown('claude')).toBe(true)
    expect(hooks.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'claude', down: true, kind: 'degraded' }),
    )
    // Never overstated as an outage.
    expect(hooks.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'outage' }))
  })
})
