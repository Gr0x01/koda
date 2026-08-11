import { useCallback, useEffect, useState } from 'react'
import type { BackupManifest, BackupStatus } from '@shared/ipc'
import { Button } from '../ui'
import { SettingsSection, SettingsRow } from './controls'
import { IconWarning } from './icons'

/**
 * Settings → Backup: the encrypted cloud copy of this project. Everything the server holds is
 * sealed on this Mac before it leaves — Koda can't read a backup, which is why the recovery code
 * matters enough to get its own warning. Dogfood-flagged: with the flag off this renders one quiet
 * inert note (the section stays visible so the product's shape reads at a glance).
 */
export function BackupSection() {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [revealMsg, setRevealMsg] = useState<string | null>(null)
  const [backups, setBackups] = useState<BackupManifest[] | null>(null)
  const [backupsError, setBackupsError] = useState(false)
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null)
  const [typedCode, setTypedCode] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setStatus(await window.koda.getBackupStatus())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const backupNow = async () => {
    setBusy(true)
    try {
      setStatus(await window.koda.backupNow())
    } catch {
      setRestoreMsg(null)
      setStatus((s) => (s ? { ...s, state: 'error', error: 'backup failed — try again' } : s))
    } finally {
      setBusy(false)
    }
  }

  const reveal = async () => {
    if (code) {
      setCode(null)
      return
    }
    setRevealMsg(null)
    // Reveal-specific wording only. The "new backups are paused" half of this state already reaches
    // the user through status.error in the row above, so repeating it here would say it twice.
    const result = await window.koda.getBackupRecoveryCode().catch(() => null)
    if (!result) {
      setRevealMsg('Koda couldn’t read the recovery code just now. Try again.')
    } else if (result.code) {
      setCode(result.code)
    } else if (result.unreadable) {
      setRevealMsg(
        'This Mac can’t open its backup key, so there’s no code to show here. If you saved your recovery code, that copy still opens the backups already in the cloud.',
      )
    } else {
      setRevealMsg('Koda couldn’t create a backup key on this Mac, so there’s no code to show yet.')
    }
  }

  const loadBackups = async () => {
    setBackupsError(false)
    try {
      setBackups(await window.koda.listCloudBackups())
    } catch {
      setBackups(null)
      setBackupsError(true)
    }
  }

  const restoreOne = async (m: BackupManifest) => {
    setRestoreMsg(null)
    const { path } = await window.koda.chooseFolder()
    if (!path) return
    setBusy(true)
    try {
      const result = await window.koda.restoreCloudBackup({
        sourceProjectHash: m.projectHash,
        targetDir: path,
        recoveryCode: typedCode.trim() || undefined,
      })
      setRestoreMsg(result.ok ? `Restored “${m.projectName}” to ${path}.` : result.error)
    } catch {
      setRestoreMsg('Restore failed — try again.')
    } finally {
      setBusy(false)
    }
  }

  // Flag off ⇒ the nav item is hidden (Settings.tsx) and this renders nothing — a teaser section
  // for a feature you can't use is for nobody (RB, 07-13). Reachable only in the hide/show race.
  if (!status || !status.enabled) return null

  const when = status?.lastBackupAt ? new Date(status.lastBackupAt).toLocaleString() : null
  const size = status?.sizeBytes ? `${(status.sizeBytes / 1024 / 1024).toFixed(1)} MB` : null

  return (
    <>
      <p className="text-[12.5px] leading-relaxed text-text-muted">
        A copy of this project, sealed on your Mac before it leaves and stored in the cloud. If this
        Mac dies, you can get your work back. No one else can open it — not even Koda. It covers
        your files, documents, and the project’s memory; local databases and build output stay
        local.
      </p>
      <SettingsSection title="This project">
        <SettingsRow
          label="Status"
          description={
            status?.signedIn
              ? 'Backs up on its own a few minutes after you finish working.'
              : 'Sign in to your Koda account (Settings → Koda account) to back up.'
          }
          control={
            status === null ? (
              <span className="text-[12.5px] text-text-muted">…</span>
            ) : status.state === 'backing-up' ? (
              <span className="text-[12.5px] text-text-muted">backing up…</span>
            ) : status.state === 'error' ? (
              // The control slot is shrink-0, so an error longer than a few words would push the row
              // out instead of wrapping — and the one that matters most (the unreadable key) is three
              // sentences.
              <span className="flex max-w-[22rem] items-start gap-1.5 text-[12.5px] leading-snug text-amber-500">
                <span className="mt-px shrink-0 [&_svg]:h-3.5 [&_svg]:w-3.5" aria-hidden>
                  <IconWarning />
                </span>
                {status.error ?? 'backup failed'}
              </span>
            ) : status.state === 'too-large' ? (
              <span className="text-[12.5px] text-amber-500">too large to back up</span>
            ) : when ? (
              <span className="text-[12.5px] text-text-muted">
                backed up {when}
                {size ? ` · ${size}` : ''}
              </span>
            ) : (
              <span className="text-[12.5px] text-text-muted">not backed up yet</span>
            )
          }
        />
        <SettingsRow
          label="Back up now"
          description="Takes a fresh sealed copy without waiting for the next automatic one."
          control={
            <Button variant="ghost" size="md" disabled={busy || !status?.signedIn} onClick={() => void backupNow()}>
              Back up now
            </Button>
          }
        />
      </SettingsSection>
      <SettingsSection title="Recovery code">
        <SettingsRow
          label="Your recovery code"
          description="The one key to your backups. Save it somewhere safe — if you lose this Mac and the code, no one can recover your backups. Not even us. That’s what keeps them private."
          control={
            <Button variant="ghost" size="md" onClick={() => void reveal()}>
              {code ? 'Hide' : 'Reveal'}
            </Button>
          }
        />
        {code && (
          <div className="select-text px-4 py-2.5 font-mono text-[12px] leading-relaxed text-text">
            {code}
          </div>
        )}
        {revealMsg && <div className="px-4 py-2.5 text-[12px] text-text-muted">{revealMsg}</div>}
      </SettingsSection>
      <SettingsSection title="Restore">
        <SettingsRow
          label="Restore a project"
          description="Each project keeps one backup — its latest. Restoring rebuilds it into a new, empty folder, including its whole undo timeline. On a new Mac, you’ll be asked for your recovery code."
          control={
            <Button variant="ghost" size="md" disabled={!status?.signedIn} onClick={() => void loadBackups()}>
              Show backed-up projects
            </Button>
          }
        />
        {backups && backups.length > 0 && (
          <SettingsRow
            label="Recovery code"
            description="Only needed on a new Mac — leave empty if you set backup up on this one."
            control={
              <input
                type="text"
                value={typedCode}
                onChange={(e) => setTypedCode(e.target.value)}
                placeholder="KODA-…"
                spellCheck={false}
                className="w-56 rounded-md border border-border bg-transparent px-2 py-1 font-mono text-[12px] text-text outline-none placeholder:text-text-muted"
              />
            }
          />
        )}
        {backupsError && (
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-[12px] text-amber-500">
            <span>Koda couldn’t load your backed-up projects. Your backups are still in the cloud.</span>
            <Button variant="ghost" size="sm" onClick={() => void loadBackups()}>
              Try again
            </Button>
          </div>
        )}
        {!backupsError && backups?.length === 0 && (
          <div className="px-4 py-2.5 text-[12px] text-text-muted">No backups on this account yet.</div>
        )}
        {backups?.map((m) => (
          <SettingsRow
            key={m.projectHash}
            label={m.projectName}
            description={`backed up ${new Date(m.lastBackupAt ?? 0).toLocaleString()} · ${((m.sizeBytes ?? 0) / 1024 / 1024).toFixed(1)} MB`}
            control={
              <Button variant="ghost" size="md" disabled={busy} onClick={() => void restoreOne(m)}>
                Restore…
              </Button>
            }
          />
        ))}
        {restoreMsg && <div className="px-4 py-2.5 text-[12px] text-text-muted">{restoreMsg}</div>}
      </SettingsSection>
    </>
  )
}
