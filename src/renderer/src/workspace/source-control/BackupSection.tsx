import { useState } from 'react'
import type { GitPushResult, GitSyncState } from '@shared/ipc'
import { Button } from '../../ui'
import { useWorkspace } from '../store'
import { UploadGlyph } from './icons'
import { Section } from './shared'

// The "is this on GitHub, or only on my Mac?" answer, in three states: no remote (→ Publish, a
// conversation the agent owns), versions to push (→ one-click Push to GitHub), in sync (a quiet
// green fact). A failed push is routed to the agent with the raw error — never a git lesson here.
export function BackupSection({
  sync,
  onPushed,
  onRecheck,
  onLeave,
}: {
  sync: GitSyncState
  onPushed: () => void
  onRecheck: () => void
  onLeave: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Extract<GitPushResult, { ok: false }> | null>(null)
  const sendBackupAction = useWorkspace((s) => s.sendBackupAction)
  const anyBusy = useWorkspace((s) => Object.values(s.sessions).some((sess) => sess.busy))
  const hasSession = useWorkspace((s) => !!s.activeId)
  const canAsk = hasSession && !anyBusy

  async function push(): Promise<void> {
    setBusy(true)
    setFailure(null)
    try {
      const res = await window.koda.gitPush()
      if (res.ok) onPushed()
      else setFailure(res)
    } catch (err) {
      setFailure({ ok: false, code: 'git_failed', message: String(err) })
      console.error('gitPush failed', err)
    } finally {
      setBusy(false)
    }
  }

  async function askClaude(kind: 'publish' | 'fixPush'): Promise<void> {
    const ok = await sendBackupAction(
      kind === 'publish' ? { kind } : { kind, error: failure?.message ?? 'unknown error' },
    )
    if (ok) onLeave() // back to the workspace to watch the agent (same as branch Review)
  }

  const destination = sync.remoteUrl ? shortRemote(sync.remoteUrl) : sync.remoteName

  return (
    <Section label="GitHub">
      <div className="px-3 pb-2">
        {!sync.hasRemote ? (
          // No remote: the versions live only on this machine. Publishing is a conversation
          // (account, repo name, private/public) — hand the whole thing to the agent.
          <>
            <p className="text-[11px] leading-relaxed text-text-muted">
              Your versions only exist on this computer. Publish them to GitHub so they're safe if
              anything happens to it.
            </p>
            <Button
              variant="secondary"
              onClick={() => void askClaude('publish')}
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
              Claude sets it up with you — including a GitHub account, if you don't have one yet.
            </p>
          </>
        ) : sync.ahead > 0 ? (
          <>
            <button
              onClick={() => void push()}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px] font-medium text-text transition-colors hover:border-accent/40 disabled:opacity-50"
            >
              <UploadGlyph />
              {busy ? 'Pushing…' : 'Push to GitHub'}
              <span className="text-text-muted">
                {sync.ahead} {sync.ahead === 1 ? 'version' : 'versions'}
              </span>
            </button>
            {sync.verified
              ? destination && (
                  <p
                    className="mt-1.5 truncate text-[11px] text-text-muted/70"
                    title={sync.remoteUrl ?? undefined}
                  >
                    to {destination}
                  </p>
                )
              : (
                  <UnconfirmedNote
                    prefix="Couldn't reach GitHub — this is your last known status."
                    onRecheck={onRecheck}
                  />
                )}
          </>
        ) : sync.verified ? (
          // ahead 0 AND we actually reached GitHub — the one case we're allowed to show green.
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
            <span className="min-w-0 truncate" title={sync.remoteUrl ?? undefined}>
              On GitHub{destination ? ` · ${destination}` : ''}
            </span>
          </div>
        ) : (
          // ahead 0 but we couldn't reach GitHub. Never claim "on GitHub" on a guess — fail conservative.
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-muted/40" />
              <span className="min-w-0 truncate">Couldn't confirm with GitHub</span>
            </div>
            <UnconfirmedNote
              prefix="Offline or GitHub was unreachable, so this can't be verified right now."
              onRecheck={onRecheck}
            />
          </div>
        )}

        {sync.verified && sync.behind > 0 && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted/70">
            {sync.behind} newer {sync.behind === 1 ? 'version exists' : 'versions exist'} on GitHub
            that{sync.behind === 1 ? " isn't" : " aren't"} on this computer yet.
          </p>
        )}

        {failure && (
          <div className="mt-2 rounded-lg border border-[#b5862f]/40 bg-[#b5862f]/10 p-2.5">
            <p className="text-[11px] leading-relaxed text-[#7a5b14] dark:text-[#d8b765]">
              {failureCopy(failure.code)}
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void askClaude('fixPush')}
              disabled={!canAsk}
              title={
                !hasSession
                  ? 'Open a session first'
                  : anyBusy
                    ? 'Wait for the agent to finish first'
                    : undefined
              }
              className="mt-2"
            >
              Ask Claude to fix it
            </Button>
          </div>
        )}
      </div>
    </Section>
  )
}

// Shown whenever the sync state is a best-effort local guess (offline/auth). Keeps the promise honest
// — "here's what we last knew" + a one-click way to ask GitHub again — instead of a confident green.
function UnconfirmedNote({ prefix, onRecheck }: { prefix: string; onRecheck: () => void }) {
  return (
    <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted/70">
      {prefix}{' '}
      <button onClick={onRecheck} className="text-accent underline-offset-2 hover:underline">
        Check again
      </button>
    </p>
  )
}

function failureCopy(code: Extract<GitPushResult, { ok: false }>['code']): string {
  switch (code) {
    case 'push_auth':
      return "GitHub didn't accept this computer's credentials, so the push couldn't go through."
    case 'push_rejected':
      return "GitHub has versions this computer doesn't — they need to be combined before pushing."
    case 'no_remote':
      return "This project isn't connected to a GitHub repo yet."
    default:
      return "The push to GitHub didn't go through."
  }
}

/** "git@github.com:rb/koda.git" / "https://github.com/rb/koda.git" → "github.com/rb/koda". */
function shortRemote(url: string): string {
  return url
    .replace(/^[a-z+]+:\/\//i, '') // protocol
    .replace(/^[^@/]+@/, '') // user@
    .replace(/:/, '/') // scp-style host:path
    .replace(/\.git\/?$/, '')
}
