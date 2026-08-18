import { describe, expect, it } from 'vitest'
import {
  HERMETIC_E2E_BLOCK_REASON,
  appNameFor,
  isE2EProfile,
  isHermeticE2EProfile,
  requireRealAccountAccess,
  runtimeProfile,
} from './runtime-profile'

describe('runtime profile', () => {
  it('keeps the built app, dev shell, and built E2E shell distinct', () => {
    expect(runtimeProfile({})).toBe('app')
    expect(runtimeProfile({ ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173' })).toBe('dev')
    expect(runtimeProfile({ KODA_APP_PROFILE: 'e2e', ELECTRON_RENDERER_URL: 'ignored' })).toBe('e2e')

    expect(appNameFor('app')).toBe('Koda')
    expect(appNameFor('dev')).toBe('Koda Dev')
    expect(appNameFor('e2e')).toBe('Koda E2E')
  })

  it('opens account access only for the explicit Mac-account assay', () => {
    expect(isE2EProfile({ KODA_APP_PROFILE: 'e2e' })).toBe(true)
    expect(isHermeticE2EProfile({ KODA_APP_PROFILE: 'e2e' })).toBe(true)
    expect(isHermeticE2EProfile({ KODA_APP_PROFILE: 'e2e', KODA_E2E_REAL_ACCOUNTS: '1' })).toBe(false)
    expect(() => requireRealAccountAccess({ KODA_APP_PROFILE: 'e2e' })).toThrow(HERMETIC_E2E_BLOCK_REASON)
    expect(() =>
      requireRealAccountAccess({ KODA_APP_PROFILE: 'e2e', KODA_E2E_REAL_ACCOUNTS: '1' }),
    ).not.toThrow()
  })
})
