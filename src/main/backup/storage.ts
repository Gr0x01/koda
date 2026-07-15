/**
 * Supabase Storage door for backups — the ONLY file that talks to the bucket, so the blind-E2E
 * invariant has one seam: everything uploaded here is ciphertext from crypto.ts, plus a small
 * plaintext manifest that carries METADATA ONLY (name/time/size — the same class of metadata
 * rc_devices already holds; never file content, never readable bytes).
 *
 * Layout (owner-only storage policies; see the `backups` bucket migration):
 *   backups/{user_id}/{project_hash}/bundle.enc    — the sealed safety-git bundle, overwritten in place
 *   backups/{user_id}/{project_hash}/replica.enc   — the sealed docs snapshot the phone reads offline
 *   backups/{user_id}/{project_hash}/manifest.json — listing metadata for Settings + the phone replica
 *
 * One object per project, overwritten: cloud backup is disaster recovery, not a second undo stack —
 * point-in-time recovery is the local timeline's job, and the bundle itself carries that timeline.
 */
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import { getSupabase } from '../remote/supabase-client'

const BUCKET = 'backups'

export interface BackupManifest {
  schemaVersion: 1
  projectHash: string
  /** Display label (last path segment) so a device can list "koda", not hashes. Metadata, not content. */
  projectName: string
  /** Full-project bundle fields — absent when only the docs replica has uploaded. */
  lastBackupAt?: number
  sizeBytes?: number
  /** Docs-replica fields — absent when only the bundle has uploaded. A COUNT, never a listing:
   *  anything file-shaped (names, paths, the skipped list) lives inside the sealed blob. */
  replicaAt?: number
  replicaSizeBytes?: number
  docCount?: number
}

/** Stable per-project identity: hash of the resolved absolute path. 64 bits is plenty at any
 *  plausible per-user project count, and it keeps the real path off the server. */
export async function projectHash(projectDir: string): Promise<string> {
  const real = await realpath(projectDir).catch(() => projectDir)
  return createHash('sha256').update(real).digest('hex').slice(0, 16)
}

/** The signed-in user's id, or null (backup requires the same Supabase account remote control uses). */
export async function currentUserId(): Promise<string | null> {
  const { data } = await getSupabase().auth.getSession()
  return data.session?.user.id ?? null
}

/** Read-merge-write the manifest so bundle and replica uploads never clobber each other's fields.
 *  Both writers run through backup/index.ts's per-project upload chain, so the read can't go stale
 *  under a concurrent write (the manual "Back up now" rides the same chain). */
async function patchManifest(
  userId: string,
  hash: string,
  projectDir: string,
  patch: Partial<BackupManifest>,
): Promise<BackupManifest> {
  const existing = await downloadManifest(userId, hash)
  const manifest: BackupManifest = {
    ...(existing ?? {}),
    schemaVersion: 1,
    projectHash: hash,
    projectName: basename(projectDir),
    ...patch,
  }
  const { error } = await getSupabase()
    .storage.from(BUCKET)
    .upload(`${userId}/${hash}/manifest.json`, Buffer.from(JSON.stringify(manifest)), {
      upsert: true,
      contentType: 'application/json',
    })
  if (error) throw new Error(`manifest upload failed: ${error.message}`)
  return manifest
}

export async function uploadBackup(
  userId: string,
  hash: string,
  projectDir: string,
  sealed: Buffer,
): Promise<BackupManifest> {
  const storage = getSupabase().storage.from(BUCKET)
  const { error: blobErr } = await storage.upload(`${userId}/${hash}/bundle.enc`, sealed, {
    upsert: true,
    contentType: 'application/octet-stream',
  })
  if (blobErr) throw new Error(`bundle upload failed: ${blobErr.message}`)
  return patchManifest(userId, hash, projectDir, { lastBackupAt: Date.now(), sizeBytes: sealed.length })
}

export async function uploadReplica(
  userId: string,
  hash: string,
  projectDir: string,
  sealed: Buffer,
  docCount: number,
): Promise<BackupManifest> {
  const storage = getSupabase().storage.from(BUCKET)
  const { error: blobErr } = await storage.upload(`${userId}/${hash}/replica.enc`, sealed, {
    upsert: true,
    contentType: 'application/octet-stream',
  })
  if (blobErr) throw new Error(`replica upload failed: ${blobErr.message}`)
  return patchManifest(userId, hash, projectDir, {
    replicaAt: Date.now(),
    replicaSizeBytes: sealed.length,
    docCount,
  })
}

export async function downloadManifest(userId: string, hash: string): Promise<BackupManifest | null> {
  const { data, error } = await getSupabase()
    .storage.from(BUCKET)
    .download(`${userId}/${hash}/manifest.json`)
  if (error || !data) return null
  try {
    return JSON.parse(await data.text()) as BackupManifest
  } catch {
    return null
  }
}

export async function downloadBundle(userId: string, hash: string): Promise<Buffer> {
  const { data, error } = await getSupabase().storage.from(BUCKET).download(`${userId}/${hash}/bundle.enc`)
  if (error || !data) throw new Error(`bundle download failed: ${error?.message ?? 'no data'}`)
  return Buffer.from(await data.arrayBuffer())
}

/** Every backed-up project for this account — the restore picker (and, later, the phone replica list). */
export async function listBackups(userId: string): Promise<BackupManifest[]> {
  const storage = getSupabase().storage.from(BUCKET)
  const { data, error } = await storage.list(userId, { limit: 200 })
  if (error || !data) return []
  const manifests = await Promise.all(
    data.filter((e) => e.name && !e.name.includes('.')).map((e) => downloadManifest(userId, e.name)),
  )
  return manifests
    .filter((m): m is BackupManifest => m !== null)
    .sort((a, b) => (b.lastBackupAt ?? b.replicaAt ?? 0) - (a.lastBackupAt ?? a.replicaAt ?? 0))
}
