import { describe, expect, it } from 'vitest'
import { codexAuthStatusFromProbe } from './codex-auth'

describe('codex auth status', () => {
  it('does not report a failed probe as confirmed sign-out', () => {
    expect(codexAuthStatusFromProbe(null)).toEqual({
      signedIn: false,
      authMethod: null,
      requiresOpenaiAuth: null,
      probeFailed: true,
    })
  })

  it('keeps a healthy signed-out answer distinct from probe failure', () => {
    expect(codexAuthStatusFromProbe({ authMethod: null, requiresOpenaiAuth: true })).toEqual({
      signedIn: false,
      authMethod: null,
      requiresOpenaiAuth: true,
      probeFailed: false,
    })
  })
})
