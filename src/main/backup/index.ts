/**
 * Cloud backup orchestrator — the module's public surface (IPC calls these; nothing else reaches
 * into the siblings). Dogfood-flagged via loadBackupEnabled(); the subscription-entitlement gate
 * wires in when IAP exists (until then any signed-in account may back up — RB only, in practice).
 *
 * Failure posture mirrors safety-git maintenance: every path is fail-soft, surfaced only as a
 * status Settings can read. A backup must never block or break a turn.
 *
 * Concurrency note: bundling reads the store outside sessions.ts's per-dir checkpoint mutex. git's
 * ref updates are atomic, so the worst race is bundling the instant BEFORE a checkpoint/prune —
 * i.e. a backup that's seconds stale, which the next debounce fixes. Not worth a cross-module lock.
 */
import { readdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { log } from '../logger'
import { loadBackupEnabled, loadReplicaEnabled } from '../settings'
import { onAuthState } from '../remote/supabase-session'
import { replicaNow } from './replica'
import { bundleFingerprint, createBundle, restoreFromBundle } from './bundle'
import { backupAad, decryptBlob, encryptBlob } from './crypto'
import {
  currentUserId,
  downloadBundle,
  downloadManifest,
  listBackups,
  projectHash,
  uploadBackup,
  type BackupManifest,
} from './storage'
import { decodeRecoveryCode, encodeRecoveryCode, ensureVaultKey, getVaultKey, setVaultKey } from './vault-key'

export interface BackupStatus {
  enabled: boolean
  signedIn: boolean
  state: 'idle' | 'backing-up' | 'error' | 'too-large'
  lastBackupAt: number | null
  sizeBytes: number | null
  error?: string
}

/** Soft guard, not a quota: a sealed bundle past this is skipped + surfaced, never truncated. */
const SOFT_LIMIT_BYTES = 500 * 1024 * 1024
/** Quiet window after a moment checkpoint before bundling — coalesces a burst of turns. */
const DEBOUNCE_MS = 5 * 60_000
/** A chatty session still gets backed up at least this often. */
const CEILING_MS = 30 * 60_000

interface LocalState {
  state: BackupStatus['state']
  error?: string
  lastBackupAt: number | null
  sizeBytes: number | null
  manifestChecked: boolean
  /** When the in-flight backup started — a hung upload (dead Wi-Fi, sleep mid-send) must not wedge
   *  the project in `backing-up` forever, so past STUCK_MS the state is treated as retryable. */
  backingUpSince?: number
  /** The store's lane tips at the last successful upload — unchanged tips ⇒ identical bundle ⇒ skip. */
  lastFingerprint?: string
}

const STUCK_MS = 10 * 60_000

const states = new Map<string, LocalState>()
const timers = new Map<string, NodeJS.Timeout>()

/** Per-project upload chain: bundle + replica writers both read-merge-write the shared manifest, and
 *  the manual "Back up now" arrives outside the debounce timer — one queue per project makes the
 *  interleaving impossible instead of unlikely. Uploads never reject (both fns are fail-soft). */
const uploadChains = new Map<string, Promise<unknown>>()
function serializeUploads<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  const next = (uploadChains.get(projectDir) ?? Promise.resolve()).then(fn, fn)
  uploadChains.set(projectDir, next)
  return next
}

/** A Documents-folder watcher can request the replica lane directly without dragging the full-project
 * backup along. It still shares the per-project upload chain so manifest read-merge-write stays atomic. */
export function uploadReplicaNow(projectDir: string): Promise<unknown> {
  return serializeUploads(projectDir, async () => {
    const rs = await replicaNow(projectDir)
    registerAuthWait(projectDir, rs.error)
    return rs
  })
}

// Projects whose last backup/replica attempt failed purely because auth wasn't ready yet (boot restore
// still landing, or a transient sign-out). When the cloud sign-in recovers, sweep them instead of
// waiting for the next debounced write — which could be hours away on a quiet project.
const waitingOnAuth = new Set<string>()
let authWatchWired = false
function registerAuthWait(projectDir: string, err: string | undefined): void {
  if (err !== 'not signed in') return
  waitingOnAuth.add(projectDir)
  if (authWatchWired) return
  authWatchWired = true
  onAuthState((state) => {
    if (state !== 'signedIn' || waitingOnAuth.size === 0) return
    const dirs = [...waitingOnAuth]
    waitingOnAuth.clear()
    for (const dir of dirs) void backupNow(dir).then(() => uploadReplicaNow(dir)).catch(() => {})
  })
}

function stateFor(projectDir: string): LocalState {
  let s = states.get(projectDir)
  if (!s) {
    s = { state: 'idle', lastBackupAt: null, sizeBytes: null, manifestChecked: false }
    states.set(projectDir, s)
  }
  return s
}

/**
 * The scheduler hook — sessions.ts calls this after every MOMENT checkpoint (turn boundaries, not
 * per-tool steps). Fire-and-forget by contract: never awaited by the turn path.
 */
export function noteMomentCheckpoint(projectDir: string): void {
  if (!loadBackupEnabled() && !loadReplicaEnabled()) return
  const s = stateFor(projectDir)
  const existing = timers.get(projectDir)
  if (existing) clearTimeout(existing)
  // Unknown last-backup (first turn this run) coalesces normally rather than firing immediately.
  const sinceLast = s.lastBackupAt === null ? 0 : Date.now() - s.lastBackupAt
  const delay = sinceLast >= CEILING_MS ? 0 : Math.min(DEBOUNCE_MS, CEILING_MS - sinceLast)
  const t = setTimeout(() => {
    timers.delete(projectDir)
    void backupNow(projectDir).then(() => uploadReplicaNow(projectDir)).catch(() => {})
  }, delay)
  t.unref?.()
  timers.set(projectDir, t)
}

/** Bundle → seal → upload. Rides the per-project upload chain; the `backing-up` state additionally
 *  drops a second call while one runs (the debounce re-arms on the next turn anyway). */
export async function backupNow(projectDir: string): Promise<BackupStatus> {
  await serializeUploads(projectDir, () => runBackup(projectDir))
  return getBackupStatus(projectDir)
}

async function runBackup(projectDir: string): Promise<void> {
  const s = stateFor(projectDir)
  if (!loadBackupEnabled()) return
  if (s.state === 'backing-up' && Date.now() - (s.backingUpSince ?? 0) < STUCK_MS) return

  s.state = 'backing-up'
  s.backingUpSince = Date.now()
  s.error = undefined
  try {
    const userId = await currentUserId()
    if (!userId) throw new Error('not signed in')
    const key = ensureVaultKey()
    if (!key) throw new Error('could not create or read the vault key')

    // The debounce now also arms on no-op checkpoints (for the replica's sake) — unchanged lane
    // tips mean a byte-equivalent bundle, so don't re-seal and re-upload half a gig of it.
    const fingerprint = await bundleFingerprint(projectDir)
    if (fingerprint !== null && fingerprint === s.lastFingerprint) {
      s.state = 'idle'
      return
    }

    const bundle = await createBundle(projectDir)
    if (!bundle) {
      // Nothing checkpointed yet — not an error, just nothing to protect.
      s.state = 'idle'
      return
    }
    // Size-check the plaintext (sealing adds a fixed 29 bytes) so an over-limit bundle never
    // holds two half-gig buffers in memory just to be rejected.
    if (bundle.length > SOFT_LIMIT_BYTES) {
      s.state = 'too-large'
      s.sizeBytes = bundle.length
      return
    }
    const hash = await projectHash(projectDir)
    const sealed = encryptBlob(bundle, backupAad(hash), key)
    const manifest = await uploadBackup(userId, hash, projectDir, sealed)
    s.state = 'idle'
    s.lastBackupAt = manifest.lastBackupAt ?? null
    s.sizeBytes = manifest.sizeBytes ?? null
    s.manifestChecked = true
    s.lastFingerprint = fingerprint ?? undefined
  } catch (err) {
    s.state = 'error'
    s.error = err instanceof Error ? err.message : String(err)
    registerAuthWait(projectDir, s.error) // retry this project the moment sign-in recovers
    log.warn('backup', 'backup failed', s.error)
  }
}

/** Status for Settings. First call per run pulls the manifest so "last backed up" survives an app
 *  restart without a local sidecar (one small GET, only when the section actually asks). */
export async function getBackupStatus(projectDir: string): Promise<BackupStatus> {
  const s = stateFor(projectDir)
  const enabled = loadBackupEnabled()
  const userId = enabled ? await currentUserId().catch(() => null) : null
  if (enabled && userId && !s.manifestChecked && s.state !== 'backing-up') {
    s.manifestChecked = true
    try {
      const manifest = await downloadManifest(userId, await projectHash(projectDir))
      if (manifest) {
        s.lastBackupAt = manifest.lastBackupAt ?? null
        s.sizeBytes = manifest.sizeBytes ?? null
      }
    } catch {
      /* listing metadata is best-effort */
    }
  }
  return {
    enabled,
    signedIn: userId !== null,
    state: s.state,
    lastBackupAt: s.lastBackupAt,
    sizeBytes: s.sizeBytes,
    error: s.error,
  }
}

/** The whole secret, shown only on a user-initiated reveal. Never logged. */
export function revealRecoveryCode(): string | null {
  const key = ensureVaultKey()
  return key ? encodeRecoveryCode(key) : null
}

export async function listCloudBackups(): Promise<BackupManifest[]> {
  const userId = await currentUserId()
  if (!userId) return []
  // Restore picker only — a replica-only manifest has no bundle to restore from.
  return (await listBackups(userId)).filter((m) => m.lastBackupAt !== undefined)
}

/**
 * Disaster recovery: pull a project's sealed bundle and rebuild it into a FRESH directory.
 * `recoveryCode` covers the fresh-Mac case (no local vault key); when given AND valid it also
 * becomes this Mac's vault key, so subsequent backups keep working. The AAD is the SOURCE
 * project's hash (from the picker) — the target path is a new identity on purpose.
 */
export async function restoreCloudBackup(args: {
  sourceProjectHash: string
  targetDir: string
  recoveryCode?: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const userId = await currentUserId()
    if (!userId) return { ok: false, error: 'Sign in first — backups belong to your account.' }
    if (!isAbsolute(args.targetDir)) return { ok: false, error: 'Pick a folder with the folder picker.' }

    const localKey = getVaultKey()
    let key = localKey
    if (args.recoveryCode?.trim()) {
      const decoded = decodeRecoveryCode(args.recoveryCode)
      if (!decoded) return { ok: false, error: 'That recovery code isn’t valid — check it for typos.' }
      key = decoded
    }
    if (!key) return { ok: false, error: 'No key on this Mac — enter your recovery code.' }

    // Restore never writes over existing work — the target must be absent or an empty folder
    // (bundle.ts separately refuses a dir that already has a safety store; this catches the rest).
    const entries = await readdir(args.targetDir).catch(() => null)
    if (entries && entries.length > 0) {
      return { ok: false, error: 'Pick an empty folder — restore won’t write over existing files.' }
    }

    const sealed = await downloadBundle(userId, args.sourceProjectHash)
    let bundle: Buffer
    try {
      bundle = decryptBlob(sealed, backupAad(args.sourceProjectHash), key)
    } catch {
      return { ok: false, error: 'That key doesn’t open this backup — wrong recovery code?' }
    }
    await restoreFromBundle(args.targetDir, bundle)
    // A typed code becomes this Mac's key ONLY when there wasn't one — overwriting an existing key
    // would strand every blob it sealed (and "Reveal" would start showing someone else's code).
    if (args.recoveryCode && key && !localKey) setVaultKey(key)
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn('backup', 'restore failed', msg)
    return { ok: false, error: msg }
  }
}
