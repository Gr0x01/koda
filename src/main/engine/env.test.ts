import { describe, expect, it } from 'vitest'
import { buildEngineEnv } from './env'

describe('Claude delegation environment', () => {
  it('keeps the background subsystem enabled while bounding explicit leaves', () => {
    const env = buildEngineEnv({ HOME: '/tmp/koda-home', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' })
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeUndefined()
    expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe('3')
    expect(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe('1')
  })
})
