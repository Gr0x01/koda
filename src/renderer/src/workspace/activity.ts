import { runningDelegationCount } from '@shared/delegation'
import type { Entry } from '../transcript/types'

const TOOL_VERB: Record<string, string> = {
  Read: 'Reading files',
  Glob: 'Finding files',
  Grep: 'Searching the code',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Write: 'Writing a file',
  NotebookEdit: 'Editing',
  Bash: 'Running a command',
  Task: 'Delegating to an agent',
  Agent: 'Delegating to an agent',
  Workflow: 'Orchestrating agents',
  WebSearch: 'Researching online',
  WebFetch: 'Reading a page',
  TodoWrite: 'Planning',
  TaskCreate: 'Planning',
  TaskUpdate: 'Planning',
}

export function humanizeTool(name: string): string {
  return TOOL_VERB[name] ?? `Running ${name}`
}

/**
 * What a BUSY session is doing right now, as a human one-liner: the most recent tool that hasn't
 * returned yet (what's running), else writing vs thinking. Derived from the turn lifecycle + the
 * in-flight tool — NOT the engine's reasoning stream — so it's always populated even for an engine
 * (Codex on a ChatGPT sub) that barely emits reasoning deltas. Shared by the sidebar row and the
 * conversation's trailing indicator so the two never disagree. Caller guarantees the session is
 * working, which includes a delegated task still running after its parent turn ended.
 */
export function busyActivity(s: { items: readonly Entry[]; streaming: string }): string {
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i]
    if (it.kind === 'tool') {
      if (it.result === undefined) return humanizeTool(it.name)
      break
    }
  }
  if (s.streaming) return 'Writing…'
  // A backgrounded delegate outlives the turn that spawned it, so once the parent turn is done and
  // only the fan-out is left, "Thinking…" would name the wrong worker.
  const delegated = runningDelegationCount(s.items)
  if (delegated > 0) return delegated === 1 ? 'Agent still working…' : `${delegated} agents still working…`
  return 'Thinking…'
}
