import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * `lazy()` for chunks that can transiently fail to fetch. A dynamic `import()` rejects when Vite
 * re-optimizes deps mid-session (dev) or a shipped build's chunk hash goes stale after an update —
 * the module graph is fine on a *fresh* fetch, the one in flight just lost the race. React's Suspense
 * doesn't catch that reject, so without a retry it throws straight to the error boundary and the user
 * has to reload by hand.
 *
 * So retry the import a couple times with a short backoff before giving up. This self-heals the common
 * dev re-optimize race invisibly; anything that still fails after the retries falls through to the
 * boundary, which offers a Reload. Drop-in replacement for `lazy` — same signature.
 */
/** Run a dynamic-import factory, retrying on reject with a short linear backoff. Rethrows the last
 *  error once all attempts are spent. Split out from `lazy` so the retry contract is unit-testable. */
export async function importWithRetry<M>(factory: () => Promise<M>, retries = 2): Promise<M> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await factory()
    } catch (err) {
      lastErr = err
      if (attempt < retries) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
    }
  }
  throw lastErr
}

export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  retries = 2,
): LazyExoticComponent<T> {
  return lazy(() => importWithRetry(factory, retries))
}
