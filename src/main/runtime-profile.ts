/**
 * Runtime identity for the three ways the desktop shell is launched.
 *
 * `dev` is still selected by electron-vite's renderer URL because that controls HMR/CSP behavior.
 * `e2e` is explicit: Playwright launches the built app, so it must retain the strict built-app CSP
 * while getting its own name, logs, credential posture, and autonomous-work policy.
 */
export type RuntimeProfile = 'app' | 'dev' | 'e2e'

export function runtimeProfile(env: NodeJS.ProcessEnv = process.env): RuntimeProfile {
  if (env.KODA_APP_PROFILE === 'e2e') return 'e2e'
  return env.ELECTRON_RENDERER_URL ? 'dev' : 'app'
}

export function appNameFor(profile: RuntimeProfile): 'Koda' | 'Koda Dev' | 'Koda E2E' {
  if (profile === 'e2e') return 'Koda E2E'
  return profile === 'dev' ? 'Koda Dev' : 'Koda'
}

export function isE2EProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return runtimeProfile(env) === 'e2e'
}

/** The ordinary E2E lane never reads account credentials. The one explicit Mac-account assay opts in. */
export function isHermeticE2EProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return isE2EProfile(env) && env.KODA_E2E_REAL_ACCOUNTS !== '1'
}

export const HERMETIC_E2E_BLOCK_REASON =
  'Real accounts and engine processes are disabled in hermetic Koda E2E.'

/** Main-process authorization seam for anything that can authenticate, persist a credential, or bill. */
export function requireRealAccountAccess(env: NodeJS.ProcessEnv = process.env): void {
  if (isHermeticE2EProfile(env)) throw new Error(HERMETIC_E2E_BLOCK_REASON)
}
