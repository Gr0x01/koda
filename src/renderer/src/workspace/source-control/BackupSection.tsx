import type { GitSyncState } from '@shared/ipc'
import { Button } from '../../ui'
import { useWorkspace } from '../store'
import { Section } from './shared'

/**
 * "This project isn't on GitHub yet" — the one backup state the timeline's seam can't carry, because
 * there's no boundary to draw when there's no remote at all. Everything else about pushed-vs-local
 * (the boundary, the push button, a failed push) lives on the seam in VersionTimeline, where the fact
 * actually is. Publishing is a conversation — account, repo name, private or public — so the whole
 * thing is handed to the agent rather than turned into a form.
 *
 * Renders nothing once a remote exists.
 */
export function BackupSection({
  sync,
  onLeave,
}: {
  sync: GitSyncState
  onLeave: () => void
}) {
  const sendBackupAction = useWorkspace((s) => s.sendBackupAction)
  const anyBusy = useWorkspace((s) => Object.values(s.sessions).some((sess) => sess.busy))
  const hasSession = useWorkspace((s) => !!s.activeId)
  const canAsk = hasSession && !anyBusy

  if (sync.hasRemote) return null

  async function askAgent(): Promise<void> {
    const ok = await sendBackupAction({ kind: 'publish' })
    if (ok) onLeave() // back to the workspace to watch the agent (same as branch Review)
  }

  return (
    <Section label="GitHub">
      <div className="px-3 pb-2">
        <p className="text-[11px] leading-relaxed text-text-muted">
          Your versions only exist on this computer. Publish them to GitHub so they're safe if
          anything happens to it.
        </p>
        <Button
          variant="secondary"
          onClick={() => void askAgent()}
          disabled={!canAsk}
          title={
            !hasSession
              ? 'Open a session first'
              : anyBusy
                ? 'Wait for the agent to finish first'
                : undefined
          }
          className="mt-2 w-full justify-center"
        >
          Publish to GitHub…
        </Button>
        <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted/70">
          Your agent sets it up with you, including a GitHub account if you don't have one yet.
        </p>
      </div>
    </Section>
  )
}
