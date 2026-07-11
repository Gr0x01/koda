/**
 * A background workflow (multi-agent orchestration via the Workflow tool). Under `-p` the workflow
 * launches in the background and never streams its result back (spike/capture) — Koda watches its
 * on-disk journal and surfaces progress here instead of dead-ending the user with a bare "launched…"
 * notice. Each agent shows running → its returned result; the card resolves when the journal goes
 * quiet (and raises a cross-session notification). Distinct from a subagent: a workflow is a
 * detached fleet Koda monitors by file, not an inline part of the turn.
 */
export type WorkflowAgentRow = { agentId: string; status: 'running' | 'done'; result?: string }

export type WorkflowItemData = {
  runId: string
  name: string
  status: 'running' | 'completed'
  agents: WorkflowAgentRow[]
}

export function WorkflowCard({ item }: { item: WorkflowItemData }) {
  const done = item.agents.filter((a) => a.status === 'done').length
  return (
    <div className="rounded-2xl border border-accent/30 bg-surface px-5 py-4 shadow-soft">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-accent">⛓</span>
          <span className="font-display font-medium text-text">{item.name}</span>
        </div>
        <span className="text-[11px] uppercase tracking-wider text-text-muted">
          {item.status === 'running' ? (
            <span className="text-accent">running…</span>
          ) : (
            <span className="text-emerald-500">done</span>
          )}
          {item.agents.length > 0 && (
            <span className="ml-2 font-mono">
              {done}/{item.agents.length}
            </span>
          )}
        </span>
      </div>

      {item.status === 'running' && (
        <p className="mt-1 text-[11px] text-text-muted">
          Runs in the background. Koda is watching its progress, you don't need to wait here.
        </p>
      )}

      {item.agents.length > 0 && (
        <ul className="mt-3 space-y-2">
          {item.agents.map((a, i) => (
            <li key={a.agentId} className="text-sm">
              <div className="flex items-center gap-2">
                <span className={a.status === 'done' ? 'text-emerald-500' : 'animate-pulse text-accent'}>
                  {a.status === 'done' ? '✓' : '◐'}
                </span>
                <span className="text-text-muted">Agent {i + 1}</span>
              </div>
              {a.result && (
                <p className="ml-6 mt-0.5 whitespace-pre-wrap break-words text-[13px] text-text">{a.result}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
