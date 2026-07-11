import { Button } from '../../ui'
import { useWorkspace } from '../store'

// The one state where "Save a version" quietly does something unexpected: new versions land on the
// side branch, not the main line. Say so plainly, and offer the finish (review → merge → switch
// back) as an agent conversation — merging is never a button-driven git op here.
export function SideBranchBanner({
  branch,
  trunk,
  onLeave,
}: {
  branch: string
  trunk: string
  onLeave: () => void
}) {
  const sendFinishBranch = useWorkspace((s) => s.sendFinishBranch)
  const anyBusy = useWorkspace((s) => Object.values(s.sessions).some((sess) => sess.busy))
  const hasSession = useWorkspace((s) => !!s.activeId)
  const canAsk = hasSession && !anyBusy

  async function askClaude(): Promise<void> {
    const ok = await sendFinishBranch({ branch, into: trunk })
    if (ok) onLeave() // back to the workspace to watch the agent
  }

  return (
    <div className="border-b border-border px-3 py-3">
      <div className="rounded-lg border border-accent/25 bg-accent/[0.07] px-2.5 py-2">
        <p className="text-[11.5px] leading-snug text-text-muted">
          <b className="font-semibold text-text">You're on a side branch.</b> New versions save to{' '}
          <span className="font-mono text-text">{branch}</span>, not{' '}
          <span className="font-mono">{trunk}</span>.
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void askClaude()}
          disabled={!canAsk}
          title={
            !hasSession
              ? 'Open a session first'
              : anyBusy
                ? 'Wait for the agent to finish first'
                : `Claude reviews the branch, merges it into ${trunk}, and switches you back`
          }
          className="mt-1.5 text-accent hover:opacity-80 disabled:opacity-50"
        >
          Ask Claude to finish it into {trunk} →
        </Button>
      </div>
    </div>
  )
}
