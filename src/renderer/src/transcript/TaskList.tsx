/**
 * The agent's task list (todo checklist). In engine 2.1.185 the legacy TodoWrite is
 * replaced by the Task family — TaskCreate `{subject}` → "Task #N created", TaskUpdate
 * `{taskId, status}` (spike/capture). We fold those tool calls into one evolving panel
 * per session instead of raw tool cards: for a non-coder, watching steps tick off is the
 * clearest "it's on track" signal. NB: distinct from the subagent `system/task_*`
 * lifecycle (SubagentCard) despite the shared "task" name.
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | string
export type TaskRow = { id: string; subject: string; status: TaskStatus }

function glyph(status: TaskStatus) {
  if (status === 'completed') return <span className="text-emerald-500">✓</span>
  if (status === 'in_progress') return <span className="animate-pulse text-accent">◐</span>
  return <span className="text-text-muted">○</span>
}

export function TaskList({ tasks }: { tasks: TaskRow[] }) {
  const done = tasks.filter((t) => t.status === 'completed').length
  return (
    <div className="rounded-2xl border border-border bg-surface px-4 py-3 shadow-soft">
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-text-muted">
        <span>Task list</span>
        <span className="font-mono">
          {done}/{tasks.length} done
        </span>
      </div>
      <ul className="space-y-1">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 w-3.5 shrink-0 text-center">{glyph(t.status)}</span>
            <span
              className={
                t.status === 'completed'
                  ? 'text-text-muted line-through'
                  : t.status === 'in_progress'
                    ? 'font-medium text-text'
                    : 'text-text-muted'
              }
            >
              {t.subject || `Task #${t.id}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
