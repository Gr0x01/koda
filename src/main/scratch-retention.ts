/**
 * Time-based scratch retention for projects that stay open and quiet. Save/list/settings paths prune
 * at their natural boundaries; this small governed sweep closes the remaining gap when a file crosses
 * its age limit without any of those actions.
 */
import { IpcChannels } from '@shared/channels'
import { governProbe, type GovernedProbe } from './probe-governor'
import { pruneScratch, saveScratchImage } from './scratch'
import { loadScratchRetentionDays } from './settings'
import { openProjectPaths, windowForProject } from './window-registry'
import { log } from './logger'

/** Tight while Koda is in use; the probe governor stretches/pauses it while nobody is watching. */
export const SCRATCH_RETENTION_SWEEP_MS = 15 * 60_000

let timer: ReturnType<typeof setInterval> | null = null
let probe: GovernedProbe | null = null
let scheduledSweepRunning = false
let retentionLane: Promise<void> = Promise.resolve()

/**
 * Serialize every production prune with retention-setting persistence. In particular, switching from
 * one day to Forever waits for an already-started one-day prune before persisting the new policy, so
 * no stale sweep can unlink a file after the preference says it should be kept.
 */
function inRetentionLane<T>(work: () => Promise<T> | T): Promise<T> {
  const run = retentionLane.then(work, work)
  retentionLane = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function sweepOpenUnlocked(retentionDays: number): Promise<number> {
  const results = await Promise.all(
    openProjectPaths().map(async (root) => ({
      root,
      removed: await pruneScratch(root, retentionDays),
    })),
  )
  let total = 0
  for (const { root, removed } of results) {
    total += removed
    if (removed === 0) continue
    const win = windowForProject(root)
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(IpcChannels.scratchChanged)
    } catch (err) {
      log.warn('scratch', 'retention refresh failed', err instanceof Error ? err.message : err)
    }
  }
  return total
}

/** Apply one retention value to every open project and refresh only windows whose files changed. */
export async function sweepOpenScratchRetention(
  retentionDays?: number,
): Promise<number> {
  probe?.ran()
  return inRetentionLane(() => sweepOpenUnlocked(retentionDays ?? loadScratchRetentionDays()))
}

/** Persist a changed retention policy and apply it atomically with respect to every other prune. */
export async function applyScratchRetentionSetting<T extends { scratchRetentionDays: number }>(
  persist: () => T,
): Promise<T> {
  probe?.ran()
  return inRetentionLane(async () => {
    const next = persist()
    await sweepOpenUnlocked(next.scratchRetentionDays)
    return next
  })
}

/** First-page cleanup uses the live policy and shares the same policy-change lane. */
export async function pruneProjectScratch(projectRoot: string): Promise<number> {
  probe?.ran()
  return inRetentionLane(() => pruneScratch(projectRoot, loadScratchRetentionDays()))
}

/** Save-time cleanup and the write are one lane operation, so a policy change cannot overtake them. */
export async function saveScratchWithRetention(
  projectRoot: string,
  mediaType: string,
  dataBase64: string,
  fileName?: string,
): Promise<string> {
  probe?.ran()
  return inRetentionLane(() =>
    saveScratchImage(projectRoot, mediaType, dataBase64, loadScratchRetentionDays(), fileName),
  )
}

async function runScheduledSweep(): Promise<void> {
  if (scheduledSweepRunning) return
  scheduledSweepRunning = true
  try {
    await sweepOpenScratchRetention()
  } catch (err) {
    log.warn('scratch', 'retention sweep failed', err instanceof Error ? err.message : err)
  } finally {
    scheduledSweepRunning = false
  }
}

/** Start the app-lifetime sweep. Safe to call twice; the returned function owns the one live timer. */
export function startScratchRetentionSweep(): () => void {
  const stop = (): void => {
    if (timer) clearInterval(timer)
    timer = null
    probe?.release()
    probe = null
  }
  if (timer) return stop

  probe = governProbe('scratch-retention', SCRATCH_RETENTION_SWEEP_MS, {
    wake: () => void runScheduledSweep(),
  })
  timer = setInterval(() => {
    if (probe?.due()) void runScheduledSweep()
  }, SCRATCH_RETENTION_SWEEP_MS)
  return stop
}
