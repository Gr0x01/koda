import { useEffect, useRef, useState } from 'react'
import { useWorkspace } from '../workspace/store'
import { AnsweredQuestions, parseAnsweredResult, parseQuestions, type Answered } from './AnsweredQuestions'

/**
 * The engine's AskUserQuestion tool, rendered Cursor-style: numbered options, one question at a time
 * with a pager, and a Skip / Continue action row. The tool is answered THROUGH the permission gate:
 * its pending approval is resolved with the user's picks as the tool's `answers` input (question text
 * → chosen label, multi-select joined), which the engine reads to produce the result. Skip is
 * PER-QUESTION — a skipped question is omitted from `answers`, so the engine records it as "(no option
 * selected)" and uses its judgment. Once answered, the card locks to the read-only AnsweredQuestions
 * summary — driven off the persisted result too, so it survives a re-render/reload, not just local state.
 */
export function QuestionCard({
  toolUseId,
  input,
  result,
  isError,
}: {
  toolUseId: string
  input: unknown
  result?: string
  isError?: boolean
}) {
  const answerQuestion = useWorkspace((s) => s.answerQuestion)
  const dismissQuestion = useWorkspace((s) => s.dismissQuestion)
  const questions = parseQuestions(input)
  const [sel, setSel] = useState<string[][]>(() => questions.map(() => []))
  const [skipped, setSkipped] = useState<boolean[]>(() => questions.map(() => false))
  const [current, setCurrent] = useState(0)
  const [submitted, setSubmitted] = useState(false)
  const [replied, setReplied] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  // Answered state persisted in the tool result survives a re-render/reload where local state is gone;
  // local `submitted`/`replied` cover the gap between the click and the result arriving from the engine.
  const persisted = parseAnsweredResult(questions, result, isError)
  const isReplied = replied || persisted?.replied === true
  const isAnswered = submitted || !!persisted

  // Take focus when the card appears so keyboard picks work without a click first. preventScroll: the
  // default focus() scrolls the card into view, which on a session switch overrides the tail-snap and
  // strands the reader on the question instead of the newest message.
  useEffect(() => {
    if (!isAnswered) cardRef.current?.focus({ preventScroll: true })
  }, [isAnswered])

  if (questions.length === 0) return null

  const q = questions[current]
  const curSel = sel[current]
  const multi = !!q.multiSelect
  const isLast = current === questions.length - 1

  function send(finalSel: string[][]): void {
    if (submitted) return
    // Chosen label(s) keyed by question text (multi-select comma-joined); skipped questions omitted.
    // Resolved as the tool's `answers` input via the broker — the engine reads it to build the result.
    const answers: Record<string, string> = {}
    questions.forEach((qq, i) => {
      if (finalSel[i].length > 0) answers[qq.question] = finalSel[i].join(', ')
    })
    answerQuestion(toolUseId, { ...(input as Record<string, unknown>), answers })
    setSubmitted(true)
  }

  // Picking an option clears any skip on this question (you've now decided it).
  function choose(label: string): void {
    if (submitted) return
    if (skipped[current]) setSkipped((p) => p.map((s, i) => (i === current ? false : s)))
    if (multi) setForCurrent(curSel.includes(label) ? curSel.filter((l) => l !== label) : [...curSel, label])
    else setForCurrent(curSel.includes(label) ? [] : [label])
  }

  function setForCurrent(labels: string[]): void {
    setSel((prev) => prev.map((a, i) => (i === current ? labels : a)))
  }

  // Continue commits this question's selection; on the last it submits everything.
  function cont(): void {
    if (submitted || curSel.length === 0) return
    if (isLast) send(sel)
    else setCurrent(current + 1)
  }

  // "Reply instead": bail out of picking and answer in your own words. Deny the whole tool (the engine
  // stops and waits) and drop the cursor into the composer. Covers the "I don't like these / let me
  // clarify / take one and expand it" cases the fixed options can't.
  function replyInstead(): void {
    if (submitted) return
    dismissQuestion(toolUseId)
    setReplied(true)
    setSubmitted(true)
    window.dispatchEvent(new CustomEvent('koda:focus-composer'))
  }

  // Skip THIS question (clear any selection, mark skipped); advance, or submit if it's the last.
  function skip(): void {
    if (submitted) return
    const nextSel = sel.map((a, i) => (i === current ? [] : a))
    setSel(nextSel)
    setSkipped((p) => p.map((s, i) => (i === current ? true : s)))
    if (isLast) send(nextSel)
    else setCurrent(current + 1)
  }

  // Keyboard: number keys pick an option, Enter continues/submits. We handle Enter here (and
  // preventDefault) so a focused option button doesn't re-fire its own click and toggle itself off
  // — the bug where "select an option, hit Enter" did nothing.
  function onKeyDown(e: React.KeyboardEvent): void {
    if (submitted) return
    if (e.key === 'Enter') {
      e.preventDefault()
      cont()
      return
    }
    const n = Number(e.key)
    if (Number.isInteger(n) && n >= 1 && n <= q.options.length) {
      e.preventDefault()
      choose(q.options[n - 1].label)
    }
  }

  if (isReplied) return <AnsweredQuestions questions={questions} answered={{ replied: true }} />

  if (isAnswered) {
    // Prefer the live local picks (accurate the instant you submit, before the result echoes back);
    // fall back to the answers parsed from the persisted result on a fresh render/reload. (isReplied
    // returned above, so persisted here is never a reply.)
    const answered: Answered = submitted
      ? {
          replied: false,
          answers: Object.fromEntries(
            questions.flatMap((qq, i) => (sel[i].length > 0 ? [[qq.question, sel[i].join(', ')]] : [])),
          ),
        }
      : (persisted ?? { replied: false, answers: {} })
    return <AnsweredQuestions questions={questions} answered={answered} />
  }

  const multiQ = questions.length > 1
  const decided = curSel.length > 0 || skipped[current]

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="my-1 rounded-2xl border border-accent/40 bg-surface px-5 py-4 shadow-soft outline-none"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-text-muted">
          Questions
          {multiQ && <span className="ml-2 normal-case text-text-muted/70">{current + 1} of {questions.length}</span>}
        </span>
        <span className="flex items-center gap-1">
          <PagerBtn dir="prev" disabled={current === 0} onClick={() => setCurrent(current - 1)} />
          <PagerBtn dir="next" disabled={isLast || !decided} onClick={() => setCurrent(current + 1)} />
        </span>
      </div>

      <div className="mb-3 text-sm font-medium text-text">{q.question}</div>

      <div className="flex flex-col gap-1.5">
        {q.options.map((o, i) => {
          const picked = curSel.includes(o.label)
          return (
            <button
              key={o.label}
              onClick={() => choose(o.label)}
              className={`flex items-start gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                picked ? 'border-accent bg-accent/10' : 'border-border hover:border-accent'
              }`}
            >
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] font-medium ${
                  picked ? 'border-accent bg-accent text-white' : 'border-border text-text-muted'
                }`}
              >
                {i + 1}
              </span>
              <span className="text-text">
                <span className="font-medium">{o.label}</span>
                {o.description && <span className="text-text-muted"> — {o.description}</span>}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={replyInstead}
          className="mr-auto rounded-xl px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:text-text"
        >
          Reply instead
        </button>
        {multi && <span className="text-[11px] text-text-muted">Pick one or more</span>}
        <button
          onClick={skip}
          className="rounded-xl px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:text-text"
        >
          Skip
        </button>
        <button
          onClick={cont}
          disabled={curSel.length === 0}
          className="rounded-xl bg-accent px-4 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {isLast ? 'Submit' : 'Continue'}
        </button>
      </div>
    </div>
  )
}

function PagerBtn({ dir, disabled, onClick }: { dir: 'prev' | 'next'; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === 'prev' ? 'Previous question' : 'Next question'}
      className="flex h-6 w-6 items-center justify-center rounded-md border border-border text-text-muted transition-colors hover:text-text disabled:opacity-30"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {dir === 'prev' ? <path d="M15 18l-6-6 6-6" /> : <path d="M9 18l6-6-6-6" />}
      </svg>
    </button>
  )
}
