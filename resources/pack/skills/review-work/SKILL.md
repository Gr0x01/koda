---
name: review-work
description: Conduct a fresh, bounded review of finished work. Use when the user asks for a review, critique, second opinion, outside look, safety check, or architectural check, or when Koda's active finishing route explicitly directs you here before delivery. Do not self-activate merely because code changed; skip trivial, mechanical, uninspectable, or still-in-progress work.
user-invocable: false
---

# Review Work

Choose the one fresh pass that matches what the user will judge. The reviewer suggests; the parent verifies evidence, decides, fixes, and re-checks. Loading this playbook is not an instruction to find something wrong.

## User-visible artifact

For a materially changed artifact with an agreed bar, give a fresh `critic` specialist the real rendered artifact or document before delivery. A minor copy or layout correction does not earn a critic merely because it is visible. If no named critic is available, assign one fresh read-only subagent the critic role.

The critic should identify the single largest supported gap, with evidence from the artifact. The parent fixes it when it is in scope and verifies that repair directly. Do not send the artifact back for another critic pass unless the user explicitly asks. If there is no bar, nothing inspectable, or the change is minor, skip rather than inventing criteria.

## Code change

For a non-trivial code change, choose one review lane. Give the bounded diff to the `code-reviewer` specialist when correctness and safety are the main risk. When the change added or moved a feature-sized responsibility, storage model, lifecycle owner, or cross-layer flow, use `review-architecture` as the single pass instead; a multi-file diff alone is not enough. If named specialists are unavailable, invoke the matching engine playbook or assign one fresh read-only subagent the same role.

Findings must be evidenced bugs, security or data-loss risks, or cleanup that materially affects the requested change—not unanswered questions, style noise, or hypothetical scale work. Fix supported actionable findings and rerun the affected verification. This one pass is the task's whole fresh-review budget: do not add another review lane, rescore the repair, or schedule a second reviewer unless the user explicitly asks.

Deep Review is outside this playbook. Run it only when the user explicitly invokes that workflow; never create retrospective review debt for work already delivered without it.

Report a clean review plainly. Never invent findings to make the pass look useful.
