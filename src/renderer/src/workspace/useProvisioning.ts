import { useEffect, useState } from 'react'
import type { PlaywrightStatus, RuntimeId, RuntimeProgress, RuntimeStatus } from '@shared/ipc'

/**
 * Shared toolkit-provisioning logic — the status + install-progress IPC wiring used by BOTH the
 * onboarding wizard's toolkit step and Settings → Toolkit. The two surfaces PRESENT it differently
 * (a wizard capability card vs a settings row + progress bar), so only the control logic lives here,
 * not the markup. Adding a runtime/capability to one surface no longer means duplicating its wiring.
 */

/** A provisionable runtime (Node / Python): live status + install progress, filtered to this runtime. */
export function useRuntime(id: RuntimeId): {
  status: RuntimeStatus | null
  progress: RuntimeProgress | null
  ready: boolean
  installing: boolean
  error: string | null
  install: () => void
} {
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [progress, setProgress] = useState<RuntimeProgress | null>(null)

  useEffect(() => {
    window.koda.getRuntimeStatus(id).then(setStatus).catch(() => {})
    return window.koda.onRuntimeProgress((e) => {
      if (e.runtime !== id) return // each consumer tracks only its own runtime
      setProgress(e)
      if (e.phase === 'done' || e.phase === 'error') window.koda.getRuntimeStatus(id).then(setStatus).catch(() => {})
    })
  }, [id])

  const ready = status?.state === 'system' || status?.state === 'installed'
  const installing =
    status?.state === 'installing' ||
    (progress != null && progress.phase !== 'done' && progress.phase !== 'error')
  const error = progress?.phase === 'error' ? progress.message : null

  const install = (): void => {
    // Optimistic 'download' so a progress UI shows immediately; real phases stream in over IPC.
    setProgress({ runtime: id, phase: 'download', message: 'Starting…', progress: 0 })
    window.koda.installRuntime(id).catch(() => {})
  }

  return { status, progress, ready, installing, error, install }
}

/** Browser-testing (Playwright) capability: enabled/ready/installing + a toggle that kicks the install. */
export function useBrowserTesting(): {
  pw: PlaywrightStatus | null
  enabled: boolean
  ready: boolean
  installing: boolean
  toggle: (next: boolean) => void
} {
  const [pw, setPw] = useState<PlaywrightStatus | null>(null)

  useEffect(() => {
    window.koda.playwrightStatus().then(setPw).catch(() => {})
    return window.koda.onPlaywrightProgress(setPw) // download state + log lines
  }, [])

  const enabled = pw?.enabled ?? false
  const ready = enabled && pw?.state === 'ready'
  const installing = enabled && pw?.state === 'installing'

  const toggle = (next: boolean): void => {
    setPw((p) => ({ state: p?.state ?? 'not-installed', enabled: next, message: p?.message })) // optimistic
    window.koda.updateSettings({ playwrightEnabled: next }).catch(console.error)
    if (next) window.koda.enablePlaywright().then(setPw).catch(console.error) // start the download
  }

  return { pw, enabled, ready, installing, toggle }
}
