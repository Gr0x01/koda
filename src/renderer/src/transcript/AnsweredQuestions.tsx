/**
 * Shared, store-free pieces for the engine's AskUserQuestion tool, used by BOTH the desktop
 * QuestionCard and the phone transcript. The interactive picker lives per-platform (it's welded to each
 * one's approval flow); this is only the locked, read-only "here's what you picked" view + its parsing,
 * so an answered question keeps showing your selection instead of reverting to (desktop) or dropping
 * entirely (phone) the interactive card on a re-render or reload.
 */
export type Option = { label: string; description?: string }
export type Question = { question: string; header?: string; options: Option[]; multiSelect?: boolean }

export function parseQuestions(input: unknown): Question[] {
  const qs = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(qs)) return []
  return qs
    .map((q): Question | null => {
      if (!q || typeof q.question !== 'string' || !Array.isArray(q.options)) return null
      const options = q.options
        .map((o: unknown) =>
          o && typeof (o as Option).label === 'string'
            ? { label: (o as Option).label, description: (o as Option).description }
            : null,
        )
        .filter((o: Option | null): o is Option => o !== null)
      return { question: q.question, header: q.header, options, multiSelect: q.multiSelect === true }
    })
    .filter((q): q is Question => q !== null && q.options.length > 0)
}

export type Answered = { replied: true } | { replied: false; answers: Record<string, string> }

/**
 * The picks live in the permission response (updatedInput), which the transcript history does NOT
 * persist — the engine echoes them back into the tool RESULT instead, the only record that survives a
 * re-render/reload. Shape: `Your questions have been answered: "<question>"="<label>"[, <label>…] selected
 * …, "<question2>"="<label>". …`. A denied tool (Reply instead) comes back as an error result.
 *
 * We anchor on the KNOWN question texts and option labels (both from `input`) rather than trusting the
 * quote boundaries — a free-form question or a label can itself contain a `"`, which a blind regex would
 * split on and mis-read. TRIPWIRE: this parse depends on the engine's result phrasing above; if a future
 * engine bump changes it, an answered question quietly renders as "Skipped" — re-check this then.
 */
export function parseAnsweredResult(
  questions: Question[],
  result?: string,
  isError?: boolean,
): Answered | null {
  if (!result) return null
  if (isError) return { replied: true }
  const answers: Record<string, string> = {}
  for (const q of questions) {
    const marker = `"${q.question}"="`
    const at = result.indexOf(marker)
    if (at === -1) continue // question skipped (omitted from the answers) or shape drift
    // Peel this question's own option labels off the front of the value, comma-joined for multi-select.
    let seg = result.slice(at + marker.length)
    const chosen: string[] = []
    for (;;) {
      const opt = q.options.find((o) => seg.startsWith(`${o.label}"`) || seg.startsWith(`${o.label}, `))
      if (!opt) break
      chosen.push(opt.label)
      seg = seg.slice(opt.label.length)
      if (seg.startsWith(', ')) {
        seg = seg.slice(2)
        continue
      }
      break // hit the closing quote
    }
    if (chosen.length > 0) answers[q.question] = chosen.join(', ')
  }
  return { replied: false, answers }
}

export function AnsweredQuestions({ questions, answered }: { questions: Question[]; answered: Answered }) {
  if (answered.replied) {
    return (
      <div className="my-1 rounded-2xl border border-border bg-surface px-5 py-3 text-sm">
        <div className="mb-1 text-[11px] uppercase tracking-wider text-text-muted">Asked</div>
        {questions.map((qq, i) => (
          <div key={i} className="text-text-muted">
            {qq.question}
          </div>
        ))}
        <div className="mt-1.5 font-medium text-text">You replied in your own words instead.</div>
      </div>
    )
  }
  return (
    <div className="my-1 rounded-2xl border border-border bg-surface px-5 py-3 text-sm">
      <div className="mb-1 text-[11px] uppercase tracking-wider text-text-muted">Your answer</div>
      {questions.map((qq, i) => (
        <div key={i} className="text-text">
          <span className="text-text-muted">{qq.question} </span>
          <span className="font-medium">{answered.answers[qq.question] || 'Skipped'}</span>
        </div>
      ))}
    </div>
  )
}
