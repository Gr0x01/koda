import { useEffect, useRef, useState } from 'react'
import {
  askRefusedEngine,
  type EngineId,
  type LibraryAskRequest,
  type LibraryAskResult,
  type LibraryCitation,
  type LibrarySessionCitation,
} from '@shared/ipc'
import { PixelGlyph } from '../../ui/PixelGlyph'
import { useWorkspace } from '../store'
import { doorFromLabels, followRefusalCopy, followSession } from '../session-href'
import { askRefusalCopy } from './library-format'

/**
 * **Ask Koda** — the Library's second door. Search assumes the reader already knows the document
 * exists and roughly what it is called; asking does not, and the answer to most questions lives in a
 * conversation that was never turned into a document at all.
 *
 * Both kinds of citation are doors. A document citation opens the source; a *session* citation lands
 * the reader back in the conversation, which is the one thing no other
 * document tool can offer, because no other tool was in the room.
 *
 * A session citation outlives the chat it names, so it resolves through `session-href.ts` before it is
 * drawn: live and archived are buttons, and a deleted chat renders as text rather than as a control
 * that can only fail. `LibrarySessionCitation.label` is the name as of ANSWER time and is stale by
 * design — the current name comes from the door, and the stored one is used only for a chat that no
 * longer has a current name to read.
 */

type AskFn = (req: LibraryAskRequest, isCurrent?: () => boolean) => Promise<LibraryAskResult>

/**
 * `refused` is the state that must not collapse into `failed`. The ask runs on the engine of the chat
 * it was launched from, so a refusal is permanent for this chat's engine and nothing ran; the retry
 * `failed` invites is a retry of something that can never work. It carries the engine because the
 * sentence names it, and it names the one the reader is sitting in.
 */
type AskState =
  | { phase: 'idle' }
  | { phase: 'asking' }
  | { phase: 'answered'; result: LibraryAskResult }
  | { phase: 'unavailable' }
  | { phase: 'refused'; engine: EngineId }
  | { phase: 'owner-gone' }
  | { phase: 'failed' }

export const askWithFreshHotStore: AskFn = async (req, isCurrent = () => true) => {
  const workspace = useWorkspace.getState()
  // Ask reads the hot-session file in main. The normal 500ms debounce is allowed to lag the screen, so
  // take an acknowledged snapshot first — but only while every chat is idle. A streaming transcript is
  // knowingly incomplete and must travel without a freshness stamp, which makes the result say partial.
  const idle = Object.values(workspace.sessions).every((session) => !session.busy && !session.streaming)
  let hotStoreSavedAt: number | undefined
  if (idle && workspace.hydrated) {
    // Stamp BEFORE capturing/writing. Any engine event from this instant onward may be absent from the
    // blob, including a whole background turn that begins and ends while the large file is written.
    const snapshotStartedAt = Date.now()
    const blob = workspace.persistBlob()
    try {
      if (await window.koda.saveSessions(blob)) hotStoreSavedAt = snapshotStartedAt
    } catch {
      // The ask may still use readable documents/chats, but main will mark the session corpus partial.
    }
  }
  // Back/unmount/owner loss may have happened while the large hot store was being written. The main
  // cancellation controller does not exist until the invoke below, so the component generation is the
  // gate that prevents a hidden, billed ask from starting after its surface is gone.
  if (!isCurrent()) throw new DOMException('Library ask cancelled before launch', 'AbortError')
  return window.koda.libraryAsk({ ...req, hotStoreSavedAt })
}

/** Electron's own words when nothing has registered the channel — a build whose main process is
 *  missing the ask handler, which is a capability gap rather than a failed question. */
function isNotWired(error: unknown): boolean {
  return /no handler registered/i.test(error instanceof Error ? error.message : String(error))
}

export function LibraryAsk({
  initialQuestion = '',
  onBack,
  onOpenDoc,
  onFollowedSession,
  askingSessionId,
}: {
  initialQuestion?: string
  onBack: () => void
  onOpenDoc: (path: string, line?: number) => void
  /** A session citation was followed and the chat is now in front of the user, so the Library gets out
   *  of the way — the same handoff `onOpenDoc` makes for a document. */
  onFollowedSession?: () => void
  /** The chat in front when the Library opened. Null means there genuinely was no owner. */
  askingSessionId?: string | null
}) {
  const [question, setQuestion] = useState(initialQuestion)
  const [state, setState] = useState<AskState>({ phase: 'idle' })
  // A door that refused between being drawn and being clicked. Rare (the state is read before the
  // click) and never silent: a click that goes nowhere with no explanation is the failure this whole
  // ladder exists to prevent.
  const [refusal, setRefusal] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const reqId = useRef(0)
  const pendingRequestId = useRef<string | null>(null)

  useEffect(() => inputRef.current?.focus(), [])
  useEffect(
    () => () => {
      reqId.current += 1
      if (pendingRequestId.current) window.koda.cancelLibraryAsk(pendingRequestId.current)
      pendingRequestId.current = null
    },
    [],
  )
  useEffect(() => {
    if (!askingSessionId) return
    return useWorkspace.subscribe((workspace) => {
      if (workspace.sessions[askingSessionId] || !pendingRequestId.current) return
      reqId.current += 1
      window.koda.cancelLibraryAsk(pendingRequestId.current)
      pendingRequestId.current = null
      setState({ phase: 'owner-gone' })
    })
  }, [askingSessionId])

  function cancelPending(): void {
    reqId.current += 1
    if (pendingRequestId.current) window.koda.cancelLibraryAsk(pendingRequestId.current)
    pendingRequestId.current = null
  }

  async function run(): Promise<void> {
    const q = question.trim()
    if (!q || state.phase === 'asking') return
    if (askingSessionId && !useWorkspace.getState().sessions[askingSessionId]) {
      setState({ phase: 'owner-gone' })
      return
    }
    const id = ++reqId.current
    const requestId = crypto.randomUUID()
    pendingRequestId.current = requestId
    setState({ phase: 'asking' })
    setRefusal(null) // it belonged to the previous answer's chips
    try {
      const result = await askWithFreshHotStore(
        { question: q, sessionId: askingSessionId ?? undefined, requestId },
        () => id === reqId.current && pendingRequestId.current === requestId,
      )
      if (id !== reqId.current) return
      if (askingSessionId && !useWorkspace.getState().sessions[askingSessionId]) {
        setState({ phase: 'owner-gone' })
        return
      }
      if (result.question !== q) {
        setState({ phase: 'failed' })
        return
      }
      setState({ phase: 'answered', result })
    } catch (e) {
      if (id !== reqId.current) return
      const refusedEngine = askRefusedEngine(e)
      if (refusedEngine) setState({ phase: 'refused', engine: refusedEngine })
      else setState(isNotWired(e) ? { phase: 'unavailable' } : { phase: 'failed' })
    } finally {
      if (pendingRequestId.current === requestId) pendingRequestId.current = null
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 py-6">
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            cancelPending()
            onBack()
          }}
          className="-ml-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-surface hover:text-text"
        >
          ← Back to the library
        </button>
      </div>

      <h3 id="library-heading" className="mt-4 font-display text-[19px] leading-tight tracking-tight text-text">
        Ask about your work
      </h3>
      <p className="mt-1.5 max-w-lg text-[12px] leading-relaxed text-text-muted">
        Koda reads your documents and the conversations that produced them, then answers with the
        places it found. Ask it what you decided, not where you filed it.
      </p>

      <div className="mt-5 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 focus-within:border-accent/50">
        <input
          ref={inputRef}
          value={question}
          disabled={state.phase === 'asking'}
          onChange={(e) => {
            setQuestion(e.target.value)
            if (state.phase !== 'idle') setState({ phase: 'idle' })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void run()
            }
          }}
          placeholder="What did we decide about phone tiers?"
          aria-label="Ask about your documents and conversations"
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-text outline-none placeholder:text-text-muted/60"
        />
        <button
          onClick={() => void run()}
          disabled={!question.trim() || state.phase === 'asking'}
          className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Ask
        </button>
      </div>

      <div className="mt-5 min-h-0" role="status" aria-live="polite" aria-atomic="false">
        {state.phase === 'asking' && (
          <div className="flex items-center gap-2 text-[12px] text-text-muted">
            <PixelGlyph loader variant="snake" size={12} label="Looking" />
            Looking through your documents and conversations
          </div>
        )}

        {state.phase === 'unavailable' && (
          <p className="max-w-lg text-[12px] leading-relaxed text-text-muted">
            Asking is not switched on in this build yet. Search still finds anything by its title or by
            a phrase inside it.
          </p>
        )}

        {state.phase === 'refused' && (
          <p className="max-w-lg text-[12px] leading-relaxed text-text-muted">
            {askRefusalCopy(state.engine)}
          </p>
        )}

        {state.phase === 'failed' && (
          <p className="max-w-lg text-[12px] leading-relaxed text-text-muted">
            That question could not be answered just now. Try it again, or search for a phrase you
            remember.
          </p>
        )}

        {state.phase === 'owner-gone' && (
          <p className="max-w-lg text-[12px] leading-relaxed text-text-muted">
            That chat closed before Koda could answer, so the question did not move to another engine
            or account. Open the Library from the chat you want to ask from and try again.
          </p>
        )}

        {state.phase === 'answered' && (
          <Answer
            result={state.result}
            onOpenDoc={onOpenDoc}
            onFollowedSession={onFollowedSession}
            refusal={refusal}
            onRefusal={setRefusal}
          />
        )}
      </div>
    </div>
  )
}

function Answer({
  result,
  onOpenDoc,
  onFollowedSession,
  refusal,
  onRefusal,
}: {
  result: LibraryAskResult
  onOpenDoc: (path: string, line?: number) => void
  onFollowedSession?: () => void
  refusal: string | null
  onRefusal: (message: string) => void
}) {
  // An empty answer is a legitimate result and says so plainly. Padding it into a manufactured
  // summary is the failure, per the editorial bar in `Documents/Goal sessions.md`.
  if (!result.answer.trim()) {
    return (
      <p className="max-w-lg text-[12px] leading-relaxed text-text-muted">
        {result.truncated
          ? 'Koda did not find an answer in the portion it could read. There may be more to find; try a phrase you remember.'
          : 'Nothing in your documents or conversations answers that. Try naming a word you would have written down.'}
      </p>
    )
  }
  return (
    <div>
      <p className="max-w-2xl whitespace-pre-wrap text-[13.5px] leading-[1.62] text-text">{result.answer}</p>
      {result.citations.length > 0 && (
        <div className="mt-5">
          <h4 className="font-display text-[10px] font-semibold uppercase tracking-wider text-text-muted/80">
            Where this came from
          </h4>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {result.citations.map((c, i) => (
              <Citation
                key={i}
                citation={c}
                onOpenDoc={onOpenDoc}
                onFollowedSession={onFollowedSession}
                onRefusal={onRefusal}
              />
            ))}
          </div>
          {/* Mounted whether or not it has anything to say, and only its CONTENTS come and go: a screen
              reader announces text inserted into a region it already knows about and misses a region
              that appears with its message already inside it (same rule as StageLinks' refusal line). */}
          <p
            // The margin is conditional, not the element: an empty paragraph is zero-height but its
            // margin is not, and a permanent gap under the chips would be visible furniture.
            className={`max-w-lg text-[11.5px] leading-relaxed text-text-muted ${refusal ? 'mt-2' : ''}`}
          >
            {refusal}
          </p>
        </div>
      )}
      {result.truncated && (
        <p className="mt-4 text-[11px] text-text-muted/80">
          Koda stopped early, so there may be more to find.
        </p>
      )}
    </div>
  )
}

/** Shared chip box, so a document citation and a conversation citation sit in one row as one family
 *  and only their wording and their affordance differ. */
const CHIP = 'max-w-[22rem] truncate rounded-full border px-2.5 py-1 text-[11px]'
const CHIP_DOOR = `${CHIP} border-border bg-surface text-text transition-colors hover:border-accent/40 hover:text-accent`

function Citation({
  citation,
  onOpenDoc,
  onFollowedSession,
  onRefusal,
}: {
  citation: LibraryCitation
  onOpenDoc: (path: string, line?: number) => void
  onFollowedSession?: () => void
  onRefusal: (message: string) => void
}) {
  if (citation.kind === 'document') {
    return (
      <button
        onClick={() => onOpenDoc(citation.path)}
        title={citation.rel}
        className={CHIP_DOOR}
      >
        {citation.label}
      </button>
    )
  }
  return (
    <SessionCitation citation={citation} onFollowed={onFollowedSession} onRefusal={onRefusal} />
  )
}

/**
 * A conversation the answer rests on, as a door back into it.
 *
 * The two labels are selected as PRIMITIVES rather than as a resolved object: a citation list
 * subscribes per chip, and a selector returning a fresh object would re-render all of them on every
 * unrelated store write, including the ~500ms debounced session save that runs while a turn streams.
 */
function SessionCitation({
  citation,
  onFollowed,
  onRefusal,
}: {
  citation: LibrarySessionCitation
  onFollowed?: () => void
  onRefusal: (message: string) => void
}) {
  const liveLabel = useWorkspace((s) => s.sessions[citation.sessionId]?.label)
  const archivedLabel = useWorkspace((s) => s.archived.find((a) => a.id === citation.sessionId)?.label)
  const archiveLoadFailed = useWorkspace((s) => s.archiveLoadFailed)
  const door = doorFromLabels(liveLabel, archivedLabel, archiveLoadFailed)

  // Deleted, or purged by the retention window. Text rather than a control, for the same reason
  // provenance renders it that way: there is nowhere to go, and the stored label is the last name that
  // chat ever had, so it still tells the reader which conversation the answer leaned on.
  if (door.status === 'gone')
    return (
      <span
        title={followRefusalCopy('gone') ?? undefined}
        className={`${CHIP} border-border/60 text-text-muted`}
      >
        {citation.label}
        <span className="ml-1.5 text-text-muted/70">no longer here</span>
      </span>
    )

  if (door.status === 'unknown')
    return (
      <span title="Koda could not check archived chats." className={`${CHIP} border-border/60 text-text-muted`}>
        {citation.label}
        <span className="ml-1.5 text-text-muted/70">archive unavailable</span>
      </span>
    )

  const archived = door.status === 'archived'
  async function follow(): Promise<void> {
    const outcome = await followSession(citation.sessionId, useWorkspace.getState)
    const refused = followRefusalCopy(outcome)
    if (refused) onRefusal(refused)
    else onFollowed?.()
  }
  return (
    <button
      onClick={() => void follow()}
      title={
        archived
          ? 'Reopen this archived chat'
          : 'Open this conversation'
      }
      // The visible text leads the accessible name so voice control matches what it can see, then the
      // sentence says what following it does — a chat's name alone does not read as an action.
      aria-label={`${door.label}. ${archived ? 'Reopens this archived conversation.' : 'Opens this conversation.'}`}
      className={CHIP_DOOR}
    >
      {door.label}
      <span className="ml-1.5 text-text-muted/70">{archived ? 'archived conversation' : 'conversation'}</span>
    </button>
  )
}
