---
name: goal
description: Carry an explicitly stated objective through concrete work until it is verifiably complete or genuinely blocked. Use when the user invokes Goal, asks for a goal loop, says to keep going until an outcome is reached, or wants a long task pursued instead of ending after a plan or progress update.
---

# Goal

Treat the user's requested outcome as the terminal condition. A plan, partial implementation, or
progress report is not completion.

1. State the objective in one concrete sentence. Infer it from the request when possible; ask only
   when different interpretations would materially change the work.
2. Use `get_goal`, `create_goal`, and `update_goal` when the engine provides them. Read the current
   goal first; continue it when it matches, create one when none exists, and never overwrite a different
   active goal. Set a token budget only when the user supplied one.
3. Keep making useful progress. Maintain a short plan when the work benefits from one, revise it as
   evidence changes, and continue through intermediate milestones without handing the task back.
4. When the goal spans milestones or could outlive the current context, keep a ledger at
   `.koda/progress/<goal-slug>.md`. Its first line states the objective; append one line per milestone
   only once it is proven, never on intention. Start each goal turn by reading the ledger and trust it
   over recollection; a ledger whose first line states a different objective is not yours to continue.
   Delete the ledger when the goal completes.
5. Prove the requested outcome with the strongest practical verification available.
6. Mark a native goal complete only after the outcome and its verification are satisfied. Mark it
   blocked only when the same concrete blocker has prevented progress for three consecutive goal turns
   and no safe in-scope workaround remains.

If native goal tools are absent, follow the same contract within the current turn. Never claim
cross-turn persistence the engine does not provide, and do not build a scheduler, database, or Goal UI
to compensate unless the user explicitly asks for that product work.
